// =============================================================================
// renderer/gestures.js — THE GESTURE ENGINE (desktop app copy)
// Same engine as ../engine/gestures.js (the Chrome extension). The ONLY change:
// the two MediaPipe file paths (chrome.runtime.getURL doesn't exist in this app).
// =============================================================================
// Job: watch the webcam and say "the user just did gesture X".
// The panel (panel/panel.js) calls startEngine() and stopEngine(), and gives us
// an onGesture() function to call. This file knows nothing about Figma or
// slides: it only reports gestures. The panel decides what they mean.
//
// How it works, in 4 steps:
//   1. Turn on the webcam
//   2. Load MediaPipe (the AI that finds the hand)
//   3. Look at every webcam image:
//        findGesture()   → which gesture is it?  (uses countFingers())
//        checkGesture()  → held long enough? let go since last time? cooldown over?
//   4. If yes → onGesture("Victory") tells the panel
//
// =============================================================================

import { GestureRecognizer, FilesetResolver, DrawingUtils } from "../lib/mediapipe/vision_bundle.mjs";

// ---- Hide MediaPipe's internal log messages ---------------------------------
// MediaPipe's C++ engine prints harmless technical notes in the console, like
//   "W1114 18:20:51 gl_context.cc:1060] OpenGL error checking is disabled"
//   "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."
// Chrome lists them as "Errors" on chrome://extensions. This hides ONLY those
// lines (they start with "INFO:" or W/I + 4 digits); everything else still shows.
const isMediaPipeNote = (args) => typeof args[0] === "string" && /^(INFO:|[WI]\d{4} )/.test(args[0]);
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    if (!isMediaPipeNote(args)) original.apply(console, args);
  };
}

// ---- The engine's variables --------------------------------------------------
let recognizer = null; // the MediaPipe AI (loaded only once)
let stream = null;     // the webcam stream (kept so we can turn it off)
let reader = null;     // hands us webcam frames one by one
let running = false;   // true = the engine is on

// Memory between two images (used by checkGesture)
let lastGesture = null;  // gesture seen in the previous image
let framesHeld = 0;      // how many images in a row we've seen it
let lastActionTime = 0;  // time of the last action (for the cooldown)
let firedGesture = null; // gesture that just triggered an action
let framesReleased = 0;  // how many images it has been let go

// How many "different" images before a gesture counts as let go.
// 4 instead of 1 because MediaPipe sometimes flickers for 1–2 images.
const RELEASE_FRAMES = 4;

