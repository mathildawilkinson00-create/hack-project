// =============================================================================
// panel/panel.js — THE CONTROL PANEL'S BRAIN
// =============================================================================
// panel.html = WHAT is on the page, panel.css = how it LOOKS,
// panel.js (this file) = what HAPPENS when you click things.
//
// This file has 3 jobs:
//   1. SETTINGS  show the gesture list + sliders, save them in Chrome
//   2. ENGINE    start / stop the camera engine (engine/gestures.js)
//   3. ACTIONS   when the engine reports "gesture X", look up what X is
//                mapped to (next / prev slide) and send it to the bridge
//
//   engine ──"Victory"──> panel ──{ action: "next" }──> bridge/background.js ──> Figma
// =============================================================================

import { startEngine, stopEngine } from "../engine/gestures.js";

// ---- Default settings (used the first time you open the panel) --------------
const DEFAULT_SETTINGS = {
  version: 2,          // change this number to reset everyone's saved settings to these defaults
  holdFrames: 8,       // frames a gesture must be held before it fires (~30 frames = 1 second)
  cooldownMs: 1000,    // minimum pause between two actions, in milliseconds
  showTracking: false, // draw the hand skeleton over the camera?
  gestures: {
    // Only these two by default. Others can be added with "+ Add gesture".
    Victory: { on: true, action: "next" },
    Three_Fingers: { on: true, action: "prev" },
  },
};

// Every gesture the user can pick, with its display name.
// The keys must match the names the engine reports (see engine/gestures.js).
const LABELS = {
  Thumb_Up: "👍 Thumb up",
  Thumb_Down: "👎 Thumb down",
  Open_Palm: "✋ Open palm",
  Closed_Fist: "✊ Closed fist",
  Pointing_Up: "☝️ One finger",
  Victory: "✌️ Two fingers",
  Three_Fingers: "🖖 Three fingers",
};

let settings = structuredClone(DEFAULT_SETTINGS); // the current settings (structuredClone = a fresh copy)
let running = false;  // is the camera engine on?
let toastTimer = null; // timer that hides the "➡️ Next slide!" message

// Shortcut: $("startBtn") = the element with id="startBtn" in panel.html.
const $ = (id) => document.getElementById(id);

// =============================================================================
// 1. SETTINGS
// =============================================================================

// Read the saved settings from Chrome (chrome.storage.local survives closing the window).
// We only use them if they come from the current version; otherwise we keep the defaults.
async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  if (saved && saved.version === DEFAULT_SETTINGS.version) {
    settings = saved;
  }
}

function saveSettings() {
  chrome.storage.local.set({ settings });
}

// Build the gesture list: one row per gesture = [checkbox] [name] [action menu] [✕].
function showGestureList() {
  const list = $("gestureList");
  list.innerHTML = ""; // empty the list, then rebuild it from the settings

  for (const name in settings.gestures) {
    const g = settings.gestures[name]; // e.g. { on: true, action: "next" }

    // 1. Create the row from a small piece of HTML.
    const row = document.createElement("div");
    row.className = "gesture";
    row.innerHTML = `
      <input type="checkbox">
      <span class="name"></span>
      <select>
        <option value="next">Next slide</option>
        <option value="prev">Previous slide</option>
        <option value="none">Nothing</option>
      </select>
      <button class="remove" title="Remove this gesture">✕</button>`;

    // 2. Fill it with this gesture's values.
    row.querySelector("input").checked = g.on;
    row.querySelector(".name").textContent = LABELS[name];
    row.querySelector("select").value = g.action;

    // 3. When the user changes something in this row → update the settings and save.
    row.querySelector("input").onchange = (e) => {
      g.on = e.target.checked;
      saveSettings();
    };
    row.querySelector("select").onchange = (e) => {
      g.action = e.target.value;
      saveSettings();
    };
    row.querySelector(".remove").onclick = () => {
      delete settings.gestures[name];
      saveSettings();
      showGestureList();
    };

    list.appendChild(row);
  }

  if (list.children.length === 0) {
    list.innerHTML = `<p class="empty">No gestures yet — add one below.</p>`;
  }
  showAddMenu();
}

// The "+ Add gesture" menu: only lists gestures that aren't in the list yet.
function showAddMenu() {
  const menu = $("addSelect");
  menu.innerHTML = "";
  for (const name in LABELS) {
    if (!(name in settings.gestures)) {
      menu.add(new Option(LABELS[name], name)); // new Option(text shown, value)
    }
  }
  $("addGesture").hidden = menu.options.length === 0; // hide it when every gesture is used
}

$("addBtn").onclick = () => {
  const name = $("addSelect").value;
  if (!name) return;
  settings.gestures[name] = { on: true, action: "none" };
  saveSettings();
  showGestureList();
};

// Put the saved values into the checkbox and sliders, and show them as text.
function showSettingsValues() {
  $("tracking").checked = settings.showTracking;
  $("hold").value = settings.holdFrames;
  $("cool").value = settings.cooldownMs;
  $("holdVal").textContent = `${settings.holdFrames} frames`;
  $("coolVal").textContent = `${settings.cooldownMs / 1000} s`;
}

// The engine reads this same "settings" object every frame, so changes apply instantly.
$("tracking").onchange = (e) => {
  settings.showTracking = e.target.checked;
  saveSettings();
};
$("hold").oninput = (e) => {
  settings.holdFrames = Number(e.target.value);
  showSettingsValues();
  saveSettings();
};
$("cool").oninput = (e) => {
  settings.cooldownMs = Number(e.target.value);
  showSettingsValues();
  saveSettings();
};

// =============================================================================
// Small visual feedback
// =============================================================================

// Show a short message over the camera ("➡️ Next slide!"), hidden after 0.9 s.
// (panel.css makes .toast invisible, and visible when it also has the "show" class.)
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer); // if a message was already showing, restart its timer
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 900);
}

// "🟢 Listening" / "⚪ Paused" in the header.
function setStatus(on) {
  $("status").textContent = on ? "🟢 Listening" : "⚪ Paused";
  $("status").className = on ? "status on" : "status off";
}

// =============================================================================
// 3. ACTIONS: send "next" / "prev" to the bridge
// =============================================================================

// Sends { type: "action", action: "next" } to bridge/background.js, which passes
// it to the Figma tab. The bridge answers { ok: true } or { ok: false, error: "..." }.
async function sendAction(action) {
  if (action === "none") return;
  const answer = await chrome.runtime.sendMessage({ type: "action", action });
  if (answer?.ok) {
    toast(action === "next" ? "➡️ Next slide!" : "⬅️ Previous slide!");
  } else {
    toast(`⚠️ ${answer?.error || "No response"}`);
  }
}

// Test buttons: try the Figma connection without using the camera.
$("testPrev").onclick = () => sendAction("prev");
$("testNext").onclick = () => sendAction("next");

// =============================================================================
// 2. ENGINE: start / stop the camera
// =============================================================================

// Called by the engine each time a gesture is accepted (e.g. name = "Victory").
function onGesture(name) {
  const g = settings.gestures[name];
  if (g && g.on) sendAction(g.action); // only if this gesture is in the list AND ticked
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
// Start-up: load the saved settings and fill the panel
// =============================================================================
await loadSettings();
showGestureList();
showSettingsValues();
