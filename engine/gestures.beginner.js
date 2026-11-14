// ============================================================
//  VERSION DÉBUTANT du moteur de gestes
// ============================================================
// Même API que gestures.js : startEngine() et stopEngine().
// Pour l'utiliser, dans panel/panel.js, remplace
//     "../engine/gestures.js"  par  "../engine/gestures.beginner.js"
//
// Ce que fait ce fichier, en 4 étapes :
//   1. Ouvrir la caméra
//   2. Charger MediaPipe (l'IA qui trouve la main)
//   3. Regarder chaque image de la caméra
//   4. Si un geste est tenu assez longtemps -> prévenir le panel
//
// Différence avec gestures.js : ici on utilise requestAnimationFrame
// (plus simple), donc la fenêtre doit rester visible (pas minimisée).

import { GestureRecognizer, FilesetResolver, DrawingUtils } from "../lib/mediapipe/vision_bundle.mjs";

// ---------- Les variables du moteur ----------
let recognizer = null;   // l'IA MediaPipe (chargée une seule fois)
let stream = null;       // le flux de la caméra
let running = false;     // true = le moteur tourne
let animationId = 0;     // pour pouvoir arrêter la boucle

// Mémoire entre deux images
let lastGesture = null;  // le geste vu à l'image précédente
let framesHeld = 0;      // depuis combien d'images on tient ce geste
let lastActionTime = 0;  // moment de la dernière action (pour le cooldown)
let firedGesture = null; // geste qui vient de déclencher une action
let framesReleased = 0;  // depuis combien d'images on a relâché ce geste

// Nombre d'images "différentes" pour considérer le geste comme relâché
const RELEASE_FRAMES = 4;

// ============================================================
//  DÉMARRER
// ============================================================
export async function startEngine({ video, canvas, settings, onGesture }) {
  if (running) return; // déjà démarré

  // ---------- Étape 1 : la caméra ----------
  // Chrome affiche ici la fenêtre "Autoriser la caméra ?".
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (error) {
    if (error.name === "NotAllowedError") throw new Error("Caméra refusée. Autorise-la dans Chrome.");
    if (error.name === "NotFoundError") throw new Error("Aucune caméra trouvée.");
    throw error;
  }
  video.srcObject = stream; // on affiche la caméra dans <video>
  await video.play();

  // ---------- Étape 2 : MediaPipe ----------
  // Les fichiers sont dans lib/mediapipe/ (pas de CDN : interdit par Chrome).
  if (!recognizer) {
    const wasmFolder = chrome.runtime.getURL("lib/mediapipe/wasm");
    const fileset = await FilesetResolver.forVisionTasks(wasmFolder);
    recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL("lib/mediapipe/gesture_recognizer.task") },
      runningMode: "VIDEO",
      numHands: 1, // une seule main
    });
  }

  // ---------- Étape 3 : la boucle ----------
  running = true;
  firedGesture = null;
  lastGesture = null;
  framesHeld = 0;

  const ctx = canvas.getContext("2d");
  const drawer = new DrawingUtils(ctx); // outil pour dessiner la main

  // Cette fonction est appelée à chaque image de la caméra (~30 fois par seconde).
  function loop() {
    if (!running) return; // on s'arrête si stopEngine() a été appelé
    animationId = requestAnimationFrame(loop); // programme l'image suivante

    if (video.readyState < 2) return; // la vidéo n'est pas encore prête

    // Le canvas doit avoir la même taille que la vidéo
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // On demande à MediaPipe de regarder l'image actuelle
    const result = recognizer.recognizeForVideo(video, performance.now());
    const hand = result.landmarks[0]; // les 21 points de la main (ou undefined si pas de main)

    // Option "Show hand tracking" : dessiner la main
    if (settings.showTracking && hand) {
      drawer.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, { color: "#00e5ff", lineWidth: 3 });
      drawer.drawLandmarks(hand, { color: "#ff4081", radius: 3 });
    }

    // Quel geste fait-on ? (ex : "Thumb_Up", "Victory", ou null)
    const gesture = findGesture(result, hand, canvas.width, canvas.height);

    // ---------- Étape 4 : décider si on déclenche une action ----------
    checkGesture(gesture, settings, onGesture);
  }
  loop();
}

