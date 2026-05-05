'use strict';
const https = require('https');

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    }).on('error', rej);
  });
}

async function fetchPlaylist(id) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const r = await get('https://inv.nadeko.net/api/v1/playlists/' + id + '?page=' + page);
    if (r.status !== 200) break;
    const d = JSON.parse(r.body);
    const vids = (d.videos || []).filter(v => v.type === 'video');
    if (vids.length === 0) break;
    all.push(...vids);
    if (all.length >= (d.videoCount || 999)) break;
  }
  return all;
}

async function main() {
  const playlists = {
    smc:      'PLyobF5Rf4liTQrcKtSmbwaCtX71lUP-n_',
    bootcamp: 'PLguWwLNVYKWfGzKcW358QivkQceAtW5B-',
    zip3:     'PLguWwLNVYKWeGlaKrhB3Tp9MfMmj7BlQg',
  };

  const result = {};
  for (const [name, id] of Object.entries(playlists)) {
    process.stderr.write('Fetching ' + name + '...\n');
    result[name] = await fetchPlaylist(id);
    process.stderr.write('  -> ' + result[name].length + ' videos\n');
  }

  const lines = ['const COURSE_VIDEOS = {'];
  for (const [name, items] of Object.entries(result)) {
    lines.push('  ' + name + ': [');
    items.forEach((v, i) => {
      const safe = v.title.replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
      lines.push("    { videoId: '" + v.videoId + "', title: '" + safe + "' }, // " + i);
    });
    lines.push('  ],');
  }
  lines.push('};');
  console.log(lines.join('\n'));
}

main().catch(e => { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); });
