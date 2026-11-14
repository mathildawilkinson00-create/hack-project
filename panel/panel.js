// =============================================================================
// panel/panel.js — THE CONTROL PANEL (connects everything together)
// =============================================================================
// This is the code of the window that opens when you click the extension icon.
// It has 4 jobs:
//   1. SETTINGS     show the gesture list + sliders, save them in Chrome
//   2. ENGINE       start / stop the camera engine (engine/gestures.js)
//   3. ACTIONS      when the engine reports "gesture X", look up what X is
//                   mapped to (next / prev slide) and send it to the bridge
//   4. KEEP ON TOP  move the panel into a small always-on-top floating window
//
//   engine ──"Victory"──> panel ──{ action: "next" }──> bridge/background.js ──> Figma
// =============================================================================

import { startEngine, stopEngine } from "../engine/gestures.js";

// ---- Default settings (used the first time, or after a version bump) --------
const DEFAULT_SETTINGS = {
  version: 2,        // change this number to reset everyone's saved gesture list to the defaults below
  holdFrames: 8,     // frames a gesture must be held before it fires (~30 frames = 1 second)
  cooldownMs: 1000,  // minimum pause between two actions, in milliseconds
  showTracking: false, // draw the hand skeleton over the camera?
  gestures: {
    // Only these two by default. Others (👍 👎 ✋ ✊ ☝️) can be added with "+ Add gesture".
    Victory: { on: true, action: "next" },
    Three_Fingers: { on: true, action: "prev" },
  },
};

// Gestures the user can pick, with their display names.
// The keys must match the names the engine reports: MediaPipe's built-in names
// (Thumb_Up, Open_Palm...) plus our own finger counting (Pointing_Up, Victory, Three_Fingers).
const LABELS = {
  Thumb_Up: "👍 Thumb up",
  Thumb_Down: "👎 Thumb down",
  Open_Palm: "✋ Open palm",
  Closed_Fist: "✊ Closed fist",
  Pointing_Up: "☝️ One finger",
  Victory: "✌️ Two fingers",
  Three_Fingers: "🖖 Three fingers",
};
// Actions a gesture can do. The keys ("next", "prev") are what we send to the bridge.
const ACTIONS = { next: "Next slide", prev: "Previous slide", none: "Nothing" };

let settings = structuredClone(DEFAULT_SETTINGS); // the current settings (structuredClone = a fresh copy)
let running = false; // is the camera engine on?
let pip = null;      // the floating always-on-top window, when it's open (see part 4)

// Shortcut: $("startBtn") = the element with id="startBtn".
// When the panel is floating, its elements live in the floating window, so we look there.
const $ = (id) => (pip ? pip.document : document).getElementById(id);

// =============================================================================
// 1. SETTINGS
// =============================================================================

// Read the saved settings from Chrome's storage (chrome.storage.local survives closing the window).
async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  if (saved) {
    // Start from the defaults, then overwrite with whatever was saved.
    settings = { ...DEFAULT_SETTINGS, ...saved, gestures: saved.gestures || structuredClone(DEFAULT_SETTINGS.gestures) };
  }
  // Saved list is from an older version → replace it with the new defaults.
  if (settings.version !== DEFAULT_SETTINGS.version) {
    settings.gestures = structuredClone(DEFAULT_SETTINGS.gestures);
    settings.version = DEFAULT_SETTINGS.version;
    saveSettings();
  }
  // Remove saved gestures we don't offer anymore (e.g. ILoveYou, removed earlier).
  for (const name of Object.keys(settings.gestures)) {
    if (!(name in LABELS)) delete settings.gestures[name];
  }
}

function saveSettings() {
  chrome.storage.local.set({ settings });
}

// Build the gesture list: one row per gesture = [checkbox] [name] [action menu] [✕].
function renderGestures() {
  const list = $("gestureList");
  list.innerHTML = ""; // empty the list, then rebuild it from the settings
  for (const [name, g] of Object.entries(settings.gestures)) {
    const row = document.createElement("div");
    row.className = "gesture";
    row.innerHTML = `
      <input type="checkbox" ${g.on ? "checked" : ""}>
      <span class="name">${LABELS[name] || name}</span>
      <select>${Object.entries(ACTIONS)
        .map(([value, text]) => `<option value="${value}" ${value === g.action ? "selected" : ""}>${text}</option>`)
        .join("")}</select>
      <button class="remove" title="Remove this gesture">✕</button>`;
    // When the user changes something in this row → update the settings and save.
    row.querySelector("input").onchange = (e) => { g.on = e.target.checked; saveSettings(); };
    row.querySelector("select").onchange = (e) => { g.action = e.target.value; saveSettings(); };
    row.querySelector(".remove").onclick = () => {
      delete settings.gestures[name];
      saveSettings();
      renderGestures();
    };
    list.appendChild(row);
  }
  if (!Object.keys(settings.gestures).length) {
    list.innerHTML = `<p class="empty">No gestures yet — add one below.</p>`;
  }
  renderAddGesture();
}

// The "+ Add gesture" menu: only lists gestures that aren't in the list yet.
function renderAddGesture() {
  const unused = Object.keys(LABELS).filter((n) => !(n in settings.gestures));
  $("addGesture").hidden = unused.length === 0; // hide it when every gesture is already used
  $("addSelect").innerHTML = unused.map((n) => `<option value="${n}">${LABELS[n]}</option>`).join("");
}
$("addBtn").onclick = () => {
  const name = $("addSelect").value;
  if (!name) return;
  settings.gestures[name] = { on: true, action: "none" };
  saveSettings();
  renderGestures();
};

