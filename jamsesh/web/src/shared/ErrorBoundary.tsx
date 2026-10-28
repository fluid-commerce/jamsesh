import { Component, type ReactNode } from "react";

/** One bad component shows a small card instead of blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("JamSesh view crashed", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", minHeight: "40vh", padding: 16 }}>
        <div className="onboard-card" style={{ textAlign: "center", maxWidth: 320 }}>
          <strong>Something went wrong</strong>
          <p style={{ color: "var(--muted)" }}>{this.props.label ?? "This view"} hit a problem.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
