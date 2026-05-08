// =============================================================================
// Calibration Service — Phase B (May 2026)
// =============================================================================
// Pure helpers + DB I/O for the daily calibration audit invoked by
// metaReviewService.runReview(). Buckets the day's SIGNAL rows by their
// predicted confidence, joins to TRADE_EXECUTED outcomes (via trade_memory
// won/pnl), and computes the gap between predicted confidence and realized
// win rate per bucket.
//
// Bucketing: 5 bins across the active gate band [0.65, 0.90]:
//   [0.65, 0.70), [0.70, 0.75), [0.75, 0.80), [0.80, 0.85), [0.85, 0.90]
//
// Persistence: every audit row goes into `calibration_history`. When the
// most-recent N (DEFAULT 5) consecutive days show |gap| > GAP_THRESHOLD
// (DEFAULT 0.15) for the SAME bucket, the audit returns a `flagged_bucket`
// payload that metaReviewService converts to a numbered suggestion targeting
// `confidence_gate_base` (Discord-approvable).
//
// SAFETY: this layer is INFORMATIONAL only — it never auto-tightens any
// gate, never blocks a trade, and the suggestion still requires operator
// Approve to take effect. The only DB writes are to `calibration_history`.
// =============================================================================

const db = require('./db');

const BUCKETS = [
  [0.65, 0.70], [0.70, 0.75], [0.75, 0.80], [0.80, 0.85], [0.85, 0.901],
];
const GAP_THRESHOLD = 0.15;
const FLAG_REQUIRED_DAYS = 5;

function bucketKey(low, high) { return `${low.toFixed(2)}-${high.toFixed(2)}`; }

// Pure: assign a confidence score to one of the 5 buckets, or null if it
// falls outside the [0.65, 0.90] gate band (e.g. statistical-only HOLDs at
// 0.50). The exclusive upper bound of 0.901 in the last bucket is so that
// 0.90 itself lands inside the top bucket.
function assignBucket(conf) {
  if (!Number.isFinite(conf)) return null;
  for (const [lo, hi] of BUCKETS) {
    if (conf >= lo && conf < hi) return [lo, Math.min(hi, 0.90)];
  }
  return null;
}

// Pure: compute per-bucket aggregates from arrays of {predicted, realized}.
// `realized` is 1 (win) / 0 (loss) / null (no close yet). Buckets with
// n_trades==0 carry realized_wr=null.
function bucketAggregates(rows) {
  const acc = new Map();
  for (const [lo, hi] of BUCKETS) {
    acc.set(bucketKey(lo, hi), {
      bucket_low: lo, bucket_high: Math.min(hi, 0.90),
      n_signals: 0, n_trades: 0, n_wins: 0, sum_pred: 0,
    });
  }
  for (const r of rows) {
    const b = assignBucket(r.predicted);
    if (!b) continue;
    const cell = acc.get(bucketKey(b[0], b[1]));
    cell.n_signals++;
    cell.sum_pred += r.predicted;
    if (r.realized === 0 || r.realized === 1) {
      cell.n_trades++;
      cell.n_wins += r.realized;
    }
  }
  return Array.from(acc.values()).map(c => ({
    ...c,
    predicted_avg: c.n_signals ? c.sum_pred / c.n_signals : null,
    realized_wr:   c.n_trades  ? c.n_wins  / c.n_trades  : null,
    gap:           (c.n_trades && c.n_signals)
      ? (c.n_wins / c.n_trades) - (c.sum_pred / c.n_signals)
      : null,
  }));
}

// Pure: given an ordered (most-recent-first) array of past audit rows for a
// SINGLE bucket, return true iff the most-recent FLAG_REQUIRED_DAYS rows all
// have |gap| > GAP_THRESHOLD. Used by the metaReview suggestion trigger.
function isBucketChronicallyMiscalibrated(rowsDesc, requiredDays = FLAG_REQUIRED_DAYS, threshold = GAP_THRESHOLD) {
  if (!Array.isArray(rowsDesc) || rowsDesc.length < requiredDays) return false;
  for (let i = 0; i < requiredDays; i++) {
    const g = rowsDesc[i] && rowsDesc[i].gap;
    if (!Number.isFinite(parseFloat(g))) return false;
    if (Math.abs(parseFloat(g)) <= threshold) return false;
  }
  return true;
}

async function _gatherSignalRows({ market, since }) {
  const tz = market === 'ASX' ? 'Australia/Sydney' : 'America/New_York';
  // Pull all SIGNAL rows in window. Each carries `confidence`. The realized
  // outcome is looked up from trade_memory by symbol+date — only rows that
  // produced an executed trade can have a win/loss attribution. Signals that
  // never traded (HOLD, gated, rejected) count toward n_signals but not
  // n_trades / n_wins.
  const sigs = await db.query(`
    SELECT id, symbol, decision, confidence, created_at
    FROM audit_log
    WHERE event_type = 'SIGNAL'
      AND created_at >= $1
      AND confidence IS NOT NULL
  `, [since]);

  const trades = await db.query(`
    SELECT symbol, won, created_at, market
    FROM trade_memory
    WHERE created_at >= $1
      AND market = $2
  `, [since, market]);

  // Naive same-day attribution: a SIGNAL is realized = the FIRST trade_memory
  // row for that symbol on the same trading day in the same market. This is
  // intentionally simple — calibration is a TREND signal, not a per-trade
  // accounting layer (the audit chain remains the source of truth).
  const tradeBySymDay = new Map();
  for (const t of trades.rows) {
    const day = new Date(t.created_at).toISOString().slice(0, 10);
    const k = `${t.symbol}::${day}`;
    if (!tradeBySymDay.has(k)) tradeBySymDay.set(k, t.won ? 1 : 0);
  }
  return sigs.rows.map(s => {
    const day = new Date(s.created_at).toISOString().slice(0, 10);
    const k = `${s.symbol}::${day}`;
    const realized = tradeBySymDay.has(k) ? tradeBySymDay.get(k) : null;
    return { predicted: parseFloat(s.confidence), realized };
  });
}