// ============================================================
//  TROUVER LE GESTE
// ============================================================
function findGesture(result, hand, width, height) {
  // Le nom donné par MediaPipe (Thumb_Up, Thumb_Down, Open_Palm, Closed_Fist...)
  let name = null;
  if (result.gestures.length > 0) {
    name = result.gestures[0][0].categoryName;
  }

  // MediaPipe ne reconnaît "Pointing_Up" et "Victory" que si les doigts
  // pointent vers le haut. On les ignore et on compte les doigts nous-mêmes.
  if (name === "Pointing_Up" || name === "Victory") name = null;

  if (hand) {
    const fingers = countFingers(hand, width, height);
    if (fingers === 1) name = "Pointing_Up";    // 1 doigt
    if (fingers === 2) name = "Victory";        // 2 doigts
    if (fingers === 3) name = "Three_Fingers";  // 3 doigts
  }
  return name;
}

// ============================================================
//  COMPTER LES DOIGTS (marche dans toutes les directions)
// ============================================================
// Idée : un doigt est LEVÉ si le bout du doigt est plus LOIN du poignet
// que l'articulation du milieu. Si le doigt est plié, le bout revient
// vers la paume, donc plus près du poignet. Ça marche main en haut,
// en bas ou de côté.
//
// Les points MediaPipe utilisés (numéros de 0 à 20) :
//   0 = poignet
//   index   : bout 8,  articulation 6
//   majeur  : bout 12, articulation 10
//   annul.  : bout 16, articulation 14
//   auricul.: bout 20, articulation 18
function countFingers(hand, width, height) {
  // Distance entre deux points, en pixels
  function distance(a, b) {
    const dx = (a.x - b.x) * width;
    const dy = (a.y - b.y) * height;
    return Math.hypot(dx, dy);
  }

  const wrist = hand[0];

  // Renvoie true si le doigt est levé
  function isUp(tipNumber, jointNumber) {
    const tipDistance = distance(hand[tipNumber], wrist);
    const jointDistance = distance(hand[jointNumber], wrist);
    return tipDistance > jointDistance * 1.15; // 1.15 = sensibilité
  }

  const index = isUp(8, 6);
  const middle = isUp(12, 10);
  const ring = isUp(16, 14);
  const pinky = isUp(20, 18);

  // Règles : l'index doit être levé et l'auriculaire plié
  if (pinky || !index) return 0;
  if (middle && ring) return 3;  // index + majeur + annulaire
  if (middle) return 2;          // index + majeur
  if (!ring) return 1;           // index seul
  return 0;
}

// ============================================================
//  VÉRIFIER SI ON DÉCLENCHE UNE ACTION
// ============================================================
function checkGesture(gesture, settings, onGesture) {
  // 1. Compter depuis combien d'images on tient le même geste
  if (gesture !== null && gesture === lastGesture) {
    framesHeld = framesHeld + 1;
  } else {
    lastGesture = gesture;
    framesHeld = 1;
  }

  // 2. Un geste vient de déclencher : il faut le RELÂCHER avant de refaire
  //    (fermer le poing, changer de geste ou sortir la main).
  if (firedGesture !== null) {
    if (gesture !== firedGesture) {
      framesReleased = framesReleased + 1;
    } else {
      framesReleased = 0;
    }
    if (framesReleased >= RELEASE_FRAMES) {
      firedGesture = null; // c'est relâché : on est prêt pour un nouveau geste
      framesReleased = 0;
    }
    return; // pas d'action tant que ce n'est pas relâché
  }

  // 3. Les conditions pour déclencher
  const hasGesture = gesture !== null && gesture !== "None";
  const heldLongEnough = framesHeld >= settings.holdFrames;
  const cooldownOver = performance.now() - lastActionTime >= settings.cooldownMs;
  const isEnabled = settings.enabled !== false;

  if (hasGesture && heldLongEnough && cooldownOver && isEnabled) {
    lastActionTime = performance.now();
    firedGesture = gesture;
    framesReleased = 0;
    framesHeld = 0;
    onGesture(gesture); // on prévient le panel : "ce geste vient d'être fait"
  }
}

// ============================================================
//  ARRÊTER
// ============================================================
export function stopEngine() {
  running = false;                    // la boucle s'arrête
  cancelAnimationFrame(animationId);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop()); // éteint la caméra
    stream = null;
  }
}
