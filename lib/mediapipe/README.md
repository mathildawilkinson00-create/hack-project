# lib/mediapipe — don't edit 🔒

This is Google's **MediaPipe** library (`@mediapipe/tasks-vision@0.10.14`) and its pre-trained gesture model, copied here unchanged.
Think of it as an installed app: we **use** it from `engine/gestures.js`, we never edit or read it.

Why is it copied into the repo? Chrome extensions (Manifest V3) are not allowed to load code from the internet, so the library has to live inside the extension.

## Files

| File | What it is |
|---|---|
| `vision_bundle.mjs` | The JavaScript API, the "remote control". It's **minified** (shrunk for speed, unreadable on purpose). We only use `FilesetResolver`, `GestureRecognizer`, `DrawingUtils`. |
| `wasm/vision_wasm_internal.wasm` | The engine. MediaPipe is written in C++ and compiled to **WebAssembly**, so it runs in the browser at near-native speed. |
| `wasm/vision_wasm_internal.js` | Small loader that starts the `.wasm` engine. |
| `gesture_recognizer.task` | The trained AI model, the "brain". Actually a zip with 4 small neural networks (see below). |

## What the model does, step by step

```
camera frame
  → hand_detector            "is there a hand, and where?"
  → hand_landmarks_detector  "where are its 21 joints?"      → result.landmarks (skeleton dots)
  → gesture_embedder         "describe the hand's shape"
  → gesture_classifier       "that shape is Thumb_Up (92%)"  → result.gestures
```

Gestures it knows out of the box: `Thumb_Up`, `Thumb_Down`, `Open_Palm`, `Closed_Fist`, `Pointing_Up`, `Victory`, `ILoveYou` (and `None`).

## Notes

- `manifest.json` needs `'wasm-unsafe-eval'` in its security policy, otherwise Chrome refuses to run the `.wasm`.
- The "no-SIMD" fallback files were removed: every recent Chrome supports SIMD (a CPU feature for doing many calculations at once).
- Everything runs locally: **the video never leaves the laptop**.

Sources: [MediaPipe Gesture Recognizer docs](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer) · npm package `@mediapipe/tasks-vision`.
