Paper Trading Kill Criteria — Phase B Observation Window
Committed: 2026-05-08
Window: 14 trading days from first cycle after Phase B deploy
Decision date: 2026-05-22 (or earlier if hard stop triggered)
Hard stops — pause immediately, investigate before resuming
	1.	Drawdown breach. Account equity drops more than 8% from baseline at any point.
	2.	Auto-suspend cluster. 3+ symbols auto-suspend in any single trading day, OR 5+ within the first week.
	3.	Calibration failure. Any confidence bucket shows >20pp divergence between stated and actual win rate over ≥20 trades.
	4.	Quorum-fail rate spike. More than 30% of Council deliberations return council-failure HOLD.
	5.	Audit chain break. verifyAuditChain() returns false at any point.
Soft stops — pause and review at end of day
	6.	Win rate cliff. Daily win rate below 35% on 2+ consecutive days with ≥10 trades each.
	7.	Cost overrun. Daily LLM cost exceeds $15.
	8.	No regime adjustments fired. After a full week, dynamic_gate_state shows zero regime-driven adjustments.
	9.	Cache hit rate <20%. After day 3, /api/hybrid/cache-stats shows hit rate below 20%.
Go-live conditions (all required after 2-week window)
	•	Win rate ≥48% over full 2 weeks (≥150 trades)
	•	Expectancy positive (winners × avgWin > losers × avgLoss)
	•	Maximum single-day drawdown <4%
	•	Zero hard stops triggered
	•	≤1 soft stop triggered and resolved with explainable cause
	•	Calibration divergence <10pp on highest-confidence buckets (0.80+)
	•	Operator can explain system behaviour on at least 5 sampled trades
If all seven true → consider live with 50% sizing for another 2-week observation window. Not full size.
If any one false → extend paper for another week, investigate, decide whether to re-baseline.
Commitment
I commit to honouring these criteria. If a hard stop triggers, I will not "give it one more day". I will pause, investigate, and document the cause before resuming.
The kindest thing I can do for future-me is constrain present-me.
— Operator signature: ____________________
