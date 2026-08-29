import type { RequestEvent } from '@sveltejs/kit';
import { GoogleGenAI, Type } from '@google/genai';
import { file as tempFile, type FileResult } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { parseFile } from 'music-metadata';
import { logUsage } from '$lib/server/db';
import { setTimeout as delay } from 'node:timers/promises';

const requests = new Map<string, { count: number; expires: number }>();
const RATE_LIMIT = 10;
const DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_MEDIA_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

function checkRateLimit(ip: string) {
	const now = Date.now();
	let record = requests.get(ip);

	if (!record || record.expires < now) {
		record = { count: 0, expires: now + DURATION };
		requests.set(ip, record);
	}

	if (record.count >= RATE_LIMIT) {
		return { allowed: false, record };
	}
	return { allowed: true, record };
}

// --- MOCK GENERATOR ---
async function* mockTranscriptGenerator(signal: AbortSignal) {
	const mockData = [
		{
			start: 1.0,
			speaker: 'Mock Speaker',
			text: 'This is a simulated transcript for local development.'
		},
		{
			start: 5.0,
			speaker: 'Mock Speaker',
			text: 'It allows you to test the UI, streaming, and database without hitting the Google API.'
		},
		{
			start: 10.0,
			speaker: 'Mock Speaker',
			text: 'This specific sentence helps test long text wrapping in the frontend component to ensure it looks good.'
		},
		{ start: 15.0, speaker: 'Mock Speaker', text: 'End of simulation.' }
	];

	const fullJson = JSON.stringify(mockData);

	// Simulate streaming behaviour by chopping the JSON string
	const chunkSize = 10;
	for (let i = 0; i < fullJson.length; i += chunkSize) {
		await delay(50, undefined, { signal }); // Artificial delay
		yield { text: fullJson.slice(i, i + chunkSize) };
	}
}
// ----------------------

async function* streamChunks(asyncGenerator: AsyncIterableIterator<{ text?: string }>) {
	for await (const chunk of asyncGenerator) {
		if (chunk.text) {
			yield chunk.text;
		}
	}
}

async function getMediaDuration(filePath: string): Promise<number> {
	const metadata = await parseFile(filePath);
	const duration = metadata.format.duration || 0;
	return Math.round(duration * 1000); // convert to milliseconds
}

async function generateTranscriptWithModel(
	ai: GoogleGenAI,
	modelName: string,
	fileUri: string,
	mimeType: string,
	language: string,
	timestamps: boolean,
	abortSignal: AbortSignal
) {
	const prompt = timestamps
		? `Generate a transcript in ${language} for this file. Group similar text together rather than timestamping every line.`
		: `Generate a transcript in ${language} for this file. Group similar text together by speaker.`;

	const properties: Record<string, object> = {
		speaker: {
			type: Type.STRING,
			description: 'Speaker identifier (e.g. "Speaker 1")'
		},
		text: {
			type: Type.STRING,
			description: 'Transcribed text for this segment'
		}
	};

	const required = ['speaker', 'text'];
	const propertyOrdering = ['speaker', 'text'];

	if (timestamps) {
		properties.start = {
			type: Type.NUMBER,
			description: 'Start time of this segment in seconds (e.g. 12.4)'
		};
		required.push('start');
		propertyOrdering.splice(1, 0, 'start');
	}

	const response = await ai.models.generateContentStream({
		model: modelName,
		contents: [
			{
				role: 'user',
				parts: [
					{
						fileData: {
							mimeType: mimeType,
							fileUri: fileUri
						}
					},
					{
						text: prompt
					}
				]
			}
		],
		config: {
			abortSignal,
			safetySettings,
			responseMimeType: 'application/json',
			responseJsonSchema: {
				type: Type.ARRAY,
				items: {
					type: Type.OBJECT,
					properties,
					required,
					propertyOrdering
				}
			}
		}
	});

	return response;
}

function extractClientIp(request: Request, event: RequestEvent): string {
	return (
		request.headers.get('fly-client-ip') ||
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		event.getClientAddress()
	);
}

export async function GET(event) {
	const ip = extractClientIp(event.request, event);
	const { allowed, record } = checkRateLimit(ip);

	if (!allowed) {
		return new Response(
			'This free service supports up to 10 requests per user per day. Please try again tomorrow.',
			{ status: 429 }
		);
	}

	return new Response(JSON.stringify({ remaining: RATE_LIMIT - (record?.count || 0) }), {
		status: 200
	});
}