// Run today's calibration audit, persist the per-bucket rows, and return a
// summary the meta-review prompt can render. ALWAYS best-effort — any DB
// failure returns ok:false instead of throwing so the daily report is
// never broken by a calibration hiccup.
async function runDailyCalibrationAudit({ market = 'US' } = {}) {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000); // last 24h
    const today = new Date().toISOString().slice(0, 10);
    const rows = await _gatherSignalRows({ market, since });
    const agg = bucketAggregates(rows);
    // Persist (UPSERT — re-running the audit on the same day overwrites).
    for (const b of agg) {
      await db.query(`
        INSERT INTO calibration_history
          (market, audit_date, bucket_low, bucket_high, n_signals, n_trades, n_wins, predicted_avg, realized_wr, gap, flagged)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (market, audit_date, bucket_low, bucket_high) DO UPDATE SET
          n_signals = EXCLUDED.n_signals,
          n_trades  = EXCLUDED.n_trades,
          n_wins    = EXCLUDED.n_wins,
          predicted_avg = EXCLUDED.predicted_avg,
          realized_wr   = EXCLUDED.realized_wr,
          gap           = EXCLUDED.gap,
          flagged       = EXCLUDED.flagged
      `, [market, today, b.bucket_low, b.bucket_high,
          b.n_signals, b.n_trades, b.n_wins,
          b.predicted_avg, b.realized_wr, b.gap,
          (b.gap != null && Math.abs(b.gap) > GAP_THRESHOLD)]);
    }
    // Look back N days per bucket to detect chronic miscalibration.
    const flaggedBuckets = [];
    for (const b of agg) {
      const hist = await db.query(`
        SELECT gap FROM calibration_history
        WHERE market = $1 AND bucket_low = $2 AND bucket_high = $3
        ORDER BY audit_date DESC
        LIMIT $4
      `, [market, b.bucket_low, b.bucket_high, FLAG_REQUIRED_DAYS]);
      if (isBucketChronicallyMiscalibrated(hist.rows)) {
        flaggedBuckets.push({
          bucket: `${(b.bucket_low*100).toFixed(0)}-${(b.bucket_high*100).toFixed(0)}%`,
          recent_gap: b.gap, predicted_avg: b.predicted_avg, realized_wr: b.realized_wr,
        });
      }
    }
    return {
      ok: true,
      market, audit_date: today,
      buckets: agg,
      flagged_buckets: flaggedBuckets,
      gap_threshold: GAP_THRESHOLD,
      flag_required_days: FLAG_REQUIRED_DAYS,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Render the audit as a Discord-friendly markdown table for posting alongside
// the meta-review suggestions. Pure — never touches the DB.
function renderCalibrationMarkdown(audit) {
  if (!audit || !audit.ok) return '';
  const lines = [
    '',
    '📊 **Calibration Audit (today)**',
    '`bucket  signals trades  win%  pred%   gap`',
  ];
  for (const b of audit.buckets) {
    const pct = (n) => n == null ? ' n/a' : `${(n*100).toFixed(0)}%`;
    const gap = b.gap == null ? ' n/a' : `${b.gap >= 0 ? '+' : ''}${(b.gap*100).toFixed(0)}pp`;
    const flag = (b.gap != null && Math.abs(b.gap) > GAP_THRESHOLD) ? ' ⚠️' : '';
    lines.push(`\`${(b.bucket_low*100).toFixed(0)}-${(b.bucket_high*100).toFixed(0)}%   ${String(b.n_signals).padStart(5)}  ${String(b.n_trades).padStart(5)}  ${pct(b.realized_wr).padStart(4)}  ${pct(b.predicted_avg).padStart(5)}  ${gap.padStart(5)}\`${flag}`);
  }
  if (audit.flagged_buckets && audit.flagged_buckets.length) {
    lines.push(`⚠️ **Chronically miscalibrated** (${audit.flag_required_days}+ consecutive days |gap|>${(audit.gap_threshold*100).toFixed(0)}pp): ${audit.flagged_buckets.map(f => f.bucket).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  runDailyCalibrationAudit,
  renderCalibrationMarkdown,
  // pure helpers exported for tests
  assignBucket,
  bucketAggregates,
  isBucketChronicallyMiscalibrated,
  BUCKETS, GAP_THRESHOLD, FLAG_REQUIRED_DAYS,
};
