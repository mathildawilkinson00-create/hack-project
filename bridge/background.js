// Service worker: opens the control panel and forwards actions to the Figma tab.
// Owner: Figma bridge person.

// Set to true if Figma ignores the fake key presses from content.js.
// Chrome will show a "is debugging this browser" banner — fine for a demo.
const USE_DEBUGGER = false;

const KEYS = {
  next: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  prev: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
};

// Click on the extension icon:
//  - on a Figma tab → show/hide the floating overlay (panel/overlay.js)
//  - anywhere else (or if the overlay script isn't loaded yet) → open the panel window
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.url?.startsWith("https://www.figma.com/")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "toggleOverlay" });
      return;
    } catch (e) {
      // Tab was opened before the extension loaded: fall back to the window.
    }
  }
  chrome.windows.create({
    url: chrome.runtime.getURL("panel/panel.html"),
    type: "popup",
    width: 420,
    height: 640,
  });
});

async function findFigmaTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.figma.com/*" });
  // Prefer the active one if there are several.
  return tabs.find((t) => t.active) || tabs[0];
}

async function pressWithDebugger(tabId, k) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    // Already attached: fine.
  }
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
  };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "action") return;

  (async () => {
    const k = KEYS[msg.action];
    if (!k) return sendResponse({ ok: false, error: `unknown action ${msg.action}` });

    const tab = await findFigmaTab();
    if (!tab) return sendResponse({ ok: false, error: "No Figma tab open" });

    if (USE_DEBUGGER) {
      await pressWithDebugger(tab.id, k);
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: "action", action: msg.action });
    }
    sendResponse({ ok: true });
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true; // keep sendResponse alive for the async work
});
