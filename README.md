# AlphaTrade AI — Autonomous Multi-LLM Trading Agent

**Fully autonomous high-frequency trading system** using a multi-LLM ensemble (Gemini 2.5 Flash + Claude + GPT-4o + **Grok**) with consensus voting, stateful memory, Alpaca brokerage integration, Discord alerts, and iron-clad safety guardrails.

Built from the Phase 1–4 audit. Ready for 24/7 deployment on Replit (or any VPS).

## ⚠️ Important Disclaimers (ASIC / Regulatory Compliance)
- This is **personal-use software only**. Not financial advice.
- Past performance ≠ future results. Use at your own risk.
- Paper trading recommended for at least 30 days before live capital.
- You are solely responsible for any losses.

## Project Structure
AlphaTrade-AI/ ├── backend/ │   ├── services/llmService.js      ← Multi-LLM ensemble (Grok included) │   ├── agent.js │   ├── server.js │   └── package.json ├── frontend/                       ← React dashboard ├── .env.example ├── portfolio.json                  ← gitignored └── README.md
## Quick Start
1. Clone this repo
2. Copy `.env.example` → `.env` and fill in your keys
3. `cd backend && npm install`
4. `node agent.js` (paper trading mode)

Full production deployment instructions coming via Replit Agent.

## Features
- Multi-LLM consensus (Grok as truth & sentiment specialist)
- Stateful portfolio memory
- Hard safety valves + circuit breakers
- Discord mobile push alerts
- React real-time dashboard
- Ready for paper → live Alpaca

Audit date: May 3, 2026