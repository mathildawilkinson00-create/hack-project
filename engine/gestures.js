// =============================================================================
// engine/gestures.js — THE GESTURE ENGINE
// =============================================================================
// Job: watch the webcam and say "the user just did gesture X".
//
//   webcam frame ─> MediaPipe ─> gesture name ─> hold / release / cooldown ─> onGesture(name)
//                  (the AI)     ("Victory")       rules (anti-accident)        (tell the panel)
//
// The panel (panel/panel.js) calls startEngine() and stopEngine(), and gives
// us an onGesture() function to call. This file knows nothing about Figma or
// slides: it only reports gestures. The panel decides what they mean.
// =============================================================================

import { GestureRecognizer, FilesetResolver, DrawingUtils } from "../lib/mediapipe/vision_bundle.mjs";

// ---- Hide MediaPipe's internal log messages ---------------------------------
// MediaPipe's C++ engine prints technical notes in the console, like
//   "W1114 18:20:51 gl_context.cc:1060] OpenGL error checking is disabled"
//   "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."
// They are harmless, but Chrome lists them as "Errors" on chrome://extensions.
// This hides ONLY those lines (they start with "INFO:" or W/I + 4 digits);
// every other console message still shows normally.
const isMediaPipeNote = (args) => typeof args[0] === "string" && /^(INFO:|[WI]\d{4} )/.test(args[0]);
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    if (!isMediaPipeNote(args)) original.apply(console, args);
  };
}

// ---- Engine state (remembered between frames) -------------------------------
let recognizer = null; // the loaded MediaPipe model (loaded once, then reused)
let stream = null;     // the webcam stream (kept so we can turn it off)
let reader = null;     // hands us webcam frames one by one
let running = false;   // true while the engine is on

// After a gesture fires, how many frames you must "let go" of it before it can
// fire again. 4 instead of 1 because MediaPipe sometimes flickers for 1–2 frames.
const RELEASE_FRAMES = 4;

// =============================================================================
// startEngine: turn on the camera, load the AI, start watching.
// =============================================================================
export async function startEngine({ video, canvas, settings, onGesture }) {
  if (running) return; // already on

  // ---- Step 1: turn on the webcam ----
  // Chrome shows the "allow camera?" prompt the first time.
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
    });
  } catch (e) {
    // Turn Chrome's technical error names into messages people understand.
    if (e.name === "NotAllowedError") throw new Error("Camera access denied. Allow it in Chrome site settings.");
    if (e.name === "NotFoundError") throw new Error("No camera found.");
    throw e;
  }
  // Show the camera in the panel. (This <video> is only for display: the
  // detection reads frames directly from the webcam, see step 4.)
  video.srcObject = stream;
  await video.play();

  // ---- Step 2: load MediaPipe (only the first time) ----
  try {
    if (!recognizer) {
      // Load the WebAssembly engine from OUR folder (extensions can't load code from the internet).
      const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("lib/mediapipe/wasm"));
      // Load the trained AI model. VIDEO mode = we'll send a continuous stream of frames.
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL("lib/mediapipe/gesture_recognizer.task") },
        runningMode: "VIDEO",
        numHands: 1,
      });
    }
  } catch (e) {
    stopEngine(); // the AI failed to load: turn the camera back off
    throw e;
  }

  running = true;
  const ctx = canvas.getContext("2d");  // to draw on the transparent canvas over the video
  const drawer = new DrawingUtils(ctx); // MediaPipe's helper to draw hand skeletons

  // Memory for the anti-accident rules (steps 3d–3f).
  let lastName = null;   // gesture seen in the previous frame
  let heldFrames = 0;    // how many frames in a row we've seen it
  let lastFire = 0;      // time (ms) of the last accepted gesture
  let firedName = null;  // gesture that just fired, waiting to be let go
  let releaseFrames = 0; // how many frames it has been let go

  // ---- Step 3: analyse ONE webcam image (called ~30 times per second) ----
  function analyseFrame(image) {
    // Keep the drawing canvas the same size as the webcam image.
    if (canvas.width !== image.width) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height); // erase the previous skeleton

    // 3a. Ask MediaPipe what it sees. The result contains:
    //   result.landmarks → 21 points per hand, each { x, y } between 0 and 1
    //   result.gestures  → its guess, e.g. [[{ categoryName: "Thumb_Up", score: 0.92 }]]
    const result = recognizer.recognizeForVideo(image, performance.now());
    const hand = result.landmarks[0]; // first hand's 21 points (undefined if no hand)

    // 3b. Draw the hand skeleton, if "Show hand tracking" is ticked.
    if (settings.showTracking && hand) {
      drawer.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: "#00e5ff", lineWidth: 3 });
      drawer.drawLandmarks(hand, { color: "#ff4081", radius: 3 });
    }

    // 3c. Decide which gesture it is.
    let name = result.gestures[0]?.[0]?.categoryName ?? null;
    // MediaPipe only recognizes 1 or 2 fingers when they point UP, and doesn't
    // know 3 fingers at all. So for those we ignore its answer and count the
    // fingers ourselves (see fingerGesture below).
    if (name === "Pointing_Up" || name === "Victory") name = null;
    const fingers = hand ? fingerGesture(hand, canvas.width, canvas.height) : null;
    if (fingers) name = fingers;
    if (name === "None") name = null; // MediaPipe's way of saying "a hand, but no known gesture"

    // 3d. HOLD rule: count how many frames in a row we've seen the same gesture.
    if (name && name === lastName) heldFrames++;
    else {
      lastName = name;
      heldFrames = 1;
    }

    // 3e. RELEASE rule: after a gesture fires, you must let go of it (other
    // gesture, closed hand or no hand) before it can fire again.
    // → holding ✌️ for 5 seconds moves only ONE slide.
    if (firedName) {
      if (name !== firedName) releaseFrames++;
      else releaseFrames = 0;
      if (releaseFrames >= RELEASE_FRAMES) {
        firedName = null;
        releaseFrames = 0;
        heldFrames = name ? 1 : 0;
      }
      return; // nothing can fire until the gesture is let go
    }

    // 3f. FIRE if held long enough (hold time) AND the cooldown since the last action is over.
    const now = performance.now();
    if (name && heldFrames >= settings.holdFrames && now - lastFire >= settings.cooldownMs) {
      lastFire = now;
      heldFrames = 0;
      firedName = name;
      releaseFrames = 0;
      onGesture(name); // tell the panel → it decides what to do (next/prev slide)
    }
  }

  // ---- Step 4: the frame loop ----
  // We read frames straight from the webcam (MediaStreamTrackProcessor) instead
  // of from the <video>. Why: Chrome pauses videos and animations in windows
  // that are minimized or hidden behind Figma, which would freeze detection.
  const track = stream.getVideoTracks()[0];
  reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const myReader = reader; // if the engine is restarted, this old loop sees it and stops

  async function frameLoop() {
    while (running && reader === myReader) {
      let frame;
      try {
        const { done, value } = await myReader.read(); // wait for the next webcam frame
        if (done) break; // the camera was turned off
        frame = value;
        const image = await createImageBitmap(frame); // convert it into an image MediaPipe accepts
        try {
          analyseFrame(image);
        } finally {
          image.close(); // free memory right away (30 images per second adds up fast)
        }
      } catch (e) {
        if (running) console.error("[engine] frame error", e);
      } finally {
        frame?.close(); // free the raw frame's memory too
      }
    }
  }
  frameLoop(); // no "await": the loop runs in the background, startEngine returns right away
}

