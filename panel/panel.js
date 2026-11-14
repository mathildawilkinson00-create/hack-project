// Control panel: settings UI + glue between the engine and the bridge.
// Owner: UI person (integration person helps connect it).
import { startEngine, stopEngine } from "../engine/gestures.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  holdFrames: 8,
  cooldownMs: 1000,
  showTracking: false,
  gestures: {
    Thumb_Up: { on: true, action: "next" },
    Thumb_Down: { on: true, action: "prev" },
    Open_Palm: { on: false, action: "none" },
    Pointing_Up: { on: false, action: "next" },
    Victory: { on: false, action: "prev" },
  },
};
// Every gesture MediaPipe can recognize (see CLAUDE.md).
const LABELS = {
  Thumb_Up: "👍 Thumb up",
  Thumb_Down: "👎 Thumb down",
  Open_Palm: "✋ Open palm",
  Closed_Fist: "✊ Closed fist",
  Pointing_Up: "☝️ One finger",
  Victory: "✌️ Two fingers",
  ILoveYou: "🤟 I love you",
};
const ACTIONS = { next: "Next slide", prev: "Previous slide", none: "Nothing" };

const $ = (id) => document.getElementById(id);
let settings = structuredClone(DEFAULT_SETTINGS);
let running = false;

// ---------- settings ----------
async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  // Use the saved gesture list as-is, so removed gestures stay removed.
  if (saved) settings = { ...DEFAULT_SETTINGS, ...saved, gestures: saved.gestures || structuredClone(DEFAULT_SETTINGS.gestures) };
}
function saveSettings() {
  chrome.storage.local.set({ settings });
}

// ---------- UI ----------
function renderGestures() {
  const list = $("gestureList");
  list.innerHTML = "";
  for (const [name, g] of Object.entries(settings.gestures)) {
    const row = document.createElement("div");
    row.className = "gesture";
    row.innerHTML = `
      <input type="checkbox" ${g.on ? "checked" : ""}>
      <span class="name">${LABELS[name] || name}</span>
      <select>${Object.entries(ACTIONS)
        .map(([v, t]) => `<option value="${v}" ${v === g.action ? "selected" : ""}>${t}</option>`)
        .join("")}</select>
      <button class="remove" title="Remove this gesture">✕</button>`;
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

// "Add gesture" row: only lists gestures not already in use.
function renderAddGesture() {
  const unused = Object.keys(LABELS).filter((n) => !(n in settings.gestures));
  $("addGesture").hidden = unused.length === 0;
  $("addSelect").innerHTML = unused.map((n) => `<option value="${n}">${LABELS[n]}</option>`).join("");
}
$("addBtn").onclick = () => {
  const name = $("addSelect").value;
  if (!name) return;
  settings.gestures[name] = { on: true, action: "none" };
  saveSettings();
  renderGestures();
};

function renderSliders() {
  $("tracking").checked = !!settings.showTracking;
  $("hold").value = settings.holdFrames;
  $("cool").value = settings.cooldownMs;
  $("holdVal").textContent = `${settings.holdFrames} frames`;
  $("coolVal").textContent = `${(settings.cooldownMs / 1000).toFixed(1)} s`;
}
$("tracking").onchange = (e) => { settings.showTracking = e.target.checked; saveSettings(); };
$("hold").oninput = (e) => { settings.holdFrames = +e.target.value; renderSliders(); saveSettings(); };
$("cool").oninput = (e) => { settings.cooldownMs = +e.target.value; renderSliders(); saveSettings(); };

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 900);
}

function setStatus(on) {
  const s = $("status");
  s.textContent = on ? "🟢 Listening" : "⚪ Paused";
  s.className = `status ${on ? "on" : "off"}`;
}

// ---------- send an action to Figma ----------
async function sendAction(action) {
  if (action === "none") return;
  const res = await chrome.runtime.sendMessage({ type: "action", action });
  if (res?.ok) toast(action === "next" ? "➡️ Next slide!" : "⬅️ Previous slide!");
  else toast(`⚠️ ${res?.error || "No response"}`);
}

document.querySelectorAll("[data-test]").forEach((b) => (b.onclick = () => sendAction(b.dataset.test)));

// ---------- engine ----------
function onGesture(name) {
  const g = settings.gestures[name];
  if (g?.on) sendAction(g.action);
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

// ---------- overlay mode (panel shown inside Figma by overlay.js) ----------
if (new URLSearchParams(location.search).has("overlay")) {
  document.documentElement.classList.add("overlay");
  $("settings").hidden = true;
  $("settingsBtn").onclick = () => {
    $("settings").hidden = !$("settings").hidden;
    $("settingsBtn").textContent = $("settings").hidden ? "⚙ Settings ▾" : "⚙ Settings ▴";
  };
  // Tell the overlay how tall we are so it can resize the frame.
  new ResizeObserver(() => {
    window.parent.postMessage({ type: "gp-height", height: document.body.scrollHeight }, "*");
  }).observe(document.body);
}

// ---------- init ----------
await loadSettings();
renderGestures();
renderSliders();
