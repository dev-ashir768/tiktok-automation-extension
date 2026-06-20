export default defineBackground(() => {
  // ---- Backend / activation ----

  // Backend URL is baked in at build time via wxt.config.ts — not user-input.
  const API_BASE = __API_BASE__;

  type Activation = {
    apiKey: string | null;
    user: { id: number; email: string; name: string | null } | null;
  };

  let activation: Activation = { apiKey: null, user: null };
  let sentToday = 0;
  let sentTodayDate = new Date().toDateString();

  const bumpSentToday = () => {
    const today = new Date().toDateString();
    if (today !== sentTodayDate) { sentTodayDate = today; sentToday = 0; }
    sentToday++;
  };

  let activationReady: Promise<void>;
  async function loadActivation() {
    const s = await chrome.storage.local.get(['apiKey', 'user']);
    activation.apiKey = s.apiKey ?? null;
    activation.user = s.user ?? null;
  }
  activationReady = loadActivation();

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(activation.apiKey ? { 'X-API-Key': activation.apiKey } : {}),
        ...(init.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Auto-refresh any open TikTok Shop Partner tabs when the extension installs,
  // updates, or the browser starts — guarantees the content script always runs
  // on a fresh page state.
  const refreshTtTabs = async () => {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://*.tiktokshop.com/*' });
      for (const t of tabs) {
        if (t.id != null) {
          try { await chrome.tabs.reload(t.id); } catch {}
        }
      }
    } catch {}
  };
  chrome.runtime.onInstalled.addListener(refreshTtTabs);
  chrome.runtime.onStartup.addListener(refreshTtTabs);

  let state = {
    status: 'IDLE', // 'IDLE', 'RUNNING', 'PAUSED'
    template: '',
    minDelay: 10000,
    maxDelay: 30000,
    currentCreatorHandle: '',
    findCreatorsTabId: null as number | null,
    imTabId: null as number | null,
    logs: [] as any[]
  };

  async function closeImTabAndContinue(error: string | undefined, sentHandle: string | undefined) {
    const imTabId = state.imTabId;
    state.imTabId = null;
    if (imTabId != null) {
      try { await chrome.tabs.remove(imTabId); } catch {}
    }
    if (state.findCreatorsTabId != null && state.status === 'RUNNING') {
      try {
        await chrome.tabs.update(state.findCreatorsTabId, { active: true });
      } catch {}
      try {
        await chrome.tabs.sendMessage(state.findCreatorsTabId, {
          type: 'CONTINUE_NEXT',
          error,
          justSentHandle: sentHandle,
        });
      } catch {
        setTimeout(() => {
          chrome.tabs.sendMessage(state.findCreatorsTabId!, {
            type: 'CONTINUE_NEXT',
            error,
            justSentHandle: sentHandle,
          }).catch(() => {});
        }, 800);
      }
    }
  }

  function addLog(msg: string, level = 'info') {
    state.logs.push({ ts: Date.now(), msg, level });
    // limit logs to 100
    if (state.logs.length > 100) state.logs.shift();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // ---- Activation / popup ----
    if (msg.type === 'GET_ACTIVATION') {
      activationReady.then(() => {
        sendResponse({
          apiKey: activation.apiKey,
          user: activation.user,
          apiBase: API_BASE,
          status: state.status,
          sentToday,
        });
      });
      return true;
    }

    if (msg.type === 'ACTIVATE') {
      (async () => {
        try {
          activation = { apiKey: msg.apiKey, user: null };
          const user = await api('/api/me');
          activation.user = user;
          await chrome.storage.local.set({ apiKey: msg.apiKey, user });
          sendResponse({ ok: true, user });
        } catch (e: any) {
          activation = { apiKey: null, user: null };
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    if (msg.type === 'DEACTIVATE') {
      activation = { apiKey: null, user: null };
      chrome.storage.local.remove(['apiKey', 'user']).then(() => sendResponse({ ok: true }));
      return true;
    }

    // ---- Backend proxies for content scripts ----
    if (msg.type === 'CHECK_MESSAGED_HANDLES') {
      (async () => {
        if (!activation.apiKey) return sendResponse({ messaged: [], failed: [], notActivated: true });
        try {
          const data = await api('/api/creators/check', {
            method: 'POST',
            body: JSON.stringify({ handles: msg.handles }),
          });
          sendResponse({ messaged: data.messaged || [], failed: data.failed || [] });
        } catch (e: any) {
          sendResponse({ messaged: [], failed: [], error: e.message });
        }
      })();
      return true;
    }

    if (msg.type === 'LOG_MESSAGE') {
      (async () => {
        if (!activation.apiKey) return sendResponse({ ok: false, error: 'Not activated' });
        try {
          await api('/api/messages', {
            method: 'POST',
            body: JSON.stringify({
              handle: msg.handle,
              name: msg.name,
              body: msg.body,
              status: msg.status,
              errorMessage: msg.errorMessage,
            }),
          });
          if (msg.status === 'sent') bumpSentToday();
          sendResponse({ ok: true });
        } catch (e: any) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    if (msg.type === 'START_CAMPAIGN') {
      activationReady.then(() => {
        if (!activation.apiKey || !activation.user) {
          sendResponse({ ok: false, error: 'Extension not activated. Open the popup and enter your API key.' });
          return;
        }
        state.status = 'RUNNING';
        state.template = msg.template;
        state.minDelay = msg.minDelay || 10000;
        state.maxDelay = msg.maxDelay || 30000;
        state.findCreatorsTabId = sender.tab?.id || null;
        state.logs = [];
        addLog('Campaign started.');
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'STOP_CAMPAIGN') {
      state.status = 'IDLE';
      addLog('Campaign stopped.');
      sendResponse({ ok: true });
      return true;
    }
    
    if (msg.type === 'GET_STATE') {
      sendResponse(state);
      return true;
    }

    if (msg.type === 'CLICKED_MESSAGE') {
      state.currentCreatorHandle = msg.handle;
      addLog(`Opening chat for ${msg.handle}...`);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'IM_READY') {
      if (state.status === 'RUNNING') {
        // Verify this IM tab actually belongs to the creator we're trying to message.
        // If find-creators just clicked creator A and TT reused an existing IM tab
        // showing creator B (URL didn't navigate), this guards against sending to the wrong chat.
        const tabUrl = sender.tab?.url || '';
        const tabCreatorIdMatch = /[?&]creator_id=(\d+)/.exec(tabUrl);
        const expectedHandle = state.currentCreatorHandle;
        if (msg.urlHandle && expectedHandle && msg.urlHandle !== expectedHandle) {
          addLog(`Skipping send — tab is for ${msg.urlHandle} but we expected ${expectedHandle}`, 'error');
          sendResponse({ shouldSend: false });
          return true;
        }
        state.imTabId = sender.tab?.id ?? null;
        sendResponse({
          shouldSend: true,
          template: state.template,
          handle: expectedHandle,
          creatorIdFromUrl: tabCreatorIdMatch?.[1] || null,
        });
      } else {
        sendResponse({ shouldSend: false });
      }
      return true;
    }

    if (msg.type === 'IM_SENT') {
      const handle = state.currentCreatorHandle;
      addLog(`Message sent to ${handle}`);
      sendResponse({ ok: true });
      if (activation.apiKey) {
        api('/api/messages', {
          method: 'POST',
          body: JSON.stringify({ handle, body: msg.body || state.template, status: 'sent' }),
        }).then(() => bumpSentToday()).catch((e) => addLog(`Backend log failed: ${e.message}`, 'warn'));
      }
      closeImTabAndContinue(undefined, handle);
      return true;
    }

    if (msg.type === 'IM_FAILED') {
      const handle = state.currentCreatorHandle;
      addLog(`Failed to send to ${handle}: ${msg.error}`, 'error');
      sendResponse({ ok: true });
      if (activation.apiKey) {
        api('/api/messages', {
          method: 'POST',
          body: JSON.stringify({ handle, body: state.template, status: 'failed', errorMessage: msg.error }),
        }).catch(() => {});
      }
      closeImTabAndContinue(msg.error, handle);
      return true;
    }

    if (msg.type === 'LOG') {
      addLog(msg.msg, msg.level);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'INSTALL_OPEN_HOOK') {
      const tabId = sender.tab?.id;
      if (tabId == null) { sendResponse({ ok: false }); return true; }
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const w = window as any;
          if (w.__ttAutoOpenHook) return;
          w.__ttAutoOpenHook = true;
          const orig = window.open.bind(window);
          // Fake window object so TT doesn't fall back to same-tab navigation
          // when it checks `if (!win) { location.href = url }` after window.open.
          const fakeWin: any = {
            closed: false,
            focus: () => {},
            blur: () => {},
            close: () => { fakeWin.closed = true; },
            postMessage: () => {},
            location: { href: '', assign: () => {}, replace: () => {} },
            document: { write: () => {}, close: () => {} },
            opener: null,
          };
          window.open = function (url?: string | URL, target?: string, features?: string) {
            try {
              const u = String(url || '');
              if (u.includes('/partner/im')) {
                const abs = new URL(u, location.href).href;
                window.postMessage({ __ttAutoOpen: true, url: abs }, '*');
                fakeWin.location.href = abs;
                return fakeWin;
              }
            } catch {}
            return orig(url as any, target as any, features as any);
          };
        }
      }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    if (msg.type === 'OPEN_IM_TAB') {
      const opener = sender.tab?.id;
      chrome.tabs.create({
        url: msg.url,
        active: true,
        ...(opener ? { openerTabId: opener } : {}),
      }).then((tab) => {
        state.imTabId = tab.id ?? null;
        sendResponse({ ok: true, tabId: tab.id });
      }).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    if (msg.type === 'MAIN_WORLD_SEND_CLICK') {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId ?? 0;
      if (tabId == null) {
        sendResponse({ ok: false, error: 'No tabId' });
        return true;
      }
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func: (sendBtnSelector: string, textareaSelector: string, text: string) => {
          const btn = document.querySelector(sendBtnSelector) as HTMLElement | null;
          const ta = document.querySelector(textareaSelector) as HTMLTextAreaElement | null;
          if (!ta) return { ok: false, error: 'textarea not found in MAIN' };

          // Re-insert text in MAIN world using React-aware setter so React's internal state matches
          try {
            ta.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(ta, '');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            setter?.call(ta, text);
            ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text } as any));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {}

          if (!btn) return { ok: false, error: 'send button not found in MAIN' };

          const rect = btn.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          // Walk React fiber to find the onClick handler — now from MAIN world, CSP doesn't apply
          let curr: any = btn;
          let invoked = false;
          while (curr && curr !== document.body) {
            const key = Object.keys(curr).find((k) => k.startsWith('__reactProps$'));
            if (key && curr[key]) {
              const p = curr[key];
              const fake = (type: string) => ({
                preventDefault: () => {}, stopPropagation: () => {},
                nativeEvent: { isTrusted: true, preventDefault: () => {}, stopPropagation: () => {} },
                bubbles: true, type, target: curr, currentTarget: curr,
                button: 0, buttons: 1, clientX: cx, clientY: cy, pageX: cx, pageY: cy,
              });
              if (typeof p.onPointerDown === 'function') p.onPointerDown(fake('pointerdown'));
              if (typeof p.onMouseDown === 'function') p.onMouseDown(fake('mousedown'));
              if (typeof p.onPointerUp === 'function') p.onPointerUp(fake('pointerup'));
              if (typeof p.onMouseUp === 'function') p.onMouseUp(fake('mouseup'));
              if (typeof p.onClick === 'function') { p.onClick(fake('click')); invoked = true; break; }
            }
            curr = curr.parentElement;
          }

          // Also a native click for good measure
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
            btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
          });
          try { (btn as HTMLButtonElement).click(); } catch {}

          return { ok: true, invokedReact: invoked };
        },
        args: [msg.sendBtnSelector, msg.textareaSelector, msg.text],
      }).then((results) => {
        sendResponse({ ok: true, results });
      }).catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
      return true; // async
    }
  });
});
