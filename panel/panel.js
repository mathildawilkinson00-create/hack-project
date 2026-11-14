// Control panel: settings UI + glue between the engine and the bridge.
// Owner: UI person (integration person helps connect it).
import { startEngine, stopEngine } from "../engine/gestures.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  holdFrames: 8,
  cooldownMs: 1000,
  gestures: {
    Thumb_Up: { on: true, action: "next" },
    Thumb_Down: { on: true, action: "prev" },
    Open_Palm: { on: false, action: "none" },
  },
};
const LABELS = { Thumb_Up: "👍 Thumb up", Thumb_Down: "👎 Thumb down", Open_Palm: "✋ Open palm" };
const ACTIONS = { next: "Next slide", prev: "Previous slide", none: "Nothing" };

const $ = (id) => document.getElementById(id);
let settings = structuredClone(DEFAULT_SETTINGS);
let running = false;

// ---------- settings ----------
async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  if (saved) settings = { ...DEFAULT_SETTINGS, ...saved, gestures: { ...DEFAULT_SETTINGS.gestures, ...saved.gestures } };
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
        .join("")}</select>`;
    row.querySelector("input").onchange = (e) => { g.on = e.target.checked; saveSettings(); };
    row.querySelector("select").onchange = (e) => { g.action = e.target.value; saveSettings(); };
    list.appendChild(row);
  }
}

function renderSliders() {
  $("hold").value = settings.holdFrames;
  $("cool").value = settings.cooldownMs;
  $("holdVal").textContent = `${settings.holdFrames} frames`;
  $("coolVal").textContent = `${(settings.cooldownMs / 1000).toFixed(1)} s`;
}
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

// ---------- init ----------
await loadSettings();
renderGestures();
renderSliders();
