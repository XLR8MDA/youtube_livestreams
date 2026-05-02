/**
 * GET /.netlify/functions/channel-daily?channelId=UC...
 * Returns date-wise performance breakdown for a single channel.
 */

const { neon } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });

  const { channelId } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  try {
    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`
      SELECT
        DATE(created_at)::text AS date,
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE result = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE result = 'be')::int AS be,
        AVG(rr) AS avg_rr
      FROM journal_entries
      WHERE channel_id = ${channelId}
      GROUP BY date
      ORDER BY date DESC
    `;

    const days = rows.map(r => ({
      date: r.date,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      be: r.be,
      winRate: r.trades ? Number(((r.wins / r.trades) * 100).toFixed(1)) : null,
      avgRR: r.avg_rr ? Number(Number(r.avg_rr).toFixed(2)) : null,
    }));

    return respond(200, { days });
  } catch (err) {
    console.error('[channel-daily]', err.message);
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
