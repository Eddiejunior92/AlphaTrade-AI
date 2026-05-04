import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-3xl bg-white/[0.03] border border-[var(--red)]/30 p-5 text-sm">
          <div className="font-semibold text-[var(--red)] mb-1">Something glitched in this view.</div>
          <div className="text-[11px] text-[var(--text-dim)] mb-3">
            {String(this.state.error?.message || this.state.error).slice(0, 240)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-[11px] font-medium px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 transition"
          >Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
