// Content script running inside Figma. Receives actions and presses arrow keys.
// Owner: Figma bridge person.
//
// STEP 2 TEST: open a Figma presentation, then in the panel click "Test next".
// If the slide doesn't move, set USE_DEBUGGER = true in background.js.

const KEYS = {
  next: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  prev: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
};

function press(k) {
  const target = document.activeElement || document.body;
  for (const type of ["keydown", "keyup"]) {
    const ev = new KeyboardEvent(type, {
      key: k.key,
      code: k.code,
      keyCode: k.keyCode,
      which: k.keyCode,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "action") return;
  const k = KEYS[msg.action];
  if (k) {
    console.log("[Gesture Presenter] action:", msg.action);
    press(k);
  }
});
