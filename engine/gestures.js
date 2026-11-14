// Gesture engine: camera + MediaPipe Gesture Recognizer + hold/cooldown logic.
// Owner: gesture engine person. Contract: see CLAUDE.md.
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "../lib/mediapipe/vision_bundle.mjs";

let recognizer = null;
let stream = null;
let rafId = 0;
let reader = null;
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

  // Analyse one camera frame (source = video element or ImageBitmap).
  const step = (source, w, h) => {
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const result = recognizer.recognizeForVideo(source, performance.now());
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

  // Frame source. Preferred: read frames straight from the camera track, which
  // keeps working when the window is minimized/hidden (requestAnimationFrame and
  // the <video> render loop are paused by Chrome in that case).
  const track = stream.getVideoTracks()[0];
  if (typeof MediaStreamTrackProcessor === "function") {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const r = reader;
    (async () => {
      while (running && r === reader) {
        let frame;
        try {
          const res = await r.read();
          if (res.done || !res.value) break;
          frame = res.value;
          const bmp = await createImageBitmap(frame);
          try { step(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
        } catch (e) {
          if (running) console.error("[engine] frame error", e);
        } finally {
          frame?.close();
        }
      }
    })();
  } else {
    // Fallback (visible window only).
    const loop = () => {
      if (!running) return;
      rafId = requestAnimationFrame(loop);
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      step(video, video.videoWidth, video.videoHeight);
    };
    loop();
  }
}

// Orientation-independent finger detection. A finger is "extended" when its tip
// is farther from the wrist than its middle joint, whatever the hand direction.
// Returns "Pointing_Up" (1 finger: index), "Victory" (2 fingers: index+middle),
// "Three_Fingers" (index+middle+ring), else null. The pinky must stay folded.
// (Pointing_Up / Victory names reused from MediaPipe so settings/labels stay the same.)
function fingerGesture(lm, w, h) {
  const d = (a, b) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  const wrist = lm[0];
  const extended = ([tip, pip]) => d(lm[tip], wrist) > d(lm[pip], wrist) * 1.15;
  const [index, middle, ring, pinky] = [[8, 6], [12, 10], [16, 14], [20, 18]].map(extended);
  if (pinky || !index) return null;
  if (middle && ring) return "Three_Fingers";
  if (middle && !ring) return "Victory";
  if (!middle && !ring) return "Pointing_Up";
  return null;
}

export function stopEngine() {
  running = false;
  cancelAnimationFrame(rafId);
  if (reader) {
    reader.cancel().catch(() => {});
    reader = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
