import type { RequestEvent } from '@sveltejs/kit';
import { GoogleGenAI } from '@google/genai';
import { file as tempFile, type FileResult } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { parseFile } from 'music-metadata';
import { logUsage } from '$lib/server/db';

const requests = new Map<string, { count: number; expires: number }>();
const RATE_LIMIT = 5;
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
async function* mockTranscriptGenerator() {
	const mockData = [
		{
			timestamp: '00:01',
			speaker: 'Mock Speaker',
			text: 'This is a simulated transcript for local development.'
		},
		{
			timestamp: '00:05',
			speaker: 'Mock Speaker',
			text: 'It allows you to test the UI, streaming, and database without hitting the Google API.'
		},
		{
			timestamp: '00:10',
			speaker: 'Mock Speaker',
			text: 'This specific sentence helps test long text wrapping in the frontend component to ensure it looks good.'
		},
		{ timestamp: '00:15', speaker: 'Mock Speaker', text: 'End of simulation.' }
	];

	const fullJson = JSON.stringify(mockData);

	// Simulate streaming behaviour by chopping the JSON string
	const chunkSize = 10;
	for (let i = 0; i < fullJson.length; i += chunkSize) {
		await new Promise((resolve) => setTimeout(resolve, 50)); // Artificial delay
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
	language: string
) {
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
						text: `Generate a transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Respond with the transcript in the form of this JSON schema:
 [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}]`
					}
				]
			}
		],
		config: {
			safetySettings,
			responseMimeType: 'application/json'
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
		return new Response('Rate limit exceeded', { status: 429 });
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
			'This free service supports up to 5 requests per user per day. Please try again tomorrow.',
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

	// Convert Web ReadableStream to Node Readable
	const nodeReadable = Readable.fromWeb(request.body as import('stream/web').ReadableStream);

	let language = 'English';
	let uploadedFilePath: string | null = null;
	let uploadedFileMime: string | undefined;
	let tempFileHandle: FileResult | undefined;
	let durationMs = 0;

	const busboy = Busboy({
		headers: {
			'content-type': contentType
		}
	});

	let fileUploadPromise: Promise<void> | null = null;

	const parsePromise = new Promise<void>((resolve, reject) => {
		busboy.on('field', (fieldname, value) => {
			if (fieldname === 'language') {
				language = value || 'English';
			}
		});

		busboy.on('file', (fieldname, fileStream, info) => {
			// Only handle the 'file' field
			if (fieldname !== 'file') {
				fileStream.resume(); // discard any other file fields
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
			// Wait for file upload to complete before resolving
			if (fileUploadPromise) {
				await fileUploadPromise;
			}
			resolve();
		});
	});

	nodeReadable.pipe(busboy);

	try {
		await parsePromise;
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

	const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });

	let uploadResult;
	let result: AsyncIterableIterator<{ text?: string }> | null = null;
	let successfulModel = '';

	if (env.MOCK_API === 'true') {
		console.log('--- MOCK MODE: Skipping Google API ---');

		// Simulate a small delay for "uploading"
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Use the mock generator
		result = mockTranscriptGenerator();
		successfulModel = 'mock-model-v1';
		durationMs = 15000; // Mock duration: 15 seconds

		// Cleanup temp file immediately since we aren't sending it
		if (tempFileHandle) tempFileHandle.cleanup();
	} else {
		// --- REAL API MODE ---
		try {
			try {
				durationMs = await getMediaDuration(uploadedFilePath);

				// Check if duration exceeds the limit
				if (durationMs > MAX_MEDIA_DURATION_MS) {
					const minutes = Math.round(durationMs / 60000);
					return new Response(
						`File is too long (${minutes} minutes). The model currently only supports up to 2 hours of audio per file.`,
						{ status: 400 }
					);
				}
			} catch (durationError) {
				console.warn('Could not extract media duration:', durationError);
				// Continue without duration - not critical
			}

			uploadResult = await ai.files.upload({
				file: uploadedFilePath,
				config: {
					mimeType: uploadedFileMime
				}
			});
		} catch (error) {
			console.error(error);
			return new Response('Error uploading file', { status: 500 });
		} finally {
			if (tempFileHandle) {
				tempFileHandle.cleanup();
			}
		}

		try {
			// Poll until the file is processed
			let uploadedFile = await ai.files.get({ name: uploadResult.name! });

			let retries = 0;
			const maxRetries = 3;
			const initialRetryDelay = 1000;

			while (uploadedFile.state === 'PROCESSING') {
				console.log('File is processing... waiting 5 seconds before next poll.');
				await new Promise((resolve) => setTimeout(resolve, 5000));

				try {
					uploadedFile = await ai.files.get({ name: uploadResult.name! });
					retries = 0;
				} catch (error) {
					if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
						retries++;
						if (retries > maxRetries) {
							console.error(`Transcription API failed after ${maxRetries} retries.`, error);
							throw new Error(
								'Transcription API is currently unavailable. Please try again later.'
							);
						}

						const delay = initialRetryDelay * Math.pow(2, retries - 1);
						console.warn(
							`Transcription API error during polling, retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`
						);
						await new Promise((resolve) => setTimeout(resolve, delay));
						continue;
					} else {
						console.error('Unhandled error during file polling:', error);
						throw error;
					}
				}
			}

			if (uploadedFile.state === 'FAILED') {
				console.error('File processing failed for:', uploadedFile);
				return new Response(
					"Unfortunately this file couldn't be processed. The file may be corrupt or in an unsupported format.",
					{ status: 500 }
				);
			}

			if (!uploadedFile.uri) {
				console.error('Uploaded file URI is undefined');
				return new Response('File upload incomplete, URI not available', { status: 500 });
			}

			const models = [
				'gemini-3-flash-preview',
				'gemini-2.5-flash',
				'gemini-2.5-flash-lite-preview-09-2025'
			];

			let lastError: Error | null = null;

			for (const model of models) {
				try {
					console.log(`Attempting transcription with ${model}`);
					result = await generateTranscriptWithModel(
						ai,
						model,
						uploadedFile.uri,
						uploadedFileMime,
						language
					);
					successfulModel = model;
					break;
				} catch (error) {
					lastError = error as Error;
					if (
						error instanceof Error &&
						(error.message.includes('429') ||
							error.message.includes('rate limit') ||
							error.message.includes('503'))
					) {
						console.warn(`Model ${model} unavailable or rate limited, trying next model...`);
					} else {
						throw error; // Non-rate-limit error, don't retry
					}
				}
			}

			if (!result) {
				throw lastError || new Error('All transcription models failed');
			}
		} catch (error) {
			console.error('Error during transcription process:', error);
			return new Response(
				'Sorry, something went wrong generating the transcript. Please try again later.',
				{ status: 500 }
			);
		}
	}

	if (!result) {
		return new Response('Error generating transcript', { status: 500 });
	}

	let usageId: number | bigint = 0;

	// Log usage to the database
	try {
		usageId = logUsage(fileSizeBytes, successfulModel, durationMs);
	} catch (dbError) {
		console.error('Error logging usage to database:', dbError);
		// Proceed without failing the request
	}

	// Delete the file from Google (only if we uploaded it)
	if (env.MOCK_API !== 'true' && uploadResult && uploadResult.name) {
		try {
			await ai.files.delete({ name: uploadResult.name });
		} catch (error) {
			console.error('Error deleting uploaded file:', error);
			// Don't throw - still return the transcription even if deletion fails
		}
	}

	const nodeStream = Readable.from(streamChunks(result));
	const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

	return new Response(webStream, {
		headers: {
			'Content-Type': 'text/plain',
			'Transfer-Encoding': 'chunked',
			'X-Content-Type-Options': 'nosniff',
			'X-Usage-Id': usageId.toString()
		}
	});
}