// Put the saved values into the checkbox and sliders, and show them as text.
function renderSliders() {
  $("tracking").checked = !!settings.showTracking;
  $("hold").value = settings.holdFrames;
  $("cool").value = settings.cooldownMs;
  $("holdVal").textContent = `${settings.holdFrames} frames`;
  $("coolVal").textContent = `${(settings.cooldownMs / 1000).toFixed(1)} s`;
}
// The engine reads this same "settings" object every frame, so changes apply instantly.
$("tracking").onchange = (e) => { settings.showTracking = e.target.checked; saveSettings(); };
$("hold").oninput = (e) => { settings.holdFrames = +e.target.value; renderSliders(); saveSettings(); };
$("cool").oninput = (e) => { settings.cooldownMs = +e.target.value; renderSliders(); saveSettings(); };

// =============================================================================
// Small visual feedback
// =============================================================================

// Show a short message over the camera ("➡️ Next slide!"), hidden after 0.9 s.
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer); // if a message was already showing, restart its timer
  toast.timer = setTimeout(() => t.classList.remove("show"), 900);
}

// "🟢 Listening" / "⚪ Paused" in the header.
function setStatus(on) {
  const s = $("status");
  s.textContent = on ? "🟢 Listening" : "⚪ Paused";
  s.className = `status ${on ? "on" : "off"}`;
}

// =============================================================================
// 3. ACTIONS: send "next" / "prev" to the bridge
// =============================================================================

// Sends { type: "action", action: "next" } to bridge/background.js, which
// passes it to the Figma tab. The bridge answers { ok: true } or { ok: false, error }.
async function sendAction(action) {
  if (action === "none") return;
  const res = await chrome.runtime.sendMessage({ type: "action", action });
  if (res?.ok) toast(action === "next" ? "➡️ Next slide!" : "⬅️ Previous slide!");
  else toast(`⚠️ ${res?.error || "No response"}`);
}

// "Test prev / Test next" buttons: test the bridge without using the camera.
document.querySelectorAll("[data-test]").forEach((b) => (b.onclick = () => sendAction(b.dataset.test)));

// =============================================================================
// 2. ENGINE: start / stop the camera
// =============================================================================

// Called by the engine each time a gesture is accepted (e.g. name = "Victory").
function onGesture(name) {
  const g = settings.gestures[name];
  if (g?.on) sendAction(g.action); // only if this gesture is in the list AND ticked
}

$("startBtn").onclick = async () => {
  if (!running) {
    $("startBtn").textContent = "Loading…";
    try {
      await startEngine({ video: $("video"), canvas: $("canvas"), settings, onGesture });
      running = true;
    } catch (e) {
      console.error(e);
      toast(`⚠️ ${e.message}`);
    }
  } else {
    stopEngine();
    running = false;
  }
  $("startBtn").textContent = running ? "⏸ Stop camera" : "▶ Start camera";
  setStatus(running);
};

// =============================================================================
// 4. KEEP ON TOP (Document Picture-in-Picture)
// =============================================================================
// Chrome can open a small window that floats above EVERY other app, even Figma
// in fullscreen. We move the whole panel into it; closing it moves it back.
// The engine keeps working either way (it reads the webcam directly).

// In the floating window, settings are hidden behind a "⚙ Settings" toggle to save space.
function setSettingsOpen(open) {
  $("settings").hidden = !open;
  $("settingsBtn").textContent = open ? "⚙ Settings ▴" : "⚙ Settings ▾";
}
$("settingsBtn").onclick = () => setSettingsOpen($("settings").hidden);

async function openOnTop() {
  if (!("documentPictureInPicture" in window)) {
    toast("⚠️ Needs Chrome 116 or newer");
    return;
  }
  // 1. Open the floating window.
  const win = await documentPictureInPicture.requestWindow({ width: 320, height: 420 });

  // 2. Give it our stylesheet (it starts as a blank page) and the compact "pip" layout.
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const l = win.document.createElement("link");
    l.rel = "stylesheet";
    l.href = link.href;
    win.document.head.appendChild(l);
  }
  win.document.title = "Gesture Presenter";
  win.document.documentElement.classList.add("pip"); // panel.css has special ":root.pip" styles

  // 3. MOVE the panel's elements into it (they keep their buttons' click handlers).
  const nodes = [...document.body.children].filter((n) => n.tagName !== "SCRIPT");
  win.document.body.append(...nodes);
  pip = win; // from now on, $() looks inside the floating window
  $("video").play().catch(() => {}); // moving a <video> pauses it: restart it

  // 4. Leave a note in the original window, which is now empty.
  const note = document.createElement("p");
  note.id = "pipNote";
  note.className = "pip-note";
  note.textContent = "📌 The panel is floating on top of your screen. Close it to bring it back here. Keep this window open (it can stay behind Figma).";
  document.body.prepend(note);

  $("pipBtn").textContent = "↩ Put back in window";
  setSettingsOpen(false);

  // 5. When the floating window closes: move everything back.
  win.addEventListener("pagehide", () => {
    document.getElementById("pipNote")?.remove();
    document.body.prepend(...nodes);
    pip = null;
    $("video").play().catch(() => {});
    $("pipBtn").textContent = "📌 Keep on top";
    setSettingsOpen(true);
  });
}
$("pipBtn").onclick = () => (pip ? pip.close() : openOnTop().catch((e) => toast(`⚠️ ${e.message}`)));

// =============================================================================
// Start-up: load the saved settings and draw the panel
// =============================================================================
await loadSettings();
renderGestures();
renderSliders();
