export async function POST({ request }) {
	const { transcript, timestamps } = await request.json();
	let formattedTranscript;

	if (timestamps) {
		formattedTranscript = transcript
			.map((entry: { start: number; speaker: string; text: string }) => {
				const mins = Math.floor(entry.start / 60);
				const secs = Math.floor(entry.start % 60);
				const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
				return `[${ts}]\n[${entry.speaker}]\n${entry.text}`;
			})
			.join('\n\n');
	} else {
		formattedTranscript = transcript
			.map((entry: { speaker: string; text: string }) => {
				return `[${entry.speaker}]\n${entry.text}`;
			})
			.join('\n\n');
	}

	const headers = new Headers();
	headers.set('Content-Type', 'text/plain');
	headers.set('Content-Disposition', 'attachment; filename="transcript.txt"');

	return new Response(formattedTranscript, { headers });
}
