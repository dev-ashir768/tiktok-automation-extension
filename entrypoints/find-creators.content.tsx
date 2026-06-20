import { defineContentScript } from "wxt/sandbox";
import ReactDOM from "react-dom/client";
import React, { useState, useEffect, useRef } from "react";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// Selectors
const CARD_SEL = [
  'tr.arco-table-tr',
  'tr',
  '.arco-table-row',
  '[data-testid^="creator-card"]',
  '[class*="creator-card"]',
  'div[role="row"]'
].join(", ");

function App() {
  const [template, setTemplate] = useState("Hi {name}! Love your content. Let's collaborate!");
  const [status, setStatus] = useState("IDLE"); // IDLE, RUNNING
  const [selectionMode, setSelectionMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<any[]>([]);
  const [alreadyMessaged, setAlreadyMessaged] = useState<Set<string>>(new Set());
  const [failedHandles, setFailedHandles] = useState<Set<string>>(new Set());
  const [activated, setActivated] = useState<boolean>(false);

  const runningRef = useRef(false);
  const selectionModeRef = useRef(selectionMode);
  const selectedHandlesRef = useRef(selectedHandles);
  const alreadyMessagedRef = useRef(alreadyMessaged);
  const failedHandlesRef = useRef(failedHandles);
  const processedCountRef = useRef(0);
  const scrollAttemptsRef = useRef(0);

  useEffect(() => { alreadyMessagedRef.current = alreadyMessaged; }, [alreadyMessaged]);
  useEffect(() => { failedHandlesRef.current = failedHandles; }, [failedHandles]);

  const norm = (h: string) => h.trim().toLowerCase().replace(/^@/, "");

  // Extract the creator HANDLE (not display name) from a row. TT avatar alt is
  // often the display name ("E Lawn Musk"), so we look at all text candidates
  // and pick the one that looks like a handle (alphanumeric + ._-, no spaces).
  const getRowHandle = (row: Element): string | null => {
    const cands: string[] = [];
    const img = row.querySelector("img");
    if (img?.getAttribute("alt")) cands.push(img.getAttribute("alt")!);

    const text = (row as HTMLElement).innerText || "";
    text.split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((s) => cands.push(s));

    // Pick the first candidate that looks like a handle
    for (const c of cands) {
      const cleaned = c.replace(/^@/, "");
      if (/^[a-zA-Z0-9._-]{2,40}$/.test(cleaned) && !/^(invite|message|favorite)$/i.test(cleaned)) {
        return cleaned;
      }
    }
    return cands[0] ?? null;
  };

  // Extract every visible creator handle on the page and ask the backend
  // which ones have already been messaged (globally).
  const refreshAlreadyMessaged = () => {
    const rows = document.querySelectorAll(CARD_SEL);
    const handles = new Set<string>();
    rows.forEach((row) => {
      const h = getRowHandle(row);
      if (!h) return;
      const n = norm(h);
      // Drop empty strings, single chars, and obvious placeholders
      if (n.length < 2) return;
      handles.add(n);
    });
    console.log(`[TT-Auto Dedup] extracted ${handles.size} handles from page:`, Array.from(handles));
    if (handles.size === 0) {
      console.log("[TT-Auto Dedup] no handles found on page — rows not rendered yet?");
      return;
    }
    chrome.runtime.sendMessage(
      { type: "CHECK_MESSAGED_HANDLES", handles: Array.from(handles) },
      (res) => {
        console.log("[TT-Auto Dedup] backend response:", res);
        if (res?.notActivated) {
          console.warn("[TT-Auto Dedup] not activated — dedup disabled");
          return;
        }
        if (res?.error) {
          console.error("[TT-Auto Dedup] backend error:", res.error);
          return;
        }
        if (res?.messaged) {
          setAlreadyMessaged((prev) => {
            const next = new Set(prev);
            for (const h of res.messaged) next.add(h);
            return next;
          });
        }
        if (res?.failed) {
          setFailedHandles((prev) => {
            const next = new Set(prev);
            for (const h of res.failed) next.add(h);
            return next;
          });
        }
      }
    );
  };

  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);

  useEffect(() => {
    selectedHandlesRef.current = selectedHandles;
  }, [selectedHandles]);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
      if (state) {
        if (state.template) setTemplate(state.template);
        if (state.status) {
          setStatus(state.status);
          runningRef.current = state.status === "RUNNING";
        }
        if (state.logs) setLogs(state.logs);
      }
    });

    // Install the window.open hook so we can intercept TT's chat-open and
    // route it through chrome.tabs.create (background) — sidesteps the popup
    // blocker that kills programmatic window.open without a user gesture.
    chrome.runtime.sendMessage({ type: "INSTALL_OPEN_HOOK" }, () => {});

    // Check activation + initial dedup scan
    const refreshActivation = () =>
      chrome.runtime.sendMessage({ type: "GET_ACTIVATION" }, (r) => {
        setActivated(!!r?.user);
      });
    refreshActivation();
    // Re-check whenever the popup updates storage (activate/deactivate)
    const storageListener = (changes: any, area: string) => {
      if (area === "local" && ("apiKey" in changes || "user" in changes)) refreshActivation();
    };
    chrome.storage.onChanged.addListener(storageListener);

    // Aggressive initial dedup — try several times early in case rows
    // are still rendering, then settle into a slower interval.
    setTimeout(refreshAlreadyMessaged, 500);
    setTimeout(refreshAlreadyMessaged, 1500);
    setTimeout(refreshAlreadyMessaged, 3000);
    const dedupInterval = setInterval(refreshAlreadyMessaged, 5000);

    // Also re-run on scroll (TT lazy-loads rows on scroll)
    let scrollTimer: any = null;
    const onScroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(refreshAlreadyMessaged, 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onMessage = (e: MessageEvent) => {
      const data: any = e.data;
      if (data && data.__ttAutoOpen && typeof data.url === "string") {
        chrome.runtime.sendMessage({ type: "OPEN_IM_TAB", url: data.url }, () => {});
      }
    };
    window.addEventListener("message", onMessage);

    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
        if (state?.logs) setLogs(state.logs);
      });
    }, 1000);

    const listener = (msg: any) => {
      if (msg.type === "CONTINUE_NEXT") {
        if (msg.justSentHandle) {
          const h = norm(msg.justSentHandle);
          if (msg.error) {
            // Failed — track separately so user can retry later
            setFailedHandles((prev) => {
              const next = new Set(prev);
              next.add(h);
              return next;
            });
          } else {
            // Successful send — mark globally messaged
            setAlreadyMessaged((prev) => {
              const next = new Set(prev);
              next.add(h);
              return next;
            });
          }
        }
        setTimeout(() => processNextCreator(), rand(3000, 5000));
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    return () => {
      clearInterval(interval);
      clearInterval(dedupInterval);
      window.removeEventListener("scroll", onScroll);
      clearTimeout(scrollTimer);
      chrome.runtime.onMessage.removeListener(listener);
      chrome.storage.onChanged.removeListener(storageListener);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Handle click interception in MANUAL mode
  useEffect(() => {
    const handleEvent = (e: Event) => {
      if (status !== "IDLE" || selectionModeRef.current !== "MANUAL") return;

      const target = e.target as HTMLElement;
      if (target.closest("#tt-auto-messenger-root")) return;

      const row = target.closest(CARD_SEL) as HTMLElement;
      if (row) {
        e.preventDefault();
        e.stopPropagation();

        // Run selection logic on pointerdown or mousedown (if pointer events aren't supported)
        if (e.type === "pointerdown" || e.type === "mousedown") {
          const handle = getRowHandle(row) || "Creator";

          if (alreadyMessagedRef.current.has(norm(handle))) {
            console.log("[TT-Auto] Skipping selection — already messaged:", handle);
            return;
          }
          setSelectedHandles(prev => {
            const next = new Set(prev);
            if (next.has(handle)) {
              next.delete(handle);
            } else {
              next.add(handle);
            }
            return next;
          });
        }
      }
    };

    const events = ["click", "mousedown", "mouseup", "pointerdown", "pointerup"];
    events.forEach(ev => document.addEventListener(ev, handleEvent, true));
    
    return () => {
      events.forEach(ev => document.removeEventListener(ev, handleEvent, true));
    };
  }, [status]);

  // Continuously apply highlight styles — selection outline AND already-messaged dimming
  useEffect(() => {
    const applyStyles = () => {
      const rows = document.querySelectorAll(CARD_SEL);
      rows.forEach(row => {
        const handle = getRowHandle(row) || "Creator";
        const rowEl = row as HTMLElement;
        const isMessaged = alreadyMessagedRef.current.has(norm(handle));
        const isFailed = !isMessaged && failedHandlesRef.current.has(norm(handle));
        const isSelected = selectionModeRef.current === "MANUAL" && selectedHandlesRef.current.has(handle);

        if (isMessaged) {
          rowEl.style.outline = "2px solid #f59e0b";
          rowEl.style.outlineOffset = "-2px";
          rowEl.style.backgroundColor = "rgba(245, 158, 11, 0.08)";
          rowEl.style.opacity = "0.55";
          if (!rowEl.querySelector(".tt-auto-messaged-badge")) {
            const badge = document.createElement("div");
            badge.className = "tt-auto-messaged-badge";
            badge.textContent = "✓ Already messaged";
            badge.style.cssText =
              "position:absolute;top:4px;right:4px;background:#f59e0b;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;z-index:10;pointer-events:none;";
            if (getComputedStyle(rowEl).position === "static") rowEl.style.position = "relative";
            rowEl.appendChild(badge);
          }
          rowEl.querySelector(".tt-auto-failed-badge")?.remove();
        } else if (isFailed) {
          rowEl.style.outline = "2px solid #ef4444";
          rowEl.style.outlineOffset = "-2px";
          rowEl.style.backgroundColor = "rgba(239, 68, 68, 0.08)";
          rowEl.style.opacity = "";
          if (!rowEl.querySelector(".tt-auto-failed-badge")) {
            const badge = document.createElement("div");
            badge.className = "tt-auto-failed-badge";
            badge.textContent = "✕ Failed — retry?";
            badge.style.cssText =
              "position:absolute;top:4px;right:4px;background:#ef4444;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;z-index:10;pointer-events:none;";
            if (getComputedStyle(rowEl).position === "static") rowEl.style.position = "relative";
            rowEl.appendChild(badge);
          }
          rowEl.querySelector(".tt-auto-messaged-badge")?.remove();
        } else if (isSelected) {
          rowEl.style.outline = "2px solid #00f2ea";
          rowEl.style.outlineOffset = "-2px";
          rowEl.style.backgroundColor = "rgba(0, 242, 234, 0.1)";
          rowEl.style.opacity = "";
          rowEl.querySelector(".tt-auto-messaged-badge")?.remove();
          rowEl.querySelector(".tt-auto-failed-badge")?.remove();
        } else {
          rowEl.style.outline = "none";
          rowEl.style.backgroundColor = "";
          rowEl.style.opacity = "";
          rowEl.querySelector(".tt-auto-messaged-badge")?.remove();
          rowEl.querySelector(".tt-auto-failed-badge")?.remove();
        }
      });
    };

    const interval = setInterval(applyStyles, 500);
    return () => {
      clearInterval(interval);
      document.querySelectorAll(CARD_SEL).forEach(row => {
        const r = row as HTMLElement;
        r.style.outline = "none";
        r.style.backgroundColor = "";
        r.style.opacity = "";
        r.querySelector(".tt-auto-messaged-badge")?.remove();
        r.querySelector(".tt-auto-failed-badge")?.remove();
      });
    };
  }, [selectionMode]);

  const processNextCreator = async () => {
    if (!runningRef.current) {
      console.log("[TT-Auto] processNextCreator skipped — not running");
      return;
    }

    const selectedArr = Array.from(selectedHandlesRef.current);
    const messagedArr = Array.from(alreadyMessagedRef.current);
    const remaining = selectedArr.filter((h) => !alreadyMessagedRef.current.has(norm(h)));
    console.log(
      `[TT-Auto] processNextCreator: processed=${processedCountRef.current} selected=${selectedArr.length} remaining=`,
      remaining
    );

    if (selectionModeRef.current === "MANUAL") {
      // Stop ONLY if every selected handle has been messaged (more reliable
      // than counting, because the counter can miss re-rendered rows).
      if (remaining.length === 0) {
        chrome.runtime.sendMessage({ type: "LOG", msg: `All ${selectedArr.length} selected creators done. Stopping.` }, () => {});
        handleStop();
        return;
      }
    }
    
    // Auto-scroll a bit
    window.scrollBy(0, 300);
    await sleep(rand(200, 400));

    const msgIcons = Array.from(document.querySelectorAll("svg.alliance-icon-Message, svg[class*='Message']"));
    
    let clicked = false;
    for (const svg of msgIcons) {
      const btn = svg.closest("button");
      if (!btn) continue;
      if (btn.dataset.processed === "true") continue;

      const row = btn.closest(CARD_SEL) || btn.parentElement?.parentElement?.parentElement;
      const handle = (row && getRowHandle(row)) || "Creator";

      // If MANUAL mode and not selected, skip
      if (selectionModeRef.current === "MANUAL" && !selectedHandlesRef.current.has(handle)) {
        btn.dataset.processed = "true";
        continue;
      }

      // Skip if globally already messaged (safety net even in AUTO mode)
      if (alreadyMessagedRef.current.has(norm(handle))) {
        chrome.runtime.sendMessage({ type: "LOG", msg: `Skipping ${handle} — already messaged.` }, () => {});
        btn.dataset.processed = "true";
        // For MANUAL mode, count it as "processed" so we don't loop forever
        if (selectionModeRef.current === "MANUAL") processedCountRef.current++;
        continue;
      }

      btn.dataset.processed = "true";
      processedCountRef.current++;

      chrome.runtime.sendMessage({ type: "CLICKED_MESSAGE", handle }, () => {});

      btn.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      await sleep(rand(150, 300));
      btn.click();
      clicked = true;
      break;
    }

    if (!clicked) {
      // No matching button on screen — scroll further. Cap scroll attempts so
      // we don't loop forever if a selected creator is unreachable (e.g. lazy
      // list didn't render past a certain point).
      scrollAttemptsRef.current++;
      if (scrollAttemptsRef.current > 25) {
        chrome.runtime.sendMessage({ type: "LOG", msg: "Stopped: scrolled to end of list without finding remaining creators.", level: "error" }, () => {});
        handleStop();
        return;
      }
      chrome.runtime.sendMessage({ type: "LOG", msg: `Scanning page… (${scrollAttemptsRef.current}/25)`, level: "warn" }, () => {});
      window.scrollBy(0, 800);
      setTimeout(processNextCreator, rand(500, 900));
    } else {
      scrollAttemptsRef.current = 0;
    }
  };

  const handleStart = () => {
    if (!activated) {
      alert("Extension activate karo pehle — popup mein API key daalo.");
      return;
    }
    if (selectionMode === "MANUAL" && selectedHandles.size === 0) {
      alert("Please select at least one creator by clicking on them!");
      return;
    }

    // Reset scroll to top before starting so we don't miss anyone
    window.scrollTo({ top: 0, behavior: "instant" });
    processedCountRef.current = 0;
    scrollAttemptsRef.current = 0;

    chrome.runtime.sendMessage({
      type: "START_CAMPAIGN",
      template,
      minDelay: 10000,
      maxDelay: 20000
    }, (res) => {
      if (!res?.ok) {
        alert(`Cannot start: ${res?.error || "unknown error"}`);
        return;
      }
      setStatus("RUNNING");
      runningRef.current = true;
      setTimeout(processNextCreator, 1000);
    });
  };

  const handleStop = () => {
    chrome.runtime.sendMessage({ type: "STOP_CAMPAIGN" }, () => {
      setStatus("IDLE");
      runningRef.current = false;
    });
  };

  // Don't render the floating panel at all until the extension is activated.
  if (!activated) return null;

  return (
    <div style={{
      position: "fixed", bottom: "20px", right: "20px", width: "350px",
      backgroundColor: "#fff", border: "1px solid #ccc", borderRadius: "8px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)", zIndex: 999999, padding: "16px",
      fontFamily: "system-ui, sans-serif",
      color: "#333"
    }}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: "16px", fontWeight: "bold" }}>TT Auto-Messenger</h3>

      {alreadyMessaged.size > 0 && (
        <div style={{ marginBottom: "8px", padding: "6px 8px", backgroundColor: "#fffbeb", border: "1px solid #f59e0b", borderRadius: "4px", fontSize: "11px", color: "#92400e" }}>
          <strong>{alreadyMessaged.size}</strong> already messaged <span style={{ opacity: 0.7 }}>(orange — skipped)</span>
        </div>
      )}
      {failedHandles.size > 0 && (
        <div style={{ marginBottom: "12px", padding: "6px 8px", backgroundColor: "#fef2f2", border: "1px solid #ef4444", borderRadius: "4px", fontSize: "11px", color: "#991b1b" }}>
          <strong>{failedHandles.size}</strong> failed earlier <span style={{ opacity: 0.7 }}>(red — selectable to retry)</span>
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px", fontSize: "12px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
          <input 
            type="radio" 
            name="selectionMode" 
            checked={selectionMode === "AUTO"} 
            onChange={() => setSelectionMode("AUTO")}
            disabled={status === "RUNNING"}
          />
          Auto Select (All on page)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
          <input 
            type="radio" 
            name="selectionMode" 
            checked={selectionMode === "MANUAL"} 
            onChange={() => setSelectionMode("MANUAL")}
            disabled={status === "RUNNING"}
          />
          Manual Select
        </label>
      </div>

      {selectionMode === "MANUAL" && (
        <div style={{ marginBottom: "12px", padding: "8px", backgroundColor: "#f0fdfa", border: "1px solid #14b8a6", borderRadius: "4px", fontSize: "12px" }}>
          <strong>Manual Mode Active</strong><br/>
          Click directly on creator cards on the page to select/deselect them.<br/>
          <span style={{ fontWeight: "bold", color: "#0f766e" }}>{selectedHandles.size} Selected</span>
          {selectedHandles.size > 0 && (
            <button 
              onClick={() => setSelectedHandles(new Set())}
              style={{ marginLeft: "8px", background: "none", border: "none", color: "#ef4444", cursor: "pointer", textDecoration: "underline" }}
              disabled={status === "RUNNING"}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div style={{ marginBottom: "12px" }}>
        <label style={{ display: "block", fontSize: "12px", marginBottom: "4px", fontWeight: "bold" }}>Spintax Template</label>
        <textarea 
          value={template} 
          onChange={(e) => setTemplate(e.target.value)}
          style={{ width: "100%", height: "60px", padding: "8px", fontSize: "13px", border: "1px solid #ccc", borderRadius: "4px" }}
          disabled={status === "RUNNING"}
        />
        <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>Use {'{name}'} or {'{handle}'}</div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        {status === "IDLE" ? (
          <button 
            onClick={handleStart}
            style={{ flex: 1, backgroundColor: "#00f2ea", color: "#000", border: "none", padding: "10px", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}
          >
            Start Campaign
          </button>
        ) : (
          <button 
            onClick={handleStop}
            style={{ flex: 1, backgroundColor: "#ff0050", color: "#fff", border: "none", padding: "10px", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}
          >
            Stop Campaign
          </button>
        )}
      </div>

      <div style={{ height: "100px", overflowY: "auto", backgroundColor: "#f5f5f5", borderRadius: "4px", padding: "8px", fontSize: "11px", border: "1px solid #ddd" }}>
        {logs.length === 0 && <span style={{ color: "#999" }}>Ready to start...</span>}
        {logs.map((log, i) => (
          <div key={i} style={{ marginBottom: "4px", color: log.level === "error" ? "red" : "#333" }}>
            <span style={{ color: "#888" }}>{new Date(log.ts).toLocaleTimeString()}</span> - {log.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

export default defineContentScript({
  matches: ["https://partner.us.tiktokshop.com/affiliate-cmp/creator*"],
  main() {
    const container = document.createElement("div");
    container.id = "tt-auto-messenger-root";
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    root.render(<App />);
  },
});