// =============================================================================
//  START
// =============================================================================
export async function startEngine({ video, canvas, settings, onGesture }) {
  if (running) return; // already on

  // ---- Step 1: the webcam ----
  // Chrome shows the "Allow camera?" prompt here the first time.
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  } catch (error) {
    if (error.name === "NotAllowedError") throw new Error("Camera access denied. Allow it in Windows Settings > Privacy > Camera (desktop apps).");
    if (error.name === "NotFoundError") throw new Error("No camera found.");
    throw error;
  }
  video.srcObject = stream; // show the camera in the panel's <video>
  await video.play();

  // ---- Step 2: MediaPipe ----
  // The files are in lib/mediapipe/ (shipped with the app, no download needed).
  try {
    if (!recognizer) {
      const fileset = await FilesetResolver.forVisionTasks(new URL("../lib/mediapipe/wasm", import.meta.url).href);
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("../lib/mediapipe/gesture_recognizer.task", import.meta.url).href },
        runningMode: "VIDEO", // we'll send a continuous stream of images
        numHands: 1,          // only one hand
      });
    }
  } catch (error) {
    stopEngine(); // the AI failed to load: turn the camera back off
    throw error;
  }

  // ---- Step 3: look at every image ----
  running = true;
  lastGesture = null; // start with a clean memory
  framesHeld = 0;
  firedGesture = null;
  framesReleased = 0;

  const ctx = canvas.getContext("2d");  // to draw on the transparent canvas over the video
  const drawer = new DrawingUtils(ctx); // MediaPipe's tool to draw the hand

  // Called for each webcam image (~30 times per second).
  function analyseImage(image) {
    // The canvas must be the same size as the image
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ask MediaPipe to look at the image
    const result = recognizer.recognizeForVideo(image, performance.now());
    const hand = result.landmarks[0]; // the hand's 21 points (or undefined if no hand)

    // "Show hand tracking" option: draw the hand
    if (settings.showTracking && hand) {
      drawer.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: "#00e5ff", lineWidth: 3 });
      drawer.drawLandmarks(hand, { color: "#ff4081", radius: 3 });
    }

    // Which gesture is it? (e.g. "Thumb_Up", "Victory", or null)
    const gesture = findGesture(result, hand, canvas.width, canvas.height);

    // ---- Step 4: decide whether to trigger an action ----
    checkGesture(gesture, settings, onGesture);
  }

  // The loop: read images straight from the webcam.
  // Why not requestAnimationFrame (simpler)? Chrome PAUSES it when the window
  // is minimized or hidden behind Figma fullscreen, and gestures would stop
  // during the presentation. Reading the webcam directly keeps working.
  const track = stream.getVideoTracks()[0];
  reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const myReader = reader; // if the engine is restarted, this old loop sees it and stops

  async function loop() {
    while (running && reader === myReader) {
      let frame;
      try {
        const { done, value } = await myReader.read(); // wait for the next webcam image
        if (done) break; // the camera was turned off
        frame = value;
        const image = await createImageBitmap(frame); // convert it into an image MediaPipe accepts
        try {
          analyseImage(image);
        } finally {
          image.close(); // free memory right away (30 images per second adds up fast)
        }
      } catch (error) {
        if (running) console.error("[engine] image error", error);
      } finally {
        frame?.close(); // free the raw frame's memory too
      }
    }
  }
  loop(); // no "await": the loop runs in the background, startEngine returns right away
}

// =============================================================================
//  FIND THE GESTURE
// =============================================================================
// Returns the gesture's name ("Thumb_Up", "Victory", "Three_Fingers"...) or null.
function findGesture(result, hand, width, height) {
  // The name MediaPipe gives (Thumb_Up, Thumb_Down, Open_Palm, Closed_Fist...)
  let name = null;
  if (result.gestures.length > 0) {
    name = result.gestures[0][0].categoryName;
  }

  // "None" = MediaPipe sees a hand but no known gesture.
  // "Pointing_Up" and "Victory" = MediaPipe only recognizes them with fingers
  // pointing UP. We ignore those three and count the fingers ourselves.
  if (name === "None" || name === "Pointing_Up" || name === "Victory") name = null;

  if (hand) {
    // First check the 🤟 love sign. If it is one, we are done: no need to count fingers.
    if (isLoveSign(hand, width, height)) return "ILoveYou";

    const fingers = countFingers(hand, width, height);
    if (fingers === 1) name = "Pointing_Up";   // 1 finger
    if (fingers === 2) name = "Victory";       // 2 fingers
    if (fingers === 3) name = "Three_Fingers"; // 3 fingers
  }
  return name;
}

// =============================================================================
//  SMALL HELPER: distance between two points
// =============================================================================
// MediaPipe gives every point as numbers between 0 and 1 (a share of the image
// width / height), so we multiply by the image size to get pixels. Then
// Math.hypot(dx, dy) = the straight-line distance (Pythagoras).
function distance(a, b, width, height) {
  const dx = (a.x - b.x) * width;
  const dy = (a.y - b.y) * height;
  return Math.hypot(dx, dy);
}

