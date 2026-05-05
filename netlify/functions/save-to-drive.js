/**
 * Netlify function — save base64 image to Google Drive
 * 
 * POST /.netlify/functions/save-to-drive
 * Body: { imageBase64: string, mimeType: string, filename: string }
 * 
 * Strategy:
 * 1. Read refresh token from NeonDB dashboard_state['google-drive-token']
 * 2. Exchange for access token via GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * 3. Find or Create "MultiPlay Trades" folder
 * 4. Upload multipart file (metadata + media)
 */

const { neon } = require('@neondatabase/serverless');

const TOKEN_URL      = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, 'Method not allowed');
  
  const { DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!DATABASE_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return respond(500, 'Missing environment variables');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, 'Invalid JSON'); }
  
  const { imageBase64, mimeType = 'image/png', filename } = body;
  if (!imageBase64 || !filename) return respond(400, 'imageBase64 and filename are required');

  try {
    const sql = neon(DATABASE_URL);
    
    // 1. Get refresh token
    const rows = await sql`SELECT value FROM dashboard_state WHERE key = 'google-drive-token'`;
    if (!rows.length) return respond(401, 'Google Drive not connected. Visit settings to link your account.');
    const refreshToken = rows[0].value?.refresh_token;

    // 2. Get access token
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`Token refresh failed: ${tokenData.error_description || tokenData.error}`);
    const accessToken = tokenData.access_token;

    // 3. Find or create folder
    const folderId = await getOrCreateFolder(accessToken);

    // 4. Upload file
    const fileMetadata = {
      name: filename,
      parents: [folderId],
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const close_delim = `\r\n--${boundary}--`;

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(fileMetadata) +
      delimiter +
      `Content-Type: ${mimeType}\r\n` +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      imageBase64 +
      close_delim;

    const uploadRes = await fetch(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': multipartRequestBody.length,
      },
      body: multipartRequestBody,
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadData.error?.message || 'Unknown error'}`);

    return respond(200, { ok: true, fileId: uploadData.id, name: uploadData.name });

  } catch (err) {
    console.error('[save-to-drive]', err.message);
    return respond(500, err.message);
  }
};

async function getOrCreateFolder(accessToken) {
  const folderName = 'MultiPlay Trades';
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  const res = await fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id)`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const data = await res.json();
  
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create it
  const createRes = await fetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(`Folder creation failed: ${createData.error?.message}`);
  return createData.id;
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof payload === 'string' ? { error: payload } : payload),
  };
}
