// Helper function to format total seconds (number) into HH:MM:SS,ms string
function formatTime(totalSeconds: number) {
	const date = new Date(0);
	date.setMilliseconds(totalSeconds * 1000);

	const hours = String(date.getUTCHours()).padStart(2, '0');
	const minutes = String(date.getUTCMinutes()).padStart(2, '0');
	const secs = String(date.getUTCSeconds()).padStart(2, '0');
	const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');

	return `${hours}:${minutes}:${secs},${milliseconds}`;
}

export async function POST({ request }) {
	try {
		const { transcript } = await request.json();

		let srtContent = '';
		const defaultDuration = 3; // Default duration in seconds for the last segment

		for (let i = 0; i < transcript.length; i++) {
			const entry = transcript[i];

			// Skip invalid entries
			if (
				typeof entry.text !== 'string' ||
				typeof entry.start !== 'number' ||
				typeof entry.speaker !== 'string'
			) {
				console.warn(`Skipping entry with missing/invalid fields at index ${i}:`, entry);
				continue;
			}

			const startTimeSeconds = entry.start;

			// Determine end time
			let endTimeSeconds;
			if (i < transcript.length - 1) {
				const nextEntry = transcript[i + 1];
				if (nextEntry && typeof nextEntry.start === 'number' && nextEntry.start > startTimeSeconds) {
					endTimeSeconds = nextEntry.start;
				} else {
					endTimeSeconds = startTimeSeconds + defaultDuration;
				}
			} else {
				endTimeSeconds = startTimeSeconds + defaultDuration;
			}

			const startTimeFormatted = formatTime(startTimeSeconds);
			const endTimeFormatted = formatTime(endTimeSeconds);

			// Construct the SRT block
			srtContent += `${i + 1}\n`;
			srtContent += `${startTimeFormatted} --> ${endTimeFormatted}\n`;
			srtContent += `${entry.text}\n\n`;
		}

		const headers = new Headers();
		headers.set('Content-Type', 'text/srt; charset=utf-8');
		headers.set('Content-Disposition', 'attachment; filename="transcript.srt"');

		return new Response(srtContent, { headers });
	} catch (error) {
		console.error('Error processing request:', error);
		if (error instanceof SyntaxError) {
			return new Response('Invalid JSON body.', { status: 400 });
		}
		return new Response('An internal server error occurred.', { status: 500 });
	}
}