// =============================================================================
//  WHICH FINGERS ARE UP? (works in every direction)
// =============================================================================
// Idea: a finger is UP if its tip is FARTHER from the wrist than its middle
// joint. When the finger is bent, the tip comes back toward the palm, so it's
// closer to the wrist. Works with the hand pointing up, down or sideways.
//
// MediaPipe's points used (numbered 0 to 20):
//   0 = wrist
//   index  : tip 8,  joint 6
//   middle : tip 12, joint 10
//   ring   : tip 16, joint 14
//   pinky  : tip 20, joint 18
//
// Returns something like { index: true, middle: true, ring: false, pinky: false }.
function fingersUp(hand, width, height) {
  const wrist = hand[0];

  // Returns true if the finger is up
  function isUp(tipNumber, jointNumber) {
    const tipDistance = distance(hand[tipNumber], wrist, width, height);
    const jointDistance = distance(hand[jointNumber], wrist, width, height);
    return tipDistance > jointDistance * 1.15; // 1.15 = tip must be 15% farther (half-bent fingers don't count)
  }

  return {
    index: isUp(8, 6),
    middle: isUp(12, 10),
    ring: isUp(16, 14),
    pinky: isUp(20, 18),
  };
}

// =============================================================================
//  COUNT THE FINGERS
// =============================================================================
// Returns 1, 2 or 3 (index, index+middle, index+middle+ring), or 0 if it's none of those.
function countFingers(hand, width, height) {
  const { index, middle, ring, pinky } = fingersUp(hand, width, height);

  // Rules: the index must be up and the pinky folded
  if (pinky || !index) return 0;
  if (middle && ring) return 3; // index + middle + ring
  if (middle) return 2;         // index + middle
  if (!ring) return 1;          // index only
  return 0;                     // odd combo (index + ring): ignore
}

// =============================================================================
//  LOVE SIGN 🤟 (works in every direction)
// =============================================================================
// "I love you" in sign language = thumb + index + pinky up, middle + ring folded.
// MediaPipe also knows it ("ILoveYou") but mostly with the hand upright, so we
// check it ourselves with the same distance idea as the fingers.
function isLoveSign(hand, width, height) {
  const palmLength = distance(hand[0], hand[9], width, height); // wrist → base of the middle finger

  // Thumb out? Its tip must be far from the base of the pinky (point 17).
  // A thumb folded over the palm stays close to it.
  const thumbOut = distance(hand[4], hand[17], width, height) > palmLength * 0.9; // 0.9 = tune here if needed

  const fingers = fingersUp(hand, width, height);
  const indexAndPinkyUp = fingers.index && fingers.pinky;
  const middleAndRingFolded = !fingers.middle && !fingers.ring;

  return thumbOut && indexAndPinkyUp && middleAndRingFolded;
}

// =============================================================================
//  CHECK WHETHER TO TRIGGER AN ACTION (the anti-accident rules)
// =============================================================================
function checkGesture(gesture, settings, onGesture) {
  // 1. HOLD: count how many images in a row we've seen the same gesture
  if (gesture !== null && gesture === lastGesture) {
    framesHeld = framesHeld + 1;
  } else {
    lastGesture = gesture;
    framesHeld = 1;
  }

  // 2. RELEASE: a gesture just fired → it must be LET GO before it can fire again
  //    (close the hand, change gesture or take the hand away).
  //    → holding ✌️ for 5 seconds moves only ONE slide.
  if (firedGesture !== null) {
    if (gesture !== firedGesture) {
      framesReleased = framesReleased + 1;
    } else {
      framesReleased = 0;
    }
    if (framesReleased >= RELEASE_FRAMES) {
      firedGesture = null; // let go: ready for a new gesture
      framesReleased = 0;
    }
    return; // no action until it's let go
  }

  // 3. COOLDOWN + the conditions to trigger
  const hasGesture = gesture !== null;
  const heldLongEnough = framesHeld >= settings.holdFrames;
  const cooldownOver = performance.now() - lastActionTime >= settings.cooldownMs;

  if (hasGesture && heldLongEnough && cooldownOver) {
    lastActionTime = performance.now();
    firedGesture = gesture;
    framesReleased = 0;
    framesHeld = 0;
    onGesture(gesture); // tell the panel: "this gesture was just made"
  }
}

// =============================================================================
//  STOP
// =============================================================================
export function stopEngine() {
  running = false;                  // the loop stops
  reader?.cancel().catch(() => {}); // stop reading images
  reader = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop()); // turns off the webcam (its light goes off)
    stream = null;
  }
}