export async function POST(event) {
	const { request, url } = event;
	const ip = extractClientIp(request, event);

	const origin = request.headers.get('origin');
	if (origin && new URL(origin).origin !== url.origin) {
		return new Response('Forbidden', { status: 403 });
	}

	const { allowed, record } = checkRateLimit(ip);
	if (!allowed) {
		return new Response(
			'This free service supports up to 10 requests per user per day. Please try again tomorrow.',
			{ status: 429 }
		);
	}

	if (record) {
		record.count++;
		requests.set(ip, record);
	}

	const contentType = request.headers.get('content-type');
	if (!contentType || !contentType.startsWith('multipart/form-data')) {
		record.count--;
		requests.set(ip, record);
		return new Response('Expected multipart/form-data', { status: 400 });
	}

	// Reject large uploads
	const contentLength = request.headers.get('content-length');
	const MAX_UPLOAD_BYTES = 256 * 1024 * 1024; // 256MB
	if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
		record.count--;
		requests.set(ip, record);
		return new Response('File too large', { status: 413 });
	}

	const fileSizeBytes = contentLength ? parseInt(contentLength) : 0;
	const nodeReadable = Readable.fromWeb(request.body as import('stream/web').ReadableStream);

	let language = 'English';
	let timestamps = false;
	let uploadedFilePath: string | null = null;
	let uploadedFileMime: string | undefined;
	let tempFileHandle: FileResult | undefined;

	const busboy = Busboy({
		headers: { 'content-type': contentType }
	});

	let fileUploadPromise: Promise<void> | null = null;

	const parsePromise = new Promise<void>((resolve, reject) => {
		busboy.on('field', (fieldname, value) => {
			if (fieldname === 'language') language = value || 'English';
			if (fieldname === 'timestamps') timestamps = value === 'true';
		});

		busboy.on('file', (fieldname, fileStream, info) => {
			if (fieldname !== 'file') {
				fileStream.resume();
				return;
			}
			fileUploadPromise = (async () => {
				try {
					tempFileHandle = await tempFile({
						postfix: info.filename.includes('.') ? `.${info.filename.split('.').pop()}` : ''
					});
					uploadedFilePath = tempFileHandle.path;
					uploadedFileMime = info.mimeType;
					await pipeline(fileStream, createWriteStream(tempFileHandle.path));
				} catch (err) {
					reject(err);
				}
			})();
		});

		busboy.on('error', (err) => reject(err));
		busboy.on('finish', async () => {
			if (fileUploadPromise) await fileUploadPromise;
			resolve();
		});
	});

	try {
		await Promise.all([parsePromise, pipeline(nodeReadable, busboy)]);
	} catch (err) {
		console.error('Error parsing multipart body:', err);
		record.count--;
		requests.set(ip, record);
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('Error uploading file', { status: 500 });
	}

	if (!uploadedFilePath || !uploadedFileMime) {
		record.count--;
		requests.set(ip, record);
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('No file uploaded', { status: 400 });
	}

	const abortController = new AbortController();
	const clientDisconnectedError = new Error('Response stream was cancelled by the client');
	let clientDisconnected = false;
	let streamClosed = false;

	const markClientDisconnected = () => {
		clientDisconnected = true;
		if (!abortController.signal.aborted) abortController.abort();
	};

	const isInvalidStreamState = (error: unknown) =>
		error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE';

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const throwIfDisconnected = () => {
				if (clientDisconnected || streamClosed) throw clientDisconnectedError;
			};
			const send = (value: Uint8Array) => {
				throwIfDisconnected();
				try {
					controller.enqueue(value);
				} catch (error) {
					if (isInvalidStreamState(error)) {
						markClientDisconnected();
						throw clientDisconnectedError;
					}
					throw error;
				}
			};
			const sendJson = (obj: Record<string, unknown>) => {
				send(encoder.encode(JSON.stringify(obj) + '\n'));
			};
			const sendText = (text: string) => {
				send(encoder.encode(text));
			};
			const closeStream = () => {
				if (clientDisconnected || streamClosed) return;
				streamClosed = true;
				try {
					controller.close();
				} catch (error) {
					if (isInvalidStreamState(error)) {
						markClientDisconnected();
						return;
					}
					throw error;
				}
			};

			const cleanupTempFile = () => {
				if (tempFileHandle) {
					try {
						tempFileHandle.cleanup();
					} catch {
						// ignore cleanup errors
					}
					tempFileHandle = undefined;
				}
			};

			const sendErrorAndClose = (msg: string) => {
				if (clientDisconnected || streamClosed) return;
				try {
					sendJson({ error: msg });
				} finally {
					closeStream();
				}
			};

			const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
			let durationMs = 0;
			let uploadResult;
			let successfulModel = '';

			try {
				if (env.MOCK_API === 'true') {
					sendJson({ status: 'Mock mode: Uploading securely...' });
					await delay(1000, undefined, { signal: abortController.signal });
					sendJson({ status: 'Mock mode: Processing media...' });
					await delay(1000, undefined, { signal: abortController.signal });
					sendJson({ status: 'Mock mode: Generating transcript...' });

					for await (const chunk of mockTranscriptGenerator(abortController.signal)) {
						if (chunk.text) sendText(chunk.text);
					}

					let usageId: number | undefined;
					try {
						usageId = Number(logUsage(fileSizeBytes, 'mock-model-v1', 15000));
					} catch {
						// Usage logging should not fail an otherwise successful transcription.
					}
					if (usageId !== undefined) sendJson({ usageId });

					closeStream();
					return;
				}

				sendJson({
					status: 'Uploading securely... (this can take a few minutes for larger files)'
				});

				try {
					durationMs = await getMediaDuration(uploadedFilePath!);
					if (durationMs > MAX_MEDIA_DURATION_MS) {
						const minutes = Math.round(durationMs / 60000);
						return sendErrorAndClose(
							`File is too long (${minutes} minutes). The model currently only supports up to 2 hours of audio per file.`
						);
					}
				} catch (durationError) {
					console.warn('Could not extract media duration:', durationError);
				}
				throwIfDisconnected();

				uploadResult = await ai.files.upload({
					file: uploadedFilePath!,
					config: { mimeType: uploadedFileMime, abortSignal: abortController.signal }
				});

				cleanupTempFile();

				sendJson({
					status: 'Processing media (this can take a few minutes for larger files)...'
				});

				let uploadedFile = await ai.files.get({
					name: uploadResult.name!,
					config: { abortSignal: abortController.signal }
				});
				let retries = 0;
				const maxRetries = 3;
				const initialRetryDelay = 1000;
				let secondsWaiting = 0;

				while (uploadedFile.state === 'PROCESSING') {
					await delay(5000, undefined, { signal: abortController.signal });
					secondsWaiting += 5;

					sendJson({ status: `Processing media... (${secondsWaiting}s elapsed)` });

					try {
						uploadedFile = await ai.files.get({
							name: uploadResult.name!,
							config: { abortSignal: abortController.signal }
						});
						retries = 0;
					} catch (error) {
						if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
							retries++;
							if (retries > maxRetries) {
								return sendErrorAndClose(
									'Transcription API is currently unavailable. Please try again later.'
								);
							}
							const retryDelay = initialRetryDelay * Math.pow(2, retries - 1);
							await delay(retryDelay, undefined, { signal: abortController.signal });
						} else {
							throw error;
						}
					}
				}

				if (uploadedFile.state === 'FAILED') {
					return sendErrorAndClose(
						"Unfortunately this file couldn't be processed. The file may be corrupt or in an unsupported format."
					);
				}

				sendJson({ status: 'Transcribing audio... this could take a while!' });

				const models = [
					'gemini-3.6-flash',
					'gemini-3.5-flash',
					'gemini-3.5-flash-lite',
					'gemini-3-flash-preview',
					'gemini-2.5-flash',
					'gemini-3.1-flash-lite',
					'gemini-2.5-flash-lite'
				];

				let result = null;
				let lastError = null;

				for (const model of models) {
					try {
						console.log(`Attempting transcription with ${model}`);
						result = await generateTranscriptWithModel(
							ai,
							model,
							uploadedFile.uri!,
							uploadedFileMime!,
							language,
							timestamps,
							abortController.signal
						);
						successfulModel = model;
						break;
					} catch (error) {
						lastError = error;
						if (
							error instanceof Error &&
							(error.message.includes('429') ||
								error.message.includes('rate limit') ||
								error.message.includes('503'))
						) {
							console.warn(`Model ${model} unavailable or rate limited, trying next...`);
						} else {
							throw error;
						}
					}
				}

				if (!result) throw lastError || new Error('All transcription models failed');

				for await (const text of streamChunks(result)) {
					if (text) sendText(text);
				}

				let usageId: number | undefined;
				try {
					usageId = Number(logUsage(fileSizeBytes, successfulModel, durationMs));
				} catch (dbError) {
					console.error('Error logging usage to database:', dbError);
				}
				if (usageId !== undefined) sendJson({ usageId });

				closeStream();
			} catch (err) {
				if (!clientDisconnected && err !== clientDisconnectedError) {
					console.error('Error during streaming:', err);
					try {
						sendErrorAndClose(
							'Sorry, something went wrong generating the transcript. Please try again later.'
						);
					} catch (sendError) {
						if (!clientDisconnected) console.error('Could not send streaming error:', sendError);
					}
				}
			} finally {
				cleanupTempFile();
				if (uploadResult?.name) {
					try {
						await ai.files.delete({ name: uploadResult.name });
					} catch {
						// The remote file may already be gone or cleanup may temporarily fail.
					}
				}
			}
		},
		cancel() {
			markClientDisconnected();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/plain',
			'Transfer-Encoding': 'chunked',
			'X-Content-Type-Options': 'nosniff'
		}
	});
}
