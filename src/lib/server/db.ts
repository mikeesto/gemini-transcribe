import Database from 'better-sqlite3';
import fs from 'fs';

// Determine path: use /data inside Fly, or a local file for dev
const dbPath = fs.existsSync('/data') ? '/data/usage.db' : 'local-usage.db';

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_size_bytes INTEGER,
    model_used TEXT,
    duration_ms INTEGER,
    rating INTEGER
  )
`);

// MIGRATION: Attempt to add the column if it doesn't exist (for existing prod DB)
try {
	db.exec('ALTER TABLE usage_logs ADD COLUMN rating INTEGER');
} catch {
	// Column likely already exists, ignore
}

export function logUsage(
	fileSizeBytes: number,
	modelUsed: string,
	durationMs: number
): number | bigint {
	const stmt = db.prepare(
		'INSERT INTO usage_logs (file_size_bytes, model_used, duration_ms) VALUES (?, ?, ?)'
	);
	const info = stmt.run(fileSizeBytes, modelUsed, durationMs);
	return info.lastInsertRowid;
}

export function saveRating(id: number, rating: number) {
	const stmt = db.prepare('UPDATE usage_logs SET rating = ? WHERE id = ?');
	stmt.run(rating, id);
}

// Get a count of uploads over the past month
export function getMonthlyUploadCount() {
	const oneMonthAgo = new Date();
	oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
	const stmt = db.prepare('SELECT COUNT(*) as count FROM usage_logs WHERE timestamp >= ?');
	const result = stmt.get(oneMonthAgo.toISOString()) as { count: number };
	return result.count;
}
