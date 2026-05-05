'use strict';

// Reads all stream_ids that have journal entries from NeonDB,
// then outputs a localStorage command to paste in the browser console.

const fs   = require('fs');
const path = require('path');

// Load .env manually (no dotenv dependency)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set in .env');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql`
    SELECT DISTINCT stream_id
    FROM journal_entries
    WHERE stream_id IS NOT NULL AND stream_id <> ''
    ORDER BY stream_id
  `;

  const ids = rows.map(r => r.stream_id);

  if (!ids.length) {
    console.log('No journal entries found.');
    return;
  }

  console.log(`\nFound ${ids.length} stream(s) with journal entries:\n`);
  ids.forEach(id => console.log(' ', id));

  console.log('\n── Paste this in your browser console to mark them all as reviewed ──\n');
  const existing = 'JSON.parse(localStorage.getItem(\'bt_reviewed\') || \'[]\')';
  console.log(
    `const prev = new Set(${existing});\n` +
    `const reviewed = ${JSON.stringify(ids)};\n` +
    `reviewed.forEach(id => prev.add(id));\n` +
    `localStorage.setItem('bt_reviewed', JSON.stringify([...prev]));\n` +
    `console.log('Marked', reviewed.length, 'streams as reviewed.');`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
