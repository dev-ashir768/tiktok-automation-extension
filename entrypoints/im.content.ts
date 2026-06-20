import { defineContentScript } from "wxt/sandbox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const TAG = "[TT-Auto IM]";

function personalize(template: string, vars: Record<string, string>) {
  return template.replace(/\{([^{}]+)\}/g, (match, p1) => {
    if (p1.includes("|")) {
      const options = p1.split("|");
      return options[Math.floor(Math.random() * options.length)];
    }
    return vars[p1.toLowerCase()] || match;
  });
}

export default defineContentScript({
  matches: ["https://partner.us.tiktokshop.com/partner/im*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    console.log(TAG, "Loaded in frame:", window.location.href);

    if (window.top !== window) {
      console.log(TAG, "Iframe — idling.");
      return;
    }

    (async () => {
      const ready: any = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "IM_READY" }, resolve)
      );
      if (!ready || !ready.shouldSend) {
        console.log(TAG, "No active campaign, idling.");
        return;
      }

      const { template, handle } = ready;
      const msgText = personalize(template, { name: handle, handle });
      console.log(TAG, `Sending to ${handle}:`, msgText);
      chrome.runtime.sendMessage({ type: "LOG", msg: `Typing message to ${handle}...` }, () => {});

      const HARD_TIMEOUT_MS = 90_000;
      const startedAt = Date.now();
      const lap = (label: string) => console.log(TAG, `[${(Date.now() - startedAt)}ms] ${label}`);

      const work = (async () => {
        lap("waiting for editor");
        const editor = await waitForEditor();
        if (!editor) {
          const bodyText = (document.body?.innerText || "").slice(0, 300).replace(/\s+/g, " ").trim();
          console.error(TAG, "Editor missing. URL:", location.href, "Body:", bodyText);
          throw new Error("Chat editor not found within 45s — TT inbox may still be loading or chat is locked");
        }
        lap("editor found");
        lap("processChat start");
        await processChat(msgText, handle, editor);
        lap("processChat done");
      })();

      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`Timed out after ${HARD_TIMEOUT_MS / 1000}s`)), HARD_TIMEOUT_MS)
      );

      try {
        await Promise.race([work, timeout]);
        chrome.runtime.sendMessage({ type: "IM_SENT" }, () => {});
      } catch (e: any) {
        console.error(TAG, `Failed after ${Date.now() - startedAt}ms:`, e);
        chrome.runtime.sendMessage({ type: "IM_FAILED", error: e.message }, () => {});
      }
    })();
  },
});

function handlesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
}

async function waitForEditor(): Promise<HTMLTextAreaElement | null> {
  // TT's IM page loads the 600+ inbox before rendering the chat panel —
  // textarea often appears 15-25s in. Poll fast for up to ~45s.
  for (let i = 0; i < 300; i++) {
    const ta = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Send a message"], ' +
      'textarea[placeholder*="message" i], ' +
      'textarea[class*="textarea--"], ' +
      'textarea[class*="input" i]'
    );
    if (ta && ta.offsetHeight > 0 && !ta.disabled && !ta.readOnly) {
      return ta;
    }
    // Also accept contenteditable in case TT switches to rich editor
    const ce = document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"], [contenteditable="true"][class*="input" i]'
    );
    if (ce && ce.offsetHeight > 0) {
      return ce as any;
    }
    await sleep(150);
  }
  return null;
}

function findSendButton(editor: HTMLTextAreaElement): HTMLButtonElement | null {
  // Scope: walk up to find the input wrapper, then find the Send button inside it.
  let scope: HTMLElement | null = editor.parentElement;
  for (let i = 0; i < 8 && scope; i++) {
    const btns = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"));
    for (const btn of btns) {
      if (btn.offsetHeight === 0) continue;
      const txt = (btn.textContent || "").trim().toLowerCase();
      if (txt === "send") return btn;
    }
    scope = scope.parentElement;
  }
  // Fallback: search the whole document
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
    if (btn.offsetHeight === 0) continue;
    if ((btn.textContent || "").trim().toLowerCase() === "send") return btn;
  }
  return null;
}

