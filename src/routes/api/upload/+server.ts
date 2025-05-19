import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { writeFile } from 'fs/promises';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { safetySettings } from '$lib/index';

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) {
		yield chunk.text();
	}
}

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file');

	let tempFileHandle;
	let uploadResult;

	const fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);

	// Upload file
	try {
		tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });

		const arrayBuffer = await file.arrayBuffer();
		await writeFile(tempFileHandle.path, Buffer.from(arrayBuffer));
		uploadResult = await fileManager.uploadFile(tempFileHandle.path, {
			mimeType: file.type
		});
	} catch (error) {
		console.error(error);
		return new Response('Error uploading file', { status: 500 });
	} finally {
		if (tempFileHandle) {
			tempFileHandle.cleanup();
		}
	}

	console.log(uploadResult);

	// Generate transcript
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

	const model = genAI.getGenerativeModel({
		model: publicEnv.PUBLIC_GOOGLE_MODEL,
		safetySettings,
		generationConfig: { responseMimeType: 'application/json' }
	});

	// Check that the file has been processed
	let uploadedFile = await fileManager.getFile(uploadResult.file.name);

	while (uploadedFile.state === FileState.PROCESSING) {
		console.log('File is processing...');
		await new Promise((resolve) => setTimeout(resolve, 5000));
		uploadedFile = await fileManager.getFile(uploadResult.file.name);
	}

	if (uploadedFile.state === FileState.FAILED) {
		return new Response('Error processing file', { status: 500 });
	}

	const result = await model.generateContentStream([
		{
			fileData: {
				mimeType: file.type,
				fileUri: uploadResult.file.uri
			}
		},
		{
			text: `Generate a transcript for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Respond with the transcript in the form of this NDJSON-style schema:
			{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."}
			{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}`
		}
	]);

	return new Response(streamChunks(result.stream), {
		headers: {
			'Content-Type': 'text/plain',
			'Transfer-Encoding': 'chunked',
			'X-Content-Type-Options': 'nosniff'
		}
	});
}
