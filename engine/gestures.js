// Gesture engine: camera + MediaPipe Gesture Recognizer + hold/cooldown logic.
// Owner: gesture engine person. Contract: see CLAUDE.md.
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "../lib/mediapipe/vision_bundle.mjs";

let recognizer = null;
let stream = null;
let rafId = 0;
let running = false;

export async function startEngine({ video, canvas, settings, onGesture }) {
  if (running) return;

  // 1. Camera (Chrome shows the permission prompt here).
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
  } catch (e) {
    stream = null;
    if (e.name === "NotAllowedError") throw new Error("Camera access denied. Allow it in Chrome site settings.");
    if (e.name === "NotFoundError") throw new Error("No camera found.");
    throw e;
  }
  video.srcObject = stream;
  await video.play();

  // 2. MediaPipe (bundled locally, no CDN).
  try {
    if (!recognizer) {
      const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("lib/mediapipe/wasm"));
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL("lib/mediapipe/gesture_recognizer.task") },
        runningMode: "VIDEO",
        numHands: 1,
      });
    }
  } catch (e) {
    stopEngine();
    throw e;
  }

  // 3. Detection loop with hold + cooldown.
  running = true;
  const ctx = canvas.getContext("2d");
  const drawer = new DrawingUtils(ctx);
  let lastName = null;
  let heldFrames = 0;
  let lastFire = 0;
  let lastVideoTime = -1;
  let firedName = null; // gesture that just fired, waiting for release
  let releaseFrames = 0;
  const RELEASE_FRAMES = 4; // tolerance for 1-2 frame detection flickers

  const loop = () => {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const result = recognizer.recognizeForVideo(video, performance.now());
    // Optional hand tracking overlay (settings.showTracking).
    if (settings.showTracking) {
      for (const lm of result.landmarks ?? []) {
        drawer.drawConnectors(lm, GestureRecognizer.HAND_CONNECTIONS, { color: "#00e5ff", lineWidth: 3 });
        drawer.drawLandmarks(lm, { color: "#ff4081", radius: 3 });
      }
    }
    let name = result.gestures?.[0]?.[0]?.categoryName ?? null;
    // MediaPipe's Pointing_Up / Victory only work with fingers pointing up.
    // Replace them with our own orientation-independent detection.
    if (name === "Pointing_Up" || name === "Victory") name = null;
    const fingers = result.landmarks?.[0] ? fingerGesture(result.landmarks[0], canvas.width, canvas.height) : null;
    if (fingers) name = fingers;

    if (name && name === lastName) heldFrames++;
    else { lastName = name; heldFrames = 1; }

    // After a gesture fires, it must be released (hand closed / other gesture /
    // hand gone) for RELEASE_FRAMES frames before it can fire again.
    if (firedName) {
      if (name !== firedName) releaseFrames++;
      else releaseFrames = 0;
      if (releaseFrames >= RELEASE_FRAMES) { firedName = null; releaseFrames = 0; heldFrames = name ? 1 : 0; }
      return;
    }

    const now = performance.now();
    if (
      name && name !== "None" &&
      settings.enabled !== false &&
      heldFrames >= settings.holdFrames &&
      now - lastFire >= settings.cooldownMs
    ) {
      lastFire = now;
      heldFrames = 0;
      firedName = name;
      releaseFrames = 0;
      onGesture(name);
    }
  };
  loop();
}

// Orientation-independent finger detection. A finger is "extended" when its tip
// is farther from the wrist than its middle joint, whatever the hand direction.
// Returns "Pointing_Up" (index only) or "Victory" (index + middle only), else null.
// (Names reused from MediaPipe so settings/labels stay the same.)
function fingerGesture(lm, w, h) {
  const d = (a, b) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  const wrist = lm[0];
  const extended = ([tip, pip]) => d(lm[tip], wrist) > d(lm[pip], wrist) * 1.15;
  const [index, middle, ring, pinky] = [[8, 6], [12, 10], [16, 14], [20, 18]].map(extended);
  if (ring || pinky) return null;
  if (index && !middle) return "Pointing_Up";
  if (index && middle) return "Victory";
  return null;
}

export function stopEngine() {
  running = false;
  cancelAnimationFrame(rafId);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
