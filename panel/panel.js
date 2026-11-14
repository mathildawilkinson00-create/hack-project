// Control panel: settings UI + glue between the engine and the bridge.
// Owner: UI person (integration person helps connect it).
import { startEngine, stopEngine } from "../engine/gestures.js";

const DEFAULT_SETTINGS = {
  version: 2, // bump to reset users' saved gesture list to the defaults
  enabled: true,
  holdFrames: 8,
  cooldownMs: 1000,
  showTracking: false,
  gestures: {
    // Default list: only these two. Others (👍 👎 ✋ ✊ ☝️) are added with "+ Add gesture".
    Victory: { on: true, action: "next" },
    Three_Fingers: { on: true, action: "prev" },
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
  Three_Fingers: "🖖 Three fingers",
};
const ACTIONS = { next: "Next slide", prev: "Previous slide", none: "Nothing" };

let pip = null; // the always-on-top window, when open
// Look elements up in whichever window currently shows the panel.
const $ = (id) => (pip ? pip.document : document).getElementById(id);
let settings = structuredClone(DEFAULT_SETTINGS);
let running = false;

// ---------- settings ----------
async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  // Use the saved gesture list as-is, so removed gestures stay removed.
  if (saved) settings = { ...DEFAULT_SETTINGS, ...saved, gestures: saved.gestures || structuredClone(DEFAULT_SETTINGS.gestures) };
  // Old saved gesture list (before the version bump): reset it to the new defaults.
  if (settings.version !== DEFAULT_SETTINGS.version) {
    settings.gestures = structuredClone(DEFAULT_SETTINGS.gestures);
    settings.version = DEFAULT_SETTINGS.version;
    saveSettings();
  }
  // Drop gestures that are no longer offered (e.g. ILoveYou saved before it was removed).
  for (const name of Object.keys(settings.gestures)) if (!(name in LABELS)) delete settings.gestures[name];
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

// ---------- always on top (Document Picture-in-Picture) ----------
// Moves the whole panel into a small window that stays above every other app
// (Figma fullscreen included). Closing that window puts the panel back here.
const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCAF = window.cancelAnimationFrame.bind(window);
const pending = new Map();
let rafSeq = 0;

// While floating, this window may be hidden behind others and Chrome pauses its
// animation frames, which would freeze the engine loop. So frames are driven by
// the floating window instead, with a timer as backup for when it closes.
window.requestAnimationFrame = (cb) => {
  if (!pip) return nativeRAF(cb);
  const id = ++rafSeq;
  const win = pip;
  let done = false;
  const run = (t) => {
    if (done) return;
    done = true;
    pending.delete(id);
    clearTimeout(timer);
    cb(t ?? performance.now());
  };
  const rid = win.requestAnimationFrame(run);
  const timer = setTimeout(run, 250);
  pending.set(id, () => {
    done = true;
    clearTimeout(timer);
    try { win.cancelAnimationFrame(rid); } catch {}
  });
  return -id; // negative = one of ours
};
window.cancelAnimationFrame = (id) => {
  if (id < 0) { pending.get(-id)?.(); pending.delete(-id); }
  else nativeCAF(id);
};

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
  const win = await documentPictureInPicture.requestWindow({ width: 320, height: 420 });
  // Copy our stylesheet into the new window.
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const l = win.document.createElement("link");
    l.rel = "stylesheet";
    l.href = link.href;
    win.document.head.appendChild(l);
  }
  win.document.title = "Gesture Presenter";
  win.document.documentElement.classList.add("pip");
  // Move the panel (elements keep their event handlers).
  const nodes = [...document.body.children].filter((n) => n.tagName !== "SCRIPT");
  win.document.body.append(...nodes);
  pip = win;
  $("video").play().catch(() => {});

  const note = document.createElement("p");
  note.id = "pipNote";
  note.className = "pip-note";
  note.textContent = "📌 The panel is floating on top of your screen. Close it to bring it back here. Keep this window open (it can stay behind Figma).";
  document.body.prepend(note);

  $("pipBtn").textContent = "↩ Put back in window";
  setSettingsOpen(false);

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

// ---------- init ----------
await loadSettings();
renderGestures();
renderSliders();
