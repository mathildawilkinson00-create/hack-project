// =============================================================================
// bridge/content.js — THE HAND INSIDE FIGMA
// =============================================================================
// Chrome injects this file into every figma.com tab (see "content_scripts" in
// manifest.json). It waits for { action: "next" } from bridge/background.js
// and presses the matching arrow key, as if you had pressed it yourself.
//
// If Figma ignores these fake key presses (Chrome marks them as "not from a
// real keyboard"), set USE_DEBUGGER = true in background.js (plan B).
// =============================================================================

// Which key each action presses (Figma: → next slide, ← previous slide).
const KEYS = {
  next: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  prev: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
};

// Simulate pressing and releasing a key, on whatever Figma element has the focus.
function press(k) {
  const target = document.activeElement || document.body;
  for (const type of ["keydown", "keyup"]) {
    const ev = new KeyboardEvent(type, {
      key: k.key,
      code: k.code,
      keyCode: k.keyCode,
      which: k.keyCode,
      bubbles: true,    // the event travels up the page, so Figma's listeners see it
      cancelable: true,
    });
    target.dispatchEvent(ev);
  }
}

// Wait for messages from background.js.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "action") return;
  const k = KEYS[msg.action];
  if (k) {
    console.log("[Gesture Presenter] action:", msg.action); // visible in Figma's console (F12)
    press(k);
  }
});
