// node --experimental-strip-types analysis.ts

import Database from 'better-sqlite3';

const db = new Database('../usage.db', { readonly: true });

// Helper function to format bytes
function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Helper function to format duration
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
	return `${(ms / 60000).toFixed(2)}min`;
}

console.log('='.repeat(60));
console.log('USAGE ANALYSIS');
console.log('='.repeat(60));

// Total records
const total = db.prepare('SELECT COUNT(*) as count FROM usage_logs').get() as { count: number };
console.log(`\nTotal Records: ${total.count}`);

if (total.count === 0) {
	console.log('\nNo records found in the database.');
	db.close();
	process.exit(0);
}

// File size statistics
const fileSizeStats = db
	.prepare(
		`
  SELECT 
    MAX(file_size_bytes) as max_size,
    MIN(file_size_bytes) as min_size,
    AVG(file_size_bytes) as avg_size,
    SUM(file_size_bytes) as total_size
  FROM usage_logs
  WHERE file_size_bytes IS NOT NULL
`
	)
	.get() as { max_size: number; min_size: number; avg_size: number; total_size: number };

console.log('\n--- FILE SIZE STATISTICS ---');
console.log(`Max:     ${formatBytes(fileSizeStats.max_size)}`);
console.log(`Min:     ${formatBytes(fileSizeStats.min_size)}`);
console.log(`Average: ${formatBytes(fileSizeStats.avg_size)}`);
console.log(`Total:   ${formatBytes(fileSizeStats.total_size)}`);

// Duration statistics (excluding 0s)
const durationStats = db
	.prepare(
		`
  SELECT 
    MAX(duration_ms) as max_duration,
    MIN(duration_ms) as min_duration,
    AVG(duration_ms) as avg_duration,
    SUM(duration_ms) as total_duration,
    COUNT(*) as valid_count
  FROM usage_logs
  WHERE duration_ms IS NOT NULL AND duration_ms > 0
`
	)
	.get() as {
	max_duration: number;
	min_duration: number;
	avg_duration: number;
	total_duration: number;
	valid_count: number;
};

console.log('\n--- DURATION STATISTICS (excluding 0s) ---');
console.log(`Valid Records: ${durationStats.valid_count}`);
console.log(`Max:     ${formatDuration(durationStats.max_duration)}`);
console.log(`Min:     ${formatDuration(durationStats.min_duration)}`);
console.log(`Average: ${formatDuration(durationStats.avg_duration)}`);
console.log(`Total:   ${formatDuration(durationStats.total_duration)}`);

// Duplicate detection (same file_size and duration, excluding 0 durations)
const duplicates = db
	.prepare(
		`
  SELECT 
    file_size_bytes,
    duration_ms,
    COUNT(*) as count
  FROM usage_logs
  WHERE duration_ms IS NOT NULL AND duration_ms > 0
    AND file_size_bytes IS NOT NULL
  GROUP BY file_size_bytes, duration_ms
  HAVING COUNT(*) > 1
  ORDER BY count DESC
`
	)
	.all() as Array<{ file_size_bytes: number; duration_ms: number; count: number }>;

console.log('\n--- DUPLICATE DETECTION ---');
if (duplicates.length === 0) {
	console.log('No duplicates found (same file size + duration)');
} else {
	console.log(`Found ${duplicates.length} duplicate combinations:`);
	duplicates.slice(0, 10).forEach((d) => {
		console.log(
			`  ${formatBytes(d.file_size_bytes)} + ${formatDuration(d.duration_ms)} → ${d.count} occurrences`
		);
	});
	if (duplicates.length > 10) {
		console.log(`  ... and ${duplicates.length - 10} more`);
	}
	const totalDuplicates = duplicates.reduce((sum, d) => sum + d.count, 0);
	console.log(`Total records with duplicates: ${totalDuplicates}`);
}

// Model usage breakdown
const modelUsage = db
	.prepare(
		`
  SELECT 
    model_used,
    COUNT(*) as count,
    AVG(file_size_bytes) as avg_size,
    AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) as avg_duration
  FROM usage_logs
  WHERE model_used IS NOT NULL
  GROUP BY model_used
  ORDER BY count DESC
`
	)
	.all() as Array<{ model_used: string; count: number; avg_size: number; avg_duration: number }>;

if (modelUsage.length > 0) {
	console.log('\n--- MODEL USAGE BREAKDOWN ---');
	modelUsage.forEach((m) => {
		console.log(`\n${m.model_used}:`);
		console.log(`  Requests:    ${m.count}`);
		console.log(`  Avg Size:    ${formatBytes(m.avg_size)}`);
		if (m.avg_duration) {
			console.log(`  Avg Duration: ${formatDuration(m.avg_duration)}`);
		}
	});
}

console.log('\n' + '='.repeat(60));

db.close();
