# Gesture Presenter — HackDécouverte 2026

Chrome extension (Manifest V3) that lets you move through a Figma presentation with hand gestures, using MediaPipe's Gesture Recognizer. Team of 4, one folder per person.

## Architecture

```
[panel window]  camera + MediaPipe + UI
   panel/panel.js  ──uses──>  engine/gestures.js   (gesture name, held + cooldown)
        │  chrome.runtime.sendMessage({ type: "action", action: "next" })
        ▼
[service worker] bridge/background.js  ── finds the Figma tab ──>
        ▼  chrome.tabs.sendMessage({ type: "action", action: "next" })
[content script] bridge/content.js  → presses ArrowRight / ArrowLeft in Figma
```

Clicking the extension icon opens `panel/panel.html` in its own small window
(NOT a popup: popups close when they lose focus and kill the camera).

## Contracts (do not change without telling the team)

**Engine API** (`engine/gestures.js`)
```js
startEngine({ video, canvas, settings, onGesture })  // returns Promise<void>
stopEngine()
// onGesture(gestureName) fires once per accepted gesture (after hold + cooldown).
// gestureName is a MediaPipe category name: "Thumb_Up", "Thumb_Down",
// "Open_Palm", "Closed_Fist", "Pointing_Up", "Victory", "ILoveYou"
```

**Settings** (saved in `chrome.storage.local` under key `settings`)
```js
{
  enabled: true,
  holdFrames: 8,        // frames a gesture must be held
  cooldownMs: 1000,     // pause after each action
  gestures: {
    Thumb_Up:   { on: true,  action: "next" },
    Thumb_Down: { on: true,  action: "prev" },
    Open_Palm:  { on: false, action: "none" }
  }
}
```

**Actions**: `"next" | "prev" | "none"` (add more here if needed, e.g. `"first"`).

**Messages**: `{ type: "action", action: "<action>" }` from panel → background → content script.
Background replies `{ ok: true }` or `{ ok: false, error: "..." }`.

## Rules

- MediaPipe is bundled in `lib/mediapipe/` (`@mediapipe/tasks-vision@0.10.14` + `gesture_recognizer.task`).
  **Never load scripts from a CDN** — Manifest V3 forbids remote code.
- Load the wasm with `FilesetResolver.forVisionTasks(chrome.runtime.getURL("lib/mediapipe/wasm"))`.
- Stay in your own folder: `engine/`, `bridge/`, `panel/`. Ask before editing another person's folder.
- Plain HTML/CSS/JS, ES modules, no build step, no npm.
- No API keys anywhere in the extension.
- Keep the camera window visible on screen (Chrome throttles hidden windows).
- If Figma ignores synthetic key events, the fallback is `chrome.debugger` + `Input.dispatchKeyEvent`
  in `bridge/background.js` (set `USE_DEBUGGER = true`).

## Testing

`chrome://extensions` → Developer mode → Load unpacked → pick the repo folder.
After changes, click the reload ↻ button on the extension card.
Panel console: right-click the panel → Inspect. Background console: "service worker" link on the card.
