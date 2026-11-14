# Point Right ✋

Control your Figma presentation with hand gestures. A Chrome extension built at HackDécouverte 2026 with MediaPipe. Everything runs on your device: the video never leaves your laptop.

## Install (dev)

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Open a Figma presentation, click the extension icon, press **Start camera**.

After changing code, click the reload ↻ button on the extension's card.

## Gestures

| Gesture | Default action |
|---|---|
| ✌️ Two fingers | Next slide |
| 🖖 Three fingers | Previous slide |

More (👍 👎 ✋ ✊ ☝️) can be added in the panel with **+ Add gesture**.

## How it works

```
 ┌──────────── panel window ────────────┐
 │ engine/gestures.js                   │  webcam → MediaPipe → "Victory"
 │        │ onGesture("Victory")        │
 │        ▼                             │
 │ panel/panel.js                       │  settings: Victory = "next"
 └────────┼─────────────────────────────┘
          │ { type: "action", action: "next" }
          ▼
 bridge/background.js   (invisible, finds the Figma tab)
          │
          ▼
 bridge/content.js      (inside Figma, presses → )
```

| File | Role |
|---|---|
| `manifest.json` | The extension's ID card for Chrome (explained below) |
| `engine/gestures.js` | Webcam + MediaPipe + anti-accident rules (hold, release, cooldown) |
| `panel/panel.html` `.css` `.js` | The control panel window: `.html` = what's on it, `.css` = how it looks, `.js` = what happens |
| `bridge/background.js` | Opens the panel; forwards actions to the Figma tab |
| `bridge/content.js` | Runs inside Figma; presses the arrow keys |
| `lib/mediapipe/` | Google's MediaPipe library + AI model, used as-is (see its README) |

### manifest.json, line by line

JSON can't contain comments, so here's what each part means:

| Key | Meaning |
|---|---|
| `manifest_version: 3` | The current Chrome extension format ("MV3") |
| `name`, `version`, `description` | Shown on `chrome://extensions` |
| `action` | The extension icon in the toolbar (clicking it opens the panel) |
| `background.service_worker` | `bridge/background.js` runs invisibly in the background |
| `permissions: storage` | Save the settings (`chrome.storage.local`) |
| `permissions: tabs` | Find the Figma tab |
| `permissions: debugger` | Plan B for pressing keys (`USE_DEBUGGER` in background.js) |
| `host_permissions` | The extension may act on `figma.com` pages |
| `content_scripts` | Inject `bridge/content.js` into every Figma page |
| `content_security_policy` | Security rules; `'wasm-unsafe-eval'` is required to run MediaPipe's WebAssembly |

## Team

- Gesture engine (`engine/`)
- Figma bridge (`bridge/`)
- UI (`panel/`)
- Integration & demo
