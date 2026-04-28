/**
 * Netlify function — aggregate all journal entries into dashboard stats (Relational)
 *
 * GET /.netlify/functions/journal-dashboard
 * Response:
 * {
 *   totals: { trades, wins, losses, be, winRate, avgRR },
 *   channels: [{ channelId, trades, wins, losses, be, winRate, avgRR, pairs: [] }],
 *   pairs: [{ pair, trades, wins, losses, be, winRate, avgRR }]
 * }
 */

const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  return sql;
}

exports.handler = async () => {
  if (!process.env.DATABASE_URL) {
    return respond(500, { error: 'DATABASE_URL is not set' });
  }

  try {
    const sql = await getDb();

    // 1. Totals
    const totalRows = await sql`
      SELECT 
        COUNT(*)::int as trades,
        COUNT(*) FILTER (WHERE result = 'win')::int as wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int as losses,
        COUNT(*) FILTER (WHERE result = 'be')::int as be,
        AVG(rr) as avg_rr
      FROM journal_entries
    `;
    const t = totalRows[0];
    const totals = {
      trades: t.trades,
      wins: t.wins,
      losses: t.losses,
      be: t.be,
      winRate: t.trades ? Number(((t.wins / t.trades) * 100).toFixed(1)) : null,
      avgRR: t.avg_rr ? Number(Number(t.avg_rr).toFixed(2)) : null
    };

    // 1.5 Quarters
    const quarterRows = await sql`
      SELECT 
        DATE_PART('year', created_at)::int as year,
        DATE_PART('quarter', created_at)::int as quarter,
        COUNT(*)::int as trades,
        COUNT(*) FILTER (WHERE result = 'win')::int as wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int as losses,
        COUNT(*) FILTER (WHERE result = 'be')::int as be,
        AVG(rr) as avg_rr
      FROM journal_entries
      GROUP BY year, quarter
      ORDER BY year DESC, quarter DESC
    `;
    const quarters = quarterRows.map(q => ({
      year: q.year,
      quarter: q.quarter,
      label: `${q.year} Q${q.quarter}`,
      trades: q.trades,
      wins: q.wins,
      losses: q.losses,
      be: q.be,
      winRate: q.trades ? Number(((q.wins / q.trades) * 100).toFixed(1)) : null,
      avgRR: q.avg_rr ? Number(Number(q.avg_rr).toFixed(2)) : null
    }));

    // 2. Channels
    const channelRows = await sql`
      SELECT 
        channel_id,
        COUNT(*)::int as trades,
        COUNT(*) FILTER (WHERE result = 'win')::int as wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int as losses,
        COUNT(*) FILTER (WHERE result = 'be')::int as be,
        AVG(rr) as avg_rr,
        array_agg(DISTINCT pair) FILTER (WHERE pair IS NOT NULL) as pairs
      FROM journal_entries
      GROUP BY channel_id
      ORDER BY trades DESC, channel_id ASC
    `;
    const channels = channelRows.map(c => ({
      channelId: c.channel_id,
      trades: c.trades,
      wins: c.wins,
      losses: c.losses,
      be: c.be,
      winRate: c.trades ? Number(((c.wins / c.trades) * 100).toFixed(1)) : null,
      avgRR: c.avg_rr ? Number(Number(c.avg_rr).toFixed(2)) : null,
      pairs: c.pairs || []
    }));

    // 3. Pairs
    const pairRows = await sql`
      SELECT 
        pair,
        COUNT(*)::int as trades,
        COUNT(*) FILTER (WHERE result = 'win')::int as wins,
        COUNT(*) FILTER (WHERE result = 'loss')::int as losses,
        COUNT(*) FILTER (WHERE result = 'be')::int as be,
        AVG(rr) as avg_rr
      FROM journal_entries
      WHERE pair IS NOT NULL
      GROUP BY pair
      ORDER BY trades DESC, pair ASC
    `;
    const pairs = pairRows.map(p => ({
      pair: p.pair,
      trades: p.trades,
      wins: p.wins,
      losses: p.losses,
      be: p.be,
      winRate: p.trades ? Number(((p.wins / p.trades) * 100).toFixed(1)) : null,
      avgRR: p.avg_rr ? Number(Number(p.avg_rr).toFixed(2)) : null
    }));

    return respond(200, { totals, quarters, channels, pairs });
  } catch (err) {
    console.error('[journal-dashboard]', err.message);
    // If table doesn't exist yet, return empty stats
    if (err.message.includes('relation "journal_entries" does not exist')) {
      return respond(200, { 
        totals: { trades: 0, wins: 0, losses: 0, be: 0, winRate: null, avgRR: null },
        channels: [],
        pairs: []
      });
    }
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
