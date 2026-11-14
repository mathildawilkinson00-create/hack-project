// =============================================================================
// bridge/background.js — THE MESSENGER (runs in the background, no window)
// =============================================================================
// Chrome runs this file as a "service worker": invisible, always ready.
// It has 2 jobs:
//   1. Open the control panel when you click the extension icon.
//   2. Receive { action: "next" } from the panel, find the Figma tab,
//      and pass the action on to bridge/content.js inside that tab.
//
// Why a middleman? The panel can't talk to the Figma tab by itself:
// it has to find the tab first, and only background code can search tabs.
// =============================================================================

// Plan B: set to true if Figma ignores the fake key presses from content.js.
// It then sends REAL key presses through Chrome's debugger instead.
// Chrome shows a "... started debugging this browser" banner: fine for a demo.
const USE_DEBUGGER = false;

// Which keyboard key each action presses (Figma: → next slide, ← previous slide).
// keyCode = the old number code for the key, still expected by some apps.
const KEYS = {
  next: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  prev: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
};

// ---- Job 1: extension icon clicked → open the panel in its own window ----
// (A separate window, not a popup: popups close as soon as you click elsewhere,
// which would turn the camera off.)
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: chrome.runtime.getURL("panel/panel.html"),
    type: "popup", // a small window without the address bar
    width: 420,
    height: 640,
  });
});

// Find the open Figma tab (the visible one if there are several).
async function findFigmaTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.figma.com/*" });
  return tabs.find((t) => t.active) || tabs[0];
}

// Plan B: press a real key in the tab using Chrome's debugger.
async function pressWithDebugger(tabId, k) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    // Already attached from a previous press: fine.
  }
  const key = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

// ---- Job 2: message from the panel → forward it to Figma ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "action") return; // not for us

  // The work below is async (it waits for Chrome), so it's wrapped in an async function.
  (async () => {
    const k = KEYS[msg.action];
    if (!k) return sendResponse({ ok: false, error: `unknown action ${msg.action}` });

    const tab = await findFigmaTab();
    if (!tab) return sendResponse({ ok: false, error: "No Figma tab open" });

    if (USE_DEBUGGER) {
      await pressWithDebugger(tab.id, k);
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: "action", action: msg.action }); // → content.js
    }
    sendResponse({ ok: true }); // the panel shows "➡️ Next slide!"
  })().catch((e) => sendResponse({ ok: false, error: String(e) })); // the panel shows "⚠️ <error>"

  // "true" tells Chrome: "I'll answer later", otherwise it closes the conversation right away.
  return true;
});
