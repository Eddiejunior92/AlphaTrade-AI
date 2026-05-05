// Human-in-the-Loop Feedback & Fine-Tuning Layer.
//
// What it does:
//   1. Captures user feedback on closed trades — a 1-5 star rating, a free-
//      text comment, or both — and derives a small set of tags from the
//      comment (e.g. 'too_aggressive', 'wrong_regime', 'good_timing').
//   2. Mines that feedback into three calibration signals fed back into the
//      decision loop:
//        a. Per-model FEEDBACK BIAS — for each (strategy, regime, market),
//           which voting models tended to be on the YES side of trades the
//           USER rated negatively? Those models get a small downward weight
//           nudge; the inverse for positively-rated trades. Bounded to
//           [0.85, 1.10] — small, conservative, multiplicative on top of
//           the dynamic weight already set by realised P&L.
//        b. CONFIDENCE SHRINKAGE — if the user is consistently rating high-
//           confidence trades worse than low-confidence trades for a given
//           (strategy, regime, market), the model is overconfident → shrink
//           reported confidence by a factor in [0.85, 1.00]. NEVER > 1.0:
//           this layer can ONLY tighten the gate, never loosen it.
//        c. PROMPT NUDGE — a compact "USER FEEDBACK — N rated trades, avg
//           2.4/5, common: too_aggressive ×8" block injected into every LLM
//           voter's prompt so the model is aware of the human signal.
//
// Safety contract (identical pattern to dynamic-weighting + meta-reasoner +
// causal/counterfactual/memory/propagation layers):
//   STRICTLY INFORMATIONAL → INFORMATIONAL TIGHTENING ONLY. This layer:
//     • Writes only to its own `trade_feedback` table.
//     • Returns prompt-injection text + bounded multipliers fed into the
//       EXISTING `min(rawAvgConfidence, weightedConfidence, ...)` gate so
//       it can ONLY make the gate stricter, never relax it.
//     • Bias multipliers feed `llmWeightingService.getWeights` AFTER the
//       realised-P&L-driven weights are computed and BEFORE renormalisation,
//       so the rebalanced sum is preserved (Σweights = N models). This means
//       a per-model bias just rebalances among models, never lifts the
//       absolute weighted-confidence sum.
//     • Cannot touch the risk manager, quorum, breakers, kill switch,
//       trailing-stop ratchet, no-averaging-in rule, daily loss budget,
//       drawdown circuit breaker, per-tier conf floor.
//   Every failure (DB, mining, render) swallows silently — feedback hiccups
//   cannot break the trading loop.

const db = require('./db');

const KNOWN_MODELS = ['gemini', 'claude', 'gpt4o', 'grok'];
// Bounds — kept deliberately tight. The realised-P&L weighting layer is the
// PRIMARY driver of model weights; user feedback is a small secondary nudge.
const MODEL_BIAS_FLOOR = 0.85;
const MODEL_BIAS_CEIL  = 1.10;
const CONF_SHRINK_FLOOR = 0.85;
const CONF_SHRINK_CEIL  = 1.00;
const MIN_FEEDBACK_FOR_BIAS = 4;        // need ≥4 rated trades in bucket
const MIN_FEEDBACK_FOR_SHRINK = 6;      // need ≥6 rated trades to calibrate
const HIGH_CONF_THRESH = 0.85;          // matches the existing gate threshold
const CACHE_TTL_MS = 5 * 60 * 1000;     // 5 min — feedback changes slowly

let _calibrationCache = null;
let _calibrationLoadedAt = 0;
let _calibrationInFlight = null;
// Generation counter — bumped whenever feedback is recorded. The mining
// task captures the generation at start; if it changes before the task
// resolves, the cache write is rejected so the next reader re-mines with
// the new feedback included. Closes the cache-bust race architect flagged.
let _calibrationGen = 0;

