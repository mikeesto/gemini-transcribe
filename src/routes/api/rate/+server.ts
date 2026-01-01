import { saveRating } from '$lib/server/db';
import { json } from '@sveltejs/kit';

export async function POST({ request }) {
	const { usageId, rating } = await request.json();

	// Accept 1 (Thumbs Up) or -1 (Thumbs Down)
	if (usageId && (rating === 1 || rating === -1)) {
		try {
			saveRating(usageId, rating);
			return json({ success: true });
		} catch (error) {
			console.error('Error saving rating:', error);
			return json({ success: false }, { status: 500 });
		}
	}

	return json({ success: false }, { status: 400 });
}
