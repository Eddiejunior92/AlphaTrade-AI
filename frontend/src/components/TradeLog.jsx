import { useState, useEffect } from 'react';
import { currencySymbolForMarket } from '../lib/markets';

// Inline feedback control for closed (SELL with pnl) trades. Sends a 1-5
// star rating + optional comment to POST /api/trades/:id/feedback. Posts
// optimistically and shows a "rated" pill on success. Strictly informational
// — the trading loop's quorum + confidence gate are NEVER relaxed by user
// feedback (see backend/services/feedbackService.js for the safety contract).
function FeedbackControl({ tradeId, alreadyRated, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(alreadyRated);
  if (done) {
    return <div className="text-[9px] text-[var(--text-dim)] mt-0.5">✓ rated</div>;
  }
  if (!open) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="text-[10px] text-[var(--text-dim)] hover:text-[var(--blue)] mt-0.5 transition">
        rate trade
      </button>
    );
  }
  const submit = async () => {
    if (busy) return;
    if (!rating && !comment.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/trades/${tradeId}/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: rating || null, comment: comment.trim() || null }),
      });
      const j = await r.json();
      if (j.ok) { setDone(true); setOpen(false); onSubmit?.(j); }
      else alert(j.error || 'feedback failed');
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-1.5 p-2 rounded-lg bg-[var(--surface)] border border-white/5 space-y-1.5"
         onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => setRating(n)}
            className={`text-[14px] leading-none transition ${rating >= n ? 'text-[var(--yellow)]' : 'text-[var(--text-dim)]/40 hover:text-[var(--text-dim)]'}`}>
            ★
          </button>
        ))}
        <span className="ml-1 text-[10px] text-[var(--text-dim)]">{rating ? `${rating}/5` : 'tap to rate'}</span>
      </div>
      <input type="text" value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder="optional: too aggressive, wrong regime, good entry…"
        className="w-full text-[11px] px-2 py-1 rounded bg-black/20 border border-white/10 outline-none focus:border-[var(--blue)]/40" />
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={busy || (!rating && !comment.trim())}
          className="text-[10px] px-2 py-0.5 rounded bg-[var(--blue)]/20 text-[var(--blue)] disabled:opacity-30">
          {busy ? 'sending…' : 'submit'}
        </button>
        <button onClick={() => setOpen(false)} className="text-[10px] text-[var(--text-dim)]">cancel</button>
      </div>
    </div>
  );
}

export default function TradeLog({ trades = [], marketOf }) {
  const [ratedIds, setRatedIds] = useState(() => new Set());
  // Hydrate which trade ids the user already rated so the row shows ✓ rated.
  // Re-hydrate when the *set* of trade ids changes — not just the length —
  // so a swap-out of trades (same count, different ids) still refreshes.
  const tradeIdKey = trades.map(t => t.id).join(',');
  useEffect(() => {
    fetch('/api/feedback/recent?limit=500').then(r => r.json()).then(j => {
      if (Array.isArray(j?.rows)) setRatedIds(new Set(j.rows.map(r => r.trade_id)));
    }).catch(() => {});
  }, [tradeIdKey]);
  if (!trades.length) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-2 opacity-40">📜</div>
        <div className="text-sm text-[var(--text-dim)]">No trades yet</div>
        <div className="text-[11px] text-[var(--text-dim)] mt-1">Trades will appear here once Alpha finds a high-conviction signal</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {trades.map(t => {
        const market = t.market || (marketOf ? marketOf(t.symbol) : 'US');
        const sym = currencySymbolForMarket(market);
        // P&L is stored in USD (the daily-loss budget is USD), so we always
        // print it with `$` regardless of the row's market — the market badge
        // already tells the operator which exchange the trade hit.
        const pnl = (t.pnl !== null && t.pnl !== undefined && t.pnl !== '') ? parseFloat(t.pnl) : null;
        const isBuy = t.side === 'BUY';
        const fx = t.fx_rate ? parseFloat(t.fx_rate) : null;
        return (
          <div key={t.id} className="glass p-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold ${
                isBuy ? 'bg-[var(--green)]/15 text-[var(--green)]' : 'bg-[var(--red)]/15 text-[var(--red)]'
              }`}>{isBuy ? '↑' : '↓'}</div>
              <div>
                <div className="font-semibold text-[14px] flex items-center gap-1.5">
                  {t.side} {parseFloat(t.qty).toFixed(0)} {t.symbol}
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    market === 'ASX' ? 'bg-[var(--purple)]/20 text-[var(--purple)]' : 'bg-[var(--blue)]/20 text-[var(--blue)]'
                  }`}>{market}</span>
                </div>
                <div className="text-[11px] text-[var(--text-dim)]">
                  {sym}{parseFloat(t.price).toFixed(2)} {t.currency || ''}
                  {fx && market === 'ASX' && (
                    <span className="ml-1.5 opacity-70">· fx {fx.toFixed(4)}</span>
                  )}
                  <span className="ml-1.5">· {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              {pnl !== null && (
                <div className={`text-[14px] font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                  <span className="ml-1 text-[9px] font-medium text-[var(--text-dim)]">USD</span>
                </div>
              )}
              <div className="text-[10px] text-[var(--text-dim)] capitalize">
                {t.confidence ? `${(parseFloat(t.confidence) * 100).toFixed(0)}% · ` : ''}{t.status}
              </div>
              {/* Closed trades (SELL with realised P&L) get an inline rating
                  control so the user can teach the agent which trades were
                  actually good. Strictly informational — see safety contract. */}
              {!isBuy && pnl !== null && (
                <FeedbackControl tradeId={t.id} alreadyRated={ratedIds.has(t.id)}
                  onSubmit={() => setRatedIds(new Set([...ratedIds, t.id]))} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