// ----- Sentiment + tag derivation ------------------------------------------
//
// Lightweight string-matching tag extractor. Keeps the layer self-contained
// (no extra LLM call). Tags are intentionally a small whitelist so prompt
// summaries stay tight.
const TAG_PATTERNS = [
  ['too_aggressive',  /\b(too aggressive|over[ -]?sized|too big|sized too|risky|too risky|reckless)\b/i],
  ['too_passive',     /\b(too passive|too small|under[ -]?sized|should[' ]?ve gone bigger|sized too small)\b/i],
  ['too_late',        /\b(too late|late entry|missed entry|chased|chasing)\b/i],
  ['too_early',       /\b(too early|early entry|premature|jumped in)\b/i],
  ['wrong_regime',    /\b(wrong regime|regime call|wrong market|misread market)\b/i],
  ['wrong_sector',    /\b(wrong sector|wrong industry|sector wrong)\b/i],
  ['good_entry',      /\b(good entry|nice entry|great entry|good timing|nice timing|well timed)\b/i],
  ['good_exit',       /\b(good exit|nice exit|great exit|locked in|let it run)\b/i],
  ['bad_exit',        /\b(bad exit|exit too soon|cut too soon|stopped out|gave back)\b/i],
  ['stop_too_tight',  /\b(stop too tight|tight stop|stopped early)\b/i],
  ['stop_too_wide',   /\b(stop too wide|wide stop|too much risk)\b/i],
  ['news_missed',     /\b(missed news|didn[' ]?t see news|news catalyst)\b/i],
  ['fundamentals_bad',/\b(bad fundamentals|weak earnings|poor balance sheet)\b/i],
];

function _deriveTags(comment) {
  if (!comment || typeof comment !== 'string') return [];
  const out = new Set();
  for (const [tag, re] of TAG_PATTERNS) if (re.test(comment)) out.add(tag);
  return [...out];
}

function _deriveSentiment({ rating, comment, tags }) {
  if (Number.isFinite(rating)) {
    if (rating >= 4) return 'good';
    if (rating <= 2) return 'bad';
    return 'neutral';
  }
  // Tag-based fallback when only a comment was given.
  const positive = ['good_entry', 'good_exit'];
  const negative = ['too_aggressive', 'too_late', 'too_early', 'wrong_regime', 'wrong_sector', 'bad_exit', 'stop_too_tight', 'stop_too_wide', 'news_missed', 'fundamentals_bad'];
  const hasPos = tags.some(t => positive.includes(t));
  const hasNeg = tags.some(t => negative.includes(t));
  if (hasNeg && !hasPos) return 'bad';
  if (hasPos && !hasNeg) return 'good';
  return 'neutral';
}

// ----- Public: write a feedback row -----------------------------------------

async function recordFeedback({ tradeId, rating = null, comment = null }) {
  const id = parseInt(tradeId, 10);
  if (!Number.isFinite(id)) throw new Error('tradeId required');
  let r = null;
  if (rating !== null && rating !== undefined && rating !== '') {
    r = parseInt(rating, 10);
    if (!Number.isFinite(r) || r < 1 || r > 5) throw new Error('rating must be 1..5');
  }
  const cmt = (comment && typeof comment === 'string') ? comment.trim().slice(0, 1000) : null;
  if (r === null && !cmt) throw new Error('rating or comment required');
  // Verify trade exists (FK would catch it but explicit error is friendlier).
  const tradeRow = await db.query('SELECT id, side, pnl FROM trades WHERE id = $1', [id]);
  if (!tradeRow.rows.length) throw new Error(`trade ${id} not found`);
  const tags = _deriveTags(cmt);
  const sentiment = _deriveSentiment({ rating: r, comment: cmt, tags });
  const ins = await db.query(`
    INSERT INTO trade_feedback (trade_id, rating, sentiment, comment, tags)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at
  `, [id, r, sentiment, cmt, tags]);
  // Bust calibration cache AND bump the generation counter so any in-flight
  // mine started before this insert is rejected on completion (architect
  // race-fix). The next reader will start a fresh mine that includes this row.
  _calibrationCache = null;
  _calibrationLoadedAt = 0;
  _calibrationGen += 1;
  return { id: ins.rows[0].id, created_at: ins.rows[0].created_at, rating: r, sentiment, tags };
}

async function recentFeedback({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
  const { rows } = await db.query(`
    SELECT f.id, f.trade_id, f.rating, f.sentiment, f.comment, f.tags, f.created_at,
           t.symbol, t.side, t.pnl, t.strategy, t.market, t.confidence
    FROM trade_feedback f
    JOIN trades t ON t.id = f.trade_id
    ORDER BY f.created_at DESC LIMIT $1
  `, [lim]);
  return rows;
}

// ----- Calibration mining ---------------------------------------------------
//
// One pass over recent feedback rows joined to their trade + originating BUY
// SIGNAL audit (for the per-model votes + regime). Builds three lookup
// tables keyed by `${strategy}|${regime}|${market}`:
//   • modelBias[bucket][modelId]  → multiplier in [0.85, 1.10]
//   • confShrinkage[bucket]       → factor in [0.85, 1.00]  (always ≤ 1.0)
//   • promptNudge[bucket]         → { count, avgRating, topTags, sentRatio }

async function _loadCalibration() {
  if (_calibrationCache && Date.now() - _calibrationLoadedAt < CACHE_TTL_MS) {
    return _calibrationCache;
  }
  if (_calibrationInFlight) return _calibrationInFlight;
  const startGen = _calibrationGen;
  _calibrationInFlight = (async () => {
    try {
      const { rows: feedback } = await db.query(`
        SELECT f.rating, f.sentiment, f.tags, f.created_at,
               t.id as trade_id, t.symbol, t.side, t.pnl, t.strategy, t.market,
               t.confidence, t.created_at as trade_at
        FROM trade_feedback f
        JOIN trades t ON t.id = f.trade_id
        WHERE t.side='SELL' AND t.pnl IS NOT NULL
        ORDER BY f.created_at DESC LIMIT 500
      `);
      // For each rated SELL, find the ORIGINATING BUY SIGNAL audit (architect
      // attribution-fix). Anchor on the BUY trade itself: most-recent BUY
      // trade for the same symbol+strategy strictly before the SELL. Then
      // pick the SIGNAL audit with action=BUY closest to (and ≤) that BUY's
      // timestamp. This avoids the previous bug where the nearest SIGNAL
      // before the SELL was often an exit/hold signal, not the entry.
      const buckets = new Map();
      for (const fb of feedback) {
        const strat = fb.strategy || 'day';
        const market = fb.market || 'US';
        // Step A — find the originating BUY trade row.
        const { rows: buyRows } = await db.query(`
          SELECT created_at FROM trades
          WHERE side='BUY' AND symbol=$1 AND strategy=$2 AND created_at < $3
          ORDER BY created_at DESC LIMIT 1
        `, [fb.symbol, strat, fb.trade_at]);
        if (!buyRows.length) continue;     // orphan SELL with no matching BUY — skip
        const buyAt = buyRows[0].created_at;
        // Step B — find the SIGNAL audit row with action=BUY at or just
        // before that BUY trade's timestamp. 60s back-window covers the
        // signal→trade execution gap.
        const { rows: sigRows } = await db.query(`
          SELECT payload FROM audit_log
          WHERE event_type='SIGNAL' AND symbol=$1
            AND payload->>'strategy' = $2
            AND payload->>'action' = 'BUY'
            AND created_at <= $3 AND created_at >= ($3 - INTERVAL '120 seconds')
          ORDER BY created_at DESC LIMIT 1
        `, [fb.symbol, strat, buyAt]);
        const payload = sigRows[0]?.payload || {};
        const regime = (typeof payload.regime === 'object' ? payload.regime?.primary : payload.regime) || 'unknown';
        const key = `${strat}|${regime}|${market}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            strategy: strat, regime, market,
            ratings: [], sentiments: { good: 0, bad: 0, neutral: 0 },
            tagCounts: new Map(),
            votes: Object.fromEntries(KNOWN_MODELS.map(m => [m, { good: 0, bad: 0 }])),
            highConfRatings: [], lowConfRatings: [],
          };
          buckets.set(key, bucket);
        }
        if (Number.isFinite(fb.rating)) bucket.ratings.push(fb.rating);
        bucket.sentiments[fb.sentiment] += 1;
        for (const t of (fb.tags || [])) bucket.tagCounts.set(t, (bucket.tagCounts.get(t) || 0) + 1);
        // Per-model attribution: which models voted BUY at this SIGNAL?
        const models = Array.isArray(payload.models) ? payload.models : [];
        for (const m of models) {
          if (!m || m.error || m.action !== 'BUY') continue;
          const mid = m.model;
          if (!bucket.votes[mid]) bucket.votes[mid] = { good: 0, bad: 0 };
          if (fb.sentiment === 'good') bucket.votes[mid].good += 1;
          else if (fb.sentiment === 'bad') bucket.votes[mid].bad += 1;
        }
        // Confidence calibration: split by entry confidence vs the gate
        // threshold so we can detect overconfidence.
        const entryConf = parseFloat(fb.confidence);
        if (Number.isFinite(entryConf) && Number.isFinite(fb.rating)) {
          if (entryConf >= HIGH_CONF_THRESH) bucket.highConfRatings.push(fb.rating);
          else bucket.lowConfRatings.push(fb.rating);
        }
      }

      // Reduce buckets to compact calibration objects.
      const modelBias = new Map();
      const confShrink = new Map();
      const promptNudge = new Map();
      for (const [key, b] of buckets.entries()) {
        const totalRatings = b.ratings.length;
        const avgRating = totalRatings ? (b.ratings.reduce((a, c) => a + c, 0) / totalRatings) : null;
        const topTags = [...b.tagCounts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4);
        const totalSent = b.sentiments.good + b.sentiments.bad + b.sentiments.neutral;
        promptNudge.set(key, {
          strategy: b.strategy, regime: b.regime, market: b.market,
          count: totalSent, avgRating: avgRating === null ? null : +avgRating.toFixed(2),
          good: b.sentiments.good, bad: b.sentiments.bad, neutral: b.sentiments.neutral,
          topTags: topTags.map(([t, n]) => ({ tag: t, n })),
        });

        // Per-model bias: signal = (good - bad) / (good + bad). Clipped &
        // mapped to [0.85, 1.10]. Requires ≥MIN_FEEDBACK_FOR_BIAS samples.
        if (totalSent >= MIN_FEEDBACK_FOR_BIAS) {
          const perModel = {};
          for (const m of KNOWN_MODELS) {
            const v = b.votes[m] || { good: 0, bad: 0 };
            const denom = v.good + v.bad;
            if (denom < MIN_FEEDBACK_FOR_BIAS) { perModel[m] = 1.0; continue; }
            const sig = (v.good - v.bad) / denom;            // -1..+1
            const span = MODEL_BIAS_CEIL - 1.0;              // symmetric around 1.0
            perModel[m] = +Math.max(MODEL_BIAS_FLOOR, Math.min(MODEL_BIAS_CEIL, 1.0 + sig * span)).toFixed(3);
          }
          modelBias.set(key, perModel);
        }

        // Confidence shrinkage: if avg rating of HIGH-conf trades is
        // meaningfully WORSE than low-conf, shrink. Mapped from gap → factor:
        //   gap=0    → 1.00 (no change)
        //   gap=2.0  → 0.85 (max shrink)
        // Requires both halves to have ≥3 samples and total ≥MIN_FEEDBACK_FOR_SHRINK.
        const hi = b.highConfRatings, lo = b.lowConfRatings;
        if (hi.length >= 3 && lo.length >= 3 && (hi.length + lo.length) >= MIN_FEEDBACK_FOR_SHRINK) {
          const hiAvg = hi.reduce((a, c) => a + c, 0) / hi.length;
          const loAvg = lo.reduce((a, c) => a + c, 0) / lo.length;
          const gap = loAvg - hiAvg;     // positive = high-conf trades are worse → overconfident
          if (gap > 0) {
            const shrinkRange = 1.0 - CONF_SHRINK_FLOOR;     // 0.15
            const factor = Math.max(CONF_SHRINK_FLOOR, 1.0 - Math.min(2.0, gap) / 2.0 * shrinkRange);
            confShrink.set(key, +Math.min(CONF_SHRINK_CEIL, factor).toFixed(3));
          } else {
            confShrink.set(key, 1.0);  // user is rating high-conf trades as good or equal — no shrink
          }
        }
      }

      const result = { modelBias, confShrink, promptNudge, totalFeedback: feedback.length, computedAt: Date.now() };
      // Race guard — only write to cache if no new feedback arrived during
      // mining. If it did, leave the cache empty so the next reader re-mines.
      if (_calibrationGen === startGen) {
        _calibrationCache = result;
        _calibrationLoadedAt = Date.now();
      }
      return result;
    } catch (e) {
      console.warn('[Feedback] calibration mine failed:', e.message);
      const errResult = { modelBias: new Map(), confShrink: new Map(), promptNudge: new Map(), totalFeedback: 0, computedAt: Date.now(), error: e.message };
      if (_calibrationGen === startGen) {
        _calibrationCache = errResult;
        _calibrationLoadedAt = Date.now();
      }
      return errResult;
    } finally { _calibrationInFlight = null; }
  })();
  return _calibrationInFlight;
}

// Public: per-model multiplier nudge for a (strategy, regime, market) bucket.
// Returns { gemini: 1.0, claude: 0.92, ... } or all-1.0 when no calibration.
async function getModelBias({ strategy, regime, market }) {
  const cal = await _loadCalibration();
  const reg = regime?.primary || regime || 'unknown';
  const key = `${strategy || 'day'}|${reg}|${market || 'US'}`;
  const found = cal.modelBias.get(key);
  if (found) return found;
  // Fallback to all-1.0 (no nudge).
  return Object.fromEntries(KNOWN_MODELS.map(m => [m, 1.0]));
}

// Public: confidence shrinkage factor in [0.85, 1.00] — caller must apply
// via min(currentConf, currentConf * factor). Always ≤ 1.0 by contract.
async function getConfidenceShrinkage({ strategy, regime, market }) {
  const cal = await _loadCalibration();
  const reg = regime?.primary || regime || 'unknown';
  const key = `${strategy || 'day'}|${reg}|${market || 'US'}`;
  const f = cal.confShrink.get(key);
  return Number.isFinite(f) ? Math.min(CONF_SHRINK_CEIL, Math.max(CONF_SHRINK_FLOOR, f)) : 1.0;
}

// Public: pre-rendered prompt block. Returns null when no feedback in bucket.
async function renderForPrompt({ strategy, regime, market }) {
  try {
    const cal = await _loadCalibration();
    const reg = regime?.primary || regime || 'unknown';
    const key = `${strategy || 'day'}|${reg}|${market || 'US'}`;
    const n = cal.promptNudge.get(key);
    if (!n || n.count < 1) return null;
    const lines = [
      `USER FEEDBACK — ${n.count} rated trade${n.count === 1 ? '' : 's'} for ${n.strategy} / ${n.regime} / ${n.market}:`,
      `  • avg rating ${n.avgRating ?? 'n/a'}/5  ·  good ${n.good}  ·  bad ${n.bad}  ·  neutral ${n.neutral}`,
    ];
    if (n.topTags.length) {
      lines.push(`  • common tags: ${n.topTags.map(t => `${t.tag}×${t.n}`).join(', ')}`);
    }
    lines.push(`  → Use as priors when calibrating conviction. Quorum + confidence gate retain full veto power.`);
    return lines.join('\n');
  } catch (_) { return null; }
}

async function getDashboardSummary() {
  const cal = await _loadCalibration();
  const buckets = [];
  for (const [key, n] of cal.promptNudge.entries()) {
    buckets.push({
      key,
      strategy: n.strategy, regime: n.regime, market: n.market,
      count: n.count, avgRating: n.avgRating, good: n.good, bad: n.bad, neutral: n.neutral,
      topTags: n.topTags,
      modelBias: cal.modelBias.get(key) || null,
      confShrinkage: cal.confShrink.get(key) || null,
    });
  }
  buckets.sort((a, b) => b.count - a.count);
  return {
    totalFeedback: cal.totalFeedback,
    computedAt: cal.computedAt,
    buckets,
    bounds: {
      modelBias: [MODEL_BIAS_FLOOR, MODEL_BIAS_CEIL],
      confShrinkage: [CONF_SHRINK_FLOOR, CONF_SHRINK_CEIL],
    },
  };
}

module.exports = {
  recordFeedback, recentFeedback,
  getModelBias, getConfidenceShrinkage, renderForPrompt,
  getDashboardSummary,
  KNOWN_MODELS,
  _internal: { _deriveTags, _deriveSentiment, _loadCalibration },
};
