<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { env } from '$env/dynamic/public';

	const modelName = env.PUBLIC_GOOGLE_MODEL;
	let selectedFile: File | null = null;
	let uploadComplete = false;
	let isUploading = false;
	let fileUrl: string | null = null;
	let fileType: 'audio' | 'video';

	let streamBuffer = '';
	let transcriptArray: Array<{ timestamp: string; speaker: string; text: string }> = [];

	let audioElement: HTMLAudioElement | null = null;
	let videoElement: HTMLVideoElement | null = null;
	let scrollAnchor: HTMLDivElement | null = null;

	$: if (transcriptArray.length > 0 && scrollAnchor) {
		scrollAnchor.scrollIntoView({ behavior: 'smooth', block: 'end' });
	}

	function handleTimestampClick(timestamp: string) {
		const [minutes, seconds] = timestamp.split(':').map(Number);
		const timeInSeconds = minutes * 60 + seconds;

		if (audioElement) {
			audioElement.currentTime = timeInSeconds;
			audioElement.play();
		}

		if (videoElement) {
			videoElement.currentTime = timeInSeconds;
			videoElement.play();
		}
	}

	function handleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			fileUrl = URL.createObjectURL(selectedFile);
			fileType = selectedFile.type.includes('audio') ? 'audio' : 'video';
		}
	}

	function decodeStreamBufferToJson(
		input: string
	): Array<{ timestamp: string; speaker: string; text: string }> {
		const jsonLinePattern = /{[^}]*}/g;

		const matches = input.match(jsonLinePattern);

		if (!matches) {
			console.error('No valid JSON lines found');
		} else {
			const parsed = matches
				.map((line) => {
					// Optional regex field extraction (if needed individually)
					const fieldPattern = /"(\w+)":\s*"([^"]*)"/g;
					const result: Record<string, string> = {};
					let m;
					while ((m = fieldPattern.exec(line)) !== null) {
						const key = m[1];
						const value = m[2];
						result[key] = value;
					}
					return {
						timestamp: result.timestamp,
						speaker: result.speaker,
						text: result.text
					};
				})
				.filter((entry) => entry.timestamp && entry.speaker && entry.text);

			return parsed;
		}
	}

	async function handleSubmit() {
		if (!selectedFile) return;

		// Only allow files that are less than 1 hour in length
		const tempMediaElement = document.createElement(fileType === 'audio' ? 'audio' : 'video');
		tempMediaElement.src = fileUrl;

		const duration = await new Promise((resolve, reject) => {
			tempMediaElement.onloadedmetadata = () => resolve(tempMediaElement.duration);
			tempMediaElement.onerror = reject;
		});

		if (duration >= 3600) {
			alert('This file is too long. Please select a file that is less than 1 hour in length.');
			return;
		}

		isUploading = true;

		const formData = new FormData();
		formData.append('file', selectedFile);

		const response = await fetch('/api/upload', {
			method: 'POST',
			body: formData,
			headers: {
				Connection: 'keep-alive'
			}
		});

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Response body is missing');
		}

		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					let parsedData;
					try {
						const tParsedData = decodeStreamBufferToJson(streamBuffer);
						parsedData = JSON.parse(JSON.stringify(tParsedData));
					} catch (error) {
						const response = await fetch('/api/fix-json', {
							method: 'POST',
							headers: { 'Content-Type': 'text/plain' },
							body: streamBuffer
						});
						parsedData = (await response.json()).formattedJSON;
					}

					transcriptArray = [...parsedData];
					streamBuffer = '';
					uploadComplete = true;
					isUploading = false;
					break;
				}
				streamBuffer += decoder.decode(value, { stream: true });
				const tParsedData = decodeStreamBufferToJson(streamBuffer);
				if (tParsedData) {
					transcriptArray = [...tParsedData];
				}
			}
		} finally {
			reader.cancel();
		}
	}

	async function downloadTranscript({ timestamps = true } = {}) {
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray, timestamps })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.txt';
		a.click();
	}

	async function downloadSRT() {
		const response = await fetch('/api/srt', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.srt';
		a.click();
	}

	async function useSample() {
		const sampleFile = await fetch('/gettysburg-address.mp3');
		const blob = await sampleFile.blob();
		selectedFile = new File([blob], 'sample.mp3', { type: 'audio/mp3' });
		fileUrl = URL.createObjectURL(selectedFile);
		fileType = 'audio';
		handleSubmit();
	}

	function reset() {
		selectedFile = null;
		uploadComplete = false;
		isUploading = false;
		streamBuffer = '';
		transcriptArray = [];
		if (audioElement) {
			audioElement.pause();
			audioElement.currentTime = 0;
		}
		if (videoElement) {
			videoElement.pause();
			videoElement.currentTime = 0;
		}
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<div class="min-h-screen lg:container">
	<main class="flex flex-col py-2 lg:flex-row lg:py-5 items-start">
		<div class="mb-12 basis-1/3 justify-start rounded-lg bg-white p-5 shadow-md lg:mb-8">
			<h1 class="mb-4 text-4xl font-bold text-blue-600">Gemini Transcribe</h1>
			<p class="mb-5 text-xl text-gray-600">
				Transcribe audio and video files with speaker diarization and logically grouped timestamps
				using <code class="text-blue-600">{modelName}</code>
			</p>
			<hr />
			<div>
				{#if uploadComplete}
					<div class="mb-6">
						{#if fileType === 'audio'}
							<audio src={fileUrl} controls class="mx-auto w-full" bind:this={audioElement} />
						{:else if fileType === 'video'}
							<video src={fileUrl} controls class="mx-auto w-full" bind:this={videoElement} />
						{/if}
					</div>

					<button
						on:click={downloadTranscript}
						class="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
					>
						Download Transcript
					</button>
					<button
						on:click={() => downloadTranscript({ timestamps: false })}
						class="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
					>
						Download Transcript (no timestamps)
					</button>
					<button
						on:click={downloadSRT}
						class="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
					>
						Download Subtitles (SRT)
					</button>
					<button
						on:click={reset}
						class="mt-2 w-full rounded-lg bg-red-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
					>
						Reset
					</button>
				{:else}
					<div class="py-6">
						<h2 class="mb-4 text-2xl font-thin text-blue-500">Upload your file</h2>
						<Label for="audio-file" class="mb-2 block text-sm font-medium text-gray-700"
							>Select an audio or video file</Label
						>
						<Input
							type="file"
							on:input={handleFileInput}
							id="audio-file"
							accept="audio/*,video/*"
							class="mb-4 w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 p-2.5 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500"
						/>
						<button
							on:click={handleSubmit}
							class="mb-4 w-full rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 disabled:cursor-not-allowed disabled:bg-gray-400"
							disabled={!selectedFile || isUploading}
						>
							{isUploading ? 'Processing...' : 'Upload File'}
						</button>

						<p class="space-y-2 text-sm text-gray-700">
							Transcribe mp3, wav, mp4, avi & more. Duration limit of 1 hour per file. This app uses
							an experimental model. If processing fails, please try again.
						</p>

						{#if isUploading}
							<p class="mt-2 text-sm font-bold text-gray-600">
								Processing file - this may take a few minutes.
							</p>
						{:else}
							<button
								on:click={useSample}
								class="mt-4 text-sm text-gray-600 underline hover:text-gray-800 focus:outline-none"
							>
								Try transcribing a sample file
							</button>
						{/if}
					</div>
				{/if}
				<div class="text-gray-600 mt-2">
					<p class="text-sm">
						by <a
							href="https://mikeesto.com"
							class="text-blue-400 hover:text-blue-600 focus:outline-none">@mikeesto</a
						>
					</p>
					<p class="mt-1 text-sm">suggestions/feedback? i'd love to hear from you</p>
				</div>
			</div>
		</div>

		<div class="mx-auto basis-2/3 p-5">
			{#if !uploadComplete && !isUploading}
				<h2 class="mb-4 text-2xl font-bold text-blue-200">Waiting for upload ...</h2>
			{/if}
			{#if uploadComplete}
				<h2 class="mb-4 text-2xl font-bold text-blue-600">Transcript</h2>
			{/if}
			<div class="mb-2">
				{#if isUploading || streamBuffer.length > 0}
					<h2 class="mb-4 text-2xl font-bold text-zinc-500">Transcribing</h2>
					<div class="flex items-center gap-1">
						<div class="h-5 w-5 animate-bounce animate-pulse rounded-full bg-blue-500" />
						<div class="h-5 w-5 animate-bounce animate-pulse rounded-full bg-blue-500" />
						<div class="h-5 w-5 animate-bounce animate-pulse rounded-full bg-blue-500" />
					</div>
				{/if}
			</div>

			<div class="transcript mt-8">
				{#each transcriptArray as entry, index}
					<div class="mb-4 rounded-lg {index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} p-4 shadow-sm">
						<button
							class="mb-2 block rounded-full bg-indigo-500 px-3 py-1 text-sm font-bold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
							on:click={() => handleTimestampClick(entry.timestamp)}
						>
							{entry.timestamp}
						</button>
						<span class="font-bold text-gray-700">{entry.speaker}:</span>
						<span class="text-gray-800">{entry.text}</span>
					</div>
				{/each}
				<div bind:this={scrollAnchor} />
			</div>
		</div>
	</main>
</div>