function setTextareaValue(ta: HTMLTextAreaElement, value: string) {
  ta.focus();
  // Clear any existing content first
  ta.select();

  // Strategy A: execCommand('insertText') — dispatches real beforeinput/input
  // events that React trusts as genuine user input (not a programmatic set).
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, value);
  } catch {}

  if (!ok || ta.value !== value) {
    // Strategy B: native setter + InputEvent with proper inputType
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(ta, value);
    ta.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: value }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function processChat(msgText: string, handle: string, editor: HTMLTextAreaElement) {
  const t0 = Date.now();
  const lap = (msg: string) => console.log(TAG, `  processChat[+${Date.now() - t0}ms] ${msg}`);

  await sleep(rand(200, 400));
  editor.focus();
  await sleep(60);
  setTextareaValue(editor, msgText);
  lap("text inserted");

  await sleep(120);
  if (editor.value.trim().length === 0) {
    throw new Error("Text insertion failed — textarea is still empty after native setter.");
  }

  // STRATEGY A: Wait for the Send button to be enabled, then click it.
  // This is the primary path — TT's React button is more reliable than Enter.
  let sendBtn: HTMLButtonElement | null = null;
  for (let i = 0; i < 30; i++) {
    sendBtn = findSendButton(editor);
    if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains("arco-btn-disabled")) break;
    await sleep(100);
  }
  lap(`send btn ${sendBtn ? "found" : "NOT found"}`);
  if (!sendBtn) throw new Error("Send button not found near the chat editor.");
  if (sendBtn.disabled) throw new Error("Send button is disabled — React didn't pick up the text input.");

  console.log(TAG, "Clicking send button:", sendBtn);

  // Tag both elements with stable IDs so the MAIN-world script can find them
  // reliably — TT regenerates data-e2e UUIDs on every render.
  const sendBtnId = `tt-auto-send-${Date.now()}`;
  const textareaId = `tt-auto-ta-${Date.now()}`;
  const prevBtnId = sendBtn.id;
  const prevTaId = editor.id;
  sendBtn.id = sendBtnId;
  editor.id = textareaId;

  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "MAIN_WORLD_SEND_CLICK",
        sendBtnSelector: `#${sendBtnId}`,
        textareaSelector: `#${textareaId}`,
        text: msgText,
      },
      (res) => {
        console.log(TAG, "MAIN-world click result:", res);
        resolve();
      }
    );
  });
  lap("main-world click done");

  if (prevBtnId) sendBtn.id = prevBtnId; else sendBtn.removeAttribute("id");
  if (prevTaId) editor.id = prevTaId; else editor.removeAttribute("id");

  // Verify the textarea cleared
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (editor.value.trim() === "") {
      lap("send verified — cleared");
      return;
    }
  }
  lap("not cleared after click — trying Enter");

  editor.focus();
  const opts: any = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  editor.dispatchEvent(new KeyboardEvent("keydown", opts));
  editor.dispatchEvent(new KeyboardEvent("keypress", opts));
  editor.dispatchEvent(new KeyboardEvent("keyup", opts));

  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (editor.value.trim() === "") {
      lap("send verified after Enter");
      return;
    }
  }

  throw new Error("Delivery unverified (textarea did not clear after click + Enter).");
}

async function clickSendButton(btn: HTMLElement) {
  // Scroll into view so coordinates are accurate
  btn.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await sleep(120);

  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // Full pointer/mouse event sequence — TT's React handler often binds onPointerUp
  const fire = (type: string, EventCtor: any = MouseEvent) => {
    btn.dispatchEvent(new EventCtor(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: cx, clientY: cy, button: 0, buttons: 1, view: window,
    }));
  };

  fire("pointerover", PointerEvent);
  fire("pointerenter", PointerEvent);
  fire("mouseover");
  fire("mouseenter");
  fire("pointerdown", PointerEvent);
  fire("mousedown");
  await sleep(40);
  fire("pointerup", PointerEvent);
  fire("mouseup");
  fire("click");

  // Also do a plain .click() and a React-fiber bypass via injected script,
  // since some buttons only respond to React's synthetic onClick.
  try { (btn as HTMLButtonElement).click(); } catch {}

  const id = "tt-auto-send-" + Date.now();
  const prev = btn.id;
  btn.id = id;
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      try {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) return;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width/2, cy = r.top + r.height/2;
        let curr = el;
        while (curr && curr !== document.body) {
          const key = Object.keys(curr).find(k => k.startsWith('__reactProps$'));
          if (key && curr[key]) {
            const p = curr[key];
            const fake = (type) => ({
              preventDefault:()=>{}, stopPropagation:()=>{},
              nativeEvent:{isTrusted:true,preventDefault:()=>{},stopPropagation:()=>{}},
              bubbles:true, type, target:curr, currentTarget:curr,
              button:0, buttons:1, clientX:cx, clientY:cy, pageX:cx, pageY:cy
            });
            if (typeof p.onPointerDown === 'function') p.onPointerDown(fake('pointerdown'));
            if (typeof p.onMouseDown === 'function') p.onMouseDown(fake('mousedown'));
            if (typeof p.onPointerUp === 'function') p.onPointerUp(fake('pointerup'));
            if (typeof p.onMouseUp === 'function') p.onMouseUp(fake('mouseup'));
            if (typeof p.onClick === 'function') { p.onClick(fake('click')); break; }
          }
          curr = curr.parentElement;
        }
      } catch (e) { console.error('[TT-Auto IM] fiber click failed', e); }
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
  if (prev) btn.id = prev; else btn.removeAttribute("id");
}
