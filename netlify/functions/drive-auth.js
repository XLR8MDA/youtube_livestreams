/**
 * Netlify function — Google Drive OAuth2 flow
 * 
 * GET  /.netlify/functions/drive-auth          → Redirects to Google Consent Screen
 * GET  /.netlify/functions/drive-auth?code=... → Exchanges code for refresh token, saves to DB
 */

const { neon } = require('@neondatabase/serverless');

const SCOPES       = ['https://www.googleapis.com/auth/drive.file'];
const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';

exports.handler = async (event) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, URL } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return respond(500, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  const redirectUri = `${URL}/.netlify/functions/drive-auth`;
  const { code }    = event.queryStringParameters || {};

  // Phase 1: Redirect to Google
  if (!code) {
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         SCOPES.join(' '),
      access_type:   'offline',
      prompt:        'consent',
    });
    return {
      statusCode: 302,
      headers:    { Location: `${AUTH_URL}?${params.toString()}` },
      body:       '',
    };
  }

  // Phase 2: Exchange code for token
  try {
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed');

    const refreshToken = data.refresh_token;
    if (!refreshToken) throw new Error('No refresh token returned — did you already authorize? Try removing access in Google Settings.');

    // Save to NeonDB
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO dashboard_state (key, value)
      VALUES ('google-drive-token', ${JSON.stringify({ refresh_token: refreshToken })}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'text/html' },
      body:       `
        <html>
          <body style="font-family: sans-serif; background: #0a0a0b; color: #eee; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh;">
            <div style="background: #161618; padding: 2rem; border-radius: 8px; border: 1px solid #28282c; text-align: center;">
              <h1 style="color: #00ff9d;">Success!</h1>
              <p>Google Drive has been connected to MultiPlay.</p>
              <p style="color: #888; font-size: 0.9rem;">You can close this tab now.</p>
              <button onclick="window.close()" style="background: #00ff9d; color: #000; border: none; padding: 0.5rem 1.5rem; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 1rem;">Close Tab</button>
            </div>
          </body>
        </html>
      `,
    };

  } catch (err) {
    console.error('[drive-auth]', err.message);
    return respond(500, err.message);
  }
};

function respond(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ error: message }),
  };
}