// =============================================================================
// fingerGesture: our own finger counting, works whatever way the hand points.
// =============================================================================
// MediaPipe gives 21 points per hand, numbered like this:
//
//   0 = wrist
//   thumb:          1  2  3  4 (tip)
//   index finger:   5  6  7  8 (tip)      6 = middle joint
//   middle finger:  9 10 11 12 (tip)     10 = middle joint
//   ring finger:   13 14 15 16 (tip)     14 = middle joint
//   pinky:         17 18 19 20 (tip)     18 = middle joint
//
// A finger is "extended" (straight) when its tip is clearly farther from the
// wrist than its middle joint. Distances don't care about direction, so it
// works with the hand pointing up, sideways or down.
//
// Returns "Pointing_Up" (☝️ index only), "Victory" (✌️ index + middle),
// "Three_Fingers" (index + middle + ring), or null. The pinky must stay folded.
// (We reuse MediaPipe's names "Pointing_Up" / "Victory" so the panel labels match.)
function fingerGesture(points, width, height) {
  // Distance between two points in pixels (points are 0–1, so multiply by the image size).
  const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const wrist = points[0];
  // × 1.15 = the tip must be at least 15% farther than the joint, so half-bent fingers don't count.
  const isExtended = (tip, joint) => distance(points[tip], wrist) > distance(points[joint], wrist) * 1.15;

  const index = isExtended(8, 6);
  const middle = isExtended(12, 10);
  const ring = isExtended(16, 14);
  const pinky = isExtended(20, 18);

  if (pinky || !index) return null; // every gesture needs the index up and the pinky down
  if (middle && ring) return "Three_Fingers";
  if (middle) return "Victory";
  if (!ring) return "Pointing_Up";
  return null; // odd combo (index + ring only): ignore
}

// =============================================================================
// stopEngine: stop watching and turn off the camera.
// =============================================================================
export function stopEngine() {
  running = false;
  reader?.cancel().catch(() => {}); // stop reading frames
  reader = null;
  stream?.getTracks().forEach((t) => t.stop()); // turn off the webcam (its light goes off)
  stream = null;
}
