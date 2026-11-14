# Point Right — HackDécouverte 2026

Chrome extension (Manifest V3) that lets you move through a Figma presentation with hand gestures, using MediaPipe's Gesture Recognizer.

## Contracts (do not change without telling the team)

**Engine API** (`engine/gestures.js`)
```js
startEngine({ video, canvas, settings, onGesture })  // returns Promise<void>
stopEngine()
// onGesture(gestureName) fires once per accepted gesture (hold + release + cooldown rules).
// gestureName: MediaPipe names "Thumb_Up", "Thumb_Down", "Open_Palm", "Closed_Fist",
// plus our own finger counting: "Pointing_Up" (1 finger), "Victory" (2), "Three_Fingers" (3).
```

**Settings** (saved in `chrome.storage.local` under key `settings`; defaults in `panel/panel.js`)
```js
{
  version: 2,           // bump to reset everyone's saved gesture list to the defaults
  holdFrames: 8,        // frames a gesture must be held
  cooldownMs: 1000,     // pause after each action
  showTracking: false,  // draw the hand skeleton
  gestures: {
    Victory:       { on: true, action: "next" },
    Three_Fingers: { on: true, action: "prev" }
  }
}
```
The engine reads this same object every frame, so slider changes apply live.

**Actions**: `"next" | "prev" | "none"`.

**Messages**: `{ type: "action", action: "<action>" }` panel → `bridge/background.js` → `bridge/content.js`.
Background replies `{ ok: true }` or `{ ok: false, error: "..." }`.

## Rules

- MediaPipe is bundled in `lib/mediapipe/` (`@mediapipe/tasks-vision@0.10.14` + `gesture_recognizer.task`).
  **Never load scripts from a CDN** — Manifest V3 forbids remote code. Never edit `lib/`.
- Stay in your own folder: `engine/`, `bridge/`, `panel/`. Ask before editing another person's folder.
- The engine reads frames with `MediaStreamTrackProcessor` so detection keeps running when the panel window is minimized or behind Figma fullscreen.
- MediaPipe's own console notes (`W1114 ...`, `INFO: ...`) are filtered out in `engine/gestures.js`.
