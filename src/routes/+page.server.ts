import { getMonthlyUploadCount } from '$lib/server/db';

export async function load() {
	const monthlyUploadCount = getMonthlyUploadCount();
	return {
		monthlyUploadCount
	};
}
