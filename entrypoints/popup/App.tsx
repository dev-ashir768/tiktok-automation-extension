import { useEffect, useState } from "react";
import "./popup.css";

type ActivationState = {
  apiKey: string | null;
  user: { id: number; email: string; name: string | null } | null;
  apiBase: string;
  status: "IDLE" | "RUNNING";
  sentToday: number;
};

export default function App() {
  const [state, setState] = useState<ActivationState | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = () =>
    chrome.runtime.sendMessage({ type: "GET_ACTIVATION" }, (r: ActivationState) => setState(r));

  useEffect(() => { refresh(); }, []);

  const flash = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 3500);
  };

  const activate = () => {
    if (!keyInput.trim()) return flash("err", "API key dalo pehle");
    setBusy(true);
    chrome.runtime.sendMessage({ type: "ACTIVATE", apiKey: keyInput.trim() }, (r: any) => {
      setBusy(false);
      if (r?.ok) {
        setKeyInput("");
        flash("ok", `Welcome, ${r.user.email}`);
        refresh();
      } else {
        flash("err", r?.error || "Activation failed");
      }
    });
  };

  const deactivate = () => {
    if (!confirm("Deactivate karna chahte ho? API key clear ho jayegi.")) return;
    chrome.runtime.sendMessage({ type: "DEACTIVATE" }, () => {
      flash("ok", "Deactivated");
      refresh();
    });
  };

  const openPartner = () =>
    chrome.tabs.create({ url: "https://partner.us.tiktokshop.com/affiliate-cmp/creator" });

  if (!state) {
    return <div className="popup"><div className="body">Loading…</div></div>;
  }

  const activated = !!state.user;
  const initial = state.user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="popup">
      <header className="popup-header">
        <div className="brand">
          <div className="brand-mark">⚡</div>
          <div className="brand-text">
            <h1>TT Auto-Messenger</h1>
            <p className={activated ? "active" : ""}>
              {activated ? "● Connected" : "Not activated"}
            </p>
          </div>
        </div>
      </header>

      <div className="body">
        {!activated ? (
          <>
            <div className="activate-hero">
              <div className="icon">🔑</div>
              <h2>Activate Extension</h2>
              <p>Apni API key daalo to start sending bulk messages on TikTok Shop Partner.</p>
            </div>

            <label className="field-label">API Key</label>
            <input
              className="token-input"
              type="password"
              placeholder="ttp_xxxxxxxxxxxxxxxxxxxxxxxx"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && activate()}
              autoFocus
            />

            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={activate} disabled={busy}>
                {busy ? (<><span className="spinner" /> Activating…</>) : "Activate"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="user-card">
              <div className="user-avatar">{initial}</div>
              <div className="user-info">
                <div className="email">{state.user!.email}</div>
                <div className="status">
                  <span className="live-dot" /> Active
                </div>
              </div>
            </div>

            <div className="stats-row">
              <div className="stat">
                <div className="stat-label">Sent today</div>
                <div className="stat-value">{state.sentToday.toLocaleString()}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Campaign</div>
                <div className={`stat-value ${state.status === "RUNNING" ? "running" : ""}`}>
                  {state.status === "RUNNING" ? "● Running" : "Idle"}
                </div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={openPartner}>
              Open Find Creators →
            </button>

            <button className="btn btn-text" onClick={deactivate}>
              Deactivate
            </button>
          </>
        )}
      </div>

      <div className="credit">
        Built by <a href="https://ashirarif.com" target="_blank" rel="noreferrer">Ashir</a>
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <span>{toast.kind === "ok" ? "✓" : "✕"}</span> {toast.text}
        </div>
      )}
    </div>
  );
}
