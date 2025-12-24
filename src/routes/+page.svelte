<script lang="ts">
	import { onMount } from 'svelte';

	let selectedFile = $state<File | null>(null);
	let uploadComplete = $state(false);
	let isUploading = $state(false);
	let fileUrl = $state<string | null>(null);
	let fileType = $state<'audio' | 'video'>('audio');

	let streamBuffer = $state('');
	let transcriptArray = $state<Array<{ timestamp: string; speaker: string; text: string }>>([]);
	let language = $state('English');
	let initialized = $state(false);
	let errorMessage = $state<string | null>(null);

	let audioElement = $state<HTMLAudioElement | null>(null);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let copiedToClipboard = $state(false);

	onMount(() => {
		language = localStorage.getItem('transcriptionLanguage') || 'English';
		initialized = true;
	});

	$effect(() => {
		if (initialized) {
			localStorage.setItem('transcriptionLanguage', language);
		}
	});

	function handleTimestampClick(timestamp: string) {
		const parts = timestamp.split(':').map(Number);
		let timeInSeconds = 0;

		if (parts.length === 3) {
			timeInSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
		} else if (parts.length === 2) {
			timeInSeconds = parts[0] * 60 + parts[1]; // mm:ss
		}

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
		errorMessage = null;
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			fileUrl = URL.createObjectURL(selectedFile);
			fileType = selectedFile.type.includes('audio') ? 'audio' : 'video';
		}
	}

	function parseStreamedJson(
		buffer: string
	): Array<{ timestamp: string; speaker: string; text: string }> {
		const objectStrings = buffer.match(/{[^}]*}/g);
		if (!objectStrings) {
			return [];
		}

		return objectStrings
			.map((objStr) => {
				try {
					const parsed = JSON.parse(objStr);
					if (
						parsed &&
						typeof parsed.timestamp === 'string' &&
						typeof parsed.speaker === 'string' &&
						typeof parsed.text === 'string'
					) {
						return parsed;
					}
					return null;
				} catch (e) {
					return null;
				}
			})
			.filter((entry): entry is { timestamp: string; speaker: string; text: string } => !!entry);
	}

	async function handleSubmit() {
		if (!selectedFile) return;
		errorMessage = null;

		if (selectedFile.size >= 536870912) {
			alert('This file is too large. Please select a file that is less than 512MB.');
			return;
		}

		isUploading = true;

		const formData = new FormData();
		formData.append('file', selectedFile);
		formData.append('language', language);

		const response = await fetch('/api/upload', {
			method: 'POST',
			body: formData,
			headers: {
				Connection: 'keep-alive'
			}
		});

		if (!response.ok) {
			errorMessage = await response.text();
			isUploading = false;
			return;
		}

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
						parsedData = JSON.parse(streamBuffer);
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
				transcriptArray = parseStreamedJson(streamBuffer);
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

	function reset() {
		selectedFile = null;
		uploadComplete = false;
		isUploading = false;
		fileUrl = null;
		streamBuffer = '';
		transcriptArray = [];
		errorMessage = null;
		if (audioElement) {
			audioElement.currentTime = 0;
			audioElement.pause();
		}
		if (videoElement) {
			videoElement.currentTime = 0;
			videoElement.pause();
		}
	}

	async function useSample() {
		const sampleFile = await fetch('/gettysburg-address.mp3');
		const blob = await sampleFile.blob();
		selectedFile = new File([blob], 'sample.mp3', { type: 'audio/mp3' });
		fileUrl = URL.createObjectURL(selectedFile);
		fileType = 'audio';
		handleSubmit();
	}

	async function copyToClipboard() {
		const text = transcriptArray
			.map((entry) => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
			.join('\n');
		await navigator.clipboard.writeText(text);
		copiedToClipboard = true;
		setTimeout(() => {
			copiedToClipboard = false;
		}, 2000);
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-linear-to-br from-indigo-50 via-white to-cyan-50">
	<main class="relative z-10 container mx-auto grow px-4 py-8">
		<section class="mb-6 text-center">
			<h1
				class="mb-3 bg-linear-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent md:text-4xl"
			>
				Gemini Transcribe
			</h1>
			<p class="mx-auto max-w-2xl text-lg leading-relaxed text-slate-600">
				Transform your audio and video files into accurate transcripts with speaker diarization and
				logically grouped timestamps.
			</p>
		</section>

		<div class="mx-auto max-w-4xl">
			{#if uploadComplete}
				<!-- Media Player Section -->
				<div class="mb-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
					<div class="mb-6">
						{#if fileType === 'audio'}
							<audio src={fileUrl} controls class="h-12 w-full" bind:this={audioElement}></audio>
						{:else if fileType === 'video'}
							<video src={fileUrl} controls class="w-full rounded-lg" bind:this={videoElement}
								><track kind="captions" src="" srclang="en" label="English" /></video
							>
						{/if}
					</div>

					<!-- Download Actions -->
					<div
						class="mt-6 flex flex-col gap-4 border-t border-slate-100 pt-6 sm:flex-row sm:items-center sm:justify-between"
					>
						<!-- Left Side: Export Tools -->
						<div class="flex flex-wrap gap-2">
							<button
								onclick={copyToClipboard}
								class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
							>
								{#if copiedToClipboard}
									<svg class="h-4 w-4 text-green-600" fill="currentColor" viewBox="0 0 24 24">
										<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
									</svg>
									<span class="text-green-600">Copied!</span>
								{:else}
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
										/>
									</svg>
									<span>Copy</span>
								{/if}
							</button>

							<button
								onclick={() => downloadTranscript()}
								class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span>.txt</span>
							</button>

							<button
								onclick={downloadSRT}
								class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span>.srt</span>
							</button>

							<button
								onclick={() => downloadTranscript({ timestamps: false })}
								class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span>.txt (no timestamps)</span>
							</button>
						</div>

						<!-- Right Side: Primary Action -->
						<div>
							<button
								onclick={reset}
								class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 4v16m8-8H4"
									/>
								</svg>
								<span>New transcription</span>
							</button>
						</div>
					</div>
				</div>
			{:else}
				<!-- Upload Section -->
				<div class="mb-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
					<div class="mb-6">
						<div class="flex gap-4">
							<div
								class="mb-2 inline-flex h-16 w-16 items-center justify-center rounded-xl bg-linear-to-br from-indigo-100 to-purple-100 shadow-lg shadow-indigo-500/20"
							>
								<svg
									class="h-8 w-8 text-indigo-600"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
									/>
								</svg>
							</div>
							<div>
								<h2 class="mb-1 text-xl font-semibold text-slate-900">Upload Your Media</h2>
								<p class="text-sm text-slate-500">
									Select an audio or video file to begin transcription
								</p>
							</div>
						</div>
					</div>

					<div class="space-y-5">
						<div>
							<label for="audio-file" class="mb-2 block text-sm font-medium text-slate-700">
								Choose File
							</label>
							<div class="relative">
								<input
									type="file"
									oninput={handleFileInput}
									id="audio-file"
									accept="audio/*,video/*"
									class="block h-auto w-full rounded-lg border-2 border-indigo-200 p-1.5 text-sm text-slate-500 shadow-sm backdrop-blur-sm file:mr-4 file:rounded-md file:border-0 file:bg-indigo-600 file:px-4 file:py-3 file:text-sm file:font-semibold file:text-white hover:file:cursor-pointer hover:file:bg-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
								/>
							</div>
						</div>

						<div>
							<label for="language" class="mb-2 block text-sm font-medium text-slate-700">
								Language of Transcript
							</label>
							<input
								type="text"
								bind:value={language}
								id="language"
								placeholder="Enter language (e.g., English, Spanish)"
								class="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-slate-800 placeholder-slate-400 transition-colors focus:border-slate-400 focus:ring-1 focus:ring-slate-400"
							/>
						</div>

						{#if errorMessage}
							<div
								class="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
								role="alert"
							>
								<svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
								<span>{errorMessage}</span>
							</div>
						{/if}

						<button
							onclick={handleSubmit}
							class="w-full cursor-pointer rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:opacity-50"
							disabled={!selectedFile || isUploading}
						>
							<div class="flex items-center justify-center gap-2">
								{#if isUploading}
									<svg
										class="h-4 w-4 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									<span>Processing...</span>
								{:else}
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
										/>
									</svg>
									<span>Upload & Transcribe</span>
								{/if}
							</div>
						</button>

						<div
							class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-600"
						>
							<p>Supported formats: MP3, WAV, MP4, AVI & more · Max size: 512MB</p>
							<p class="mt-1 text-xs text-slate-500">
								This app uses experimental models. If processing fails, please try again later.
							</p>
						</div>

						{#if isUploading}
							<div class="text-center">
								<div class="inline-flex items-center gap-2 text-sm text-slate-600">
									<svg
										class="h-4 w-4 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									<span>Processing your file... This may take a few minutes</span>
								</div>
							</div>
						{:else}
							<div class="text-center">
								<button
									onclick={useSample}
									class="inline-flex cursor-pointer items-center gap-1 text-sm text-slate-600 underline-offset-2 transition-colors hover:text-slate-900 hover:underline"
								>
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
										/>
									</svg>
									<span>Try with sample audio</span>
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Transcript Display -->
			{#if transcriptArray.length > 0}
				<div class="space-y-3">
					<div class="mb-4 flex items-center justify-between">
						<h3 class="text-lg font-semibold text-slate-900">Transcript</h3>
						<p class="text-sm text-slate-500">Click timestamps to jump to that moment</p>
					</div>

					{#each transcriptArray as entry}
						<div
							class="rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50"
						>
							<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
								<div class="flex items-center gap-2">
									<button
										class="cursor-pointer rounded bg-slate-100 px-2 py-1 font-mono text-sm text-slate-700 transition-colors hover:bg-slate-200"
										onclick={() => handleTimestampClick(entry.timestamp)}
									>
										{entry.timestamp}
									</button>
									<span
										class="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium text-slate-600"
									>
										{entry.speaker}
									</span>
								</div>
								<p class="flex-1 text-slate-700">{entry.text}</p>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</main>

	<footer class="relative z-10 border-slate-200">
		<div class="container mx-auto px-4 py-4">
			<div class="text-center text-slate-500">
				<p class="text-sm">
					by
					<a
						href="https://mikeesto.com"
						class="font-medium text-indigo-600 transition-colors duration-200 hover:text-indigo-800"
					>
						@mikeesto
					</a>
				</p>
				<p class="mt-1 text-sm">Suggestions or feedback? I'd love to hear from you.</p>
			</div>
		</div>
	</footer>
</div>
