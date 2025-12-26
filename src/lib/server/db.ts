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
    duration_ms INTEGER
  )
`);

export function logUsage(fileSizeBytes: number, modelUsed: string, durationMs: number) {
	const stmt = db.prepare(
		'INSERT INTO usage_logs (file_size_bytes, model_used, duration_ms) VALUES (?, ?, ?)'
	);
	stmt.run(fileSizeBytes, modelUsed, durationMs);
}

// Get a count of uploads over the past month
export function getMonthlyUploadCount() {
	const oneMonthAgo = new Date();
	oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
	const stmt = db.prepare('SELECT COUNT(*) as count FROM usage_logs WHERE timestamp >= ?');
	const result = stmt.get(oneMonthAgo.toISOString()) as { count: number };
	return result.count;
}
