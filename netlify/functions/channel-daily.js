/**
 * GET /.netlify/functions/channel-daily?channelId=UC...
 * Returns date-wise summary + individual trades for a single channel.
 */

const { neon } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  if (!process.env.DATABASE_URL) return respond(500, { error: 'DATABASE_URL not set' });

  const { channelId } = event.queryStringParameters || {};
  if (!channelId) return respond(400, { error: 'channelId is required' });

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Daily aggregates
    const dayRows = await sql`
      SELECT
        DATE(created_at)::text AS date,
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE result = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE result = 'be')::int AS be,
        AVG(rr) AS avg_rr,
        COUNT(*) FILTER (WHERE direction = 'long')::int AS longs,
        COUNT(*) FILTER (WHERE direction = 'short')::int AS shorts
      FROM journal_entries
      WHERE channel_id = ${channelId}
      GROUP BY date
      ORDER BY date DESC
    `;

    // Individual trades
    const tradeRows = await sql`
      SELECT
        id,
        DATE(created_at)::text AS date,
        stream_title,
        pair,
        direction,
        result,
        entry_price,
        stop_price,
        exit_price,
        rr,
        notes,
        video_timestamp,
        stream_id
      FROM journal_entries
      WHERE channel_id = ${channelId}
      ORDER BY created_at DESC
    `;

    const days = dayRows.map(r => ({
      date: r.date,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      be: r.be,
      longs: r.longs,
      shorts: r.shorts,
      winRate: r.trades ? Number(((r.wins / r.trades) * 100).toFixed(1)) : null,
      avgRR: r.avg_rr ? Number(Number(r.avg_rr).toFixed(2)) : null,
    }));

    const trades = tradeRows.map(r => ({
      id: r.id,
      date: r.date,
      streamTitle: r.stream_title,
      streamId: r.stream_id,
      pair: r.pair,
      direction: r.direction,
      result: r.result,
      entry: r.entry_price != null ? Number(r.entry_price) : null,
      stop: r.stop_price  != null ? Number(r.stop_price)  : null,
      exit: r.exit_price  != null ? Number(r.exit_price)  : null,
      rr: r.rr != null ? Number(Number(r.rr).toFixed(2)) : null,
      notes: r.notes,
      videoTimestamp: r.video_timestamp,
    }));

    return respond(200, { days, trades });
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
