// Content script (Figma pages): shows the control panel as a floating,
// draggable, see-through overlay on top of the presentation.
// Owner: UI person. Toggled by clicking the extension icon on a Figma tab.
(() => {
  const PANEL_URL = chrome.runtime.getURL("panel/panel.html?overlay=1");
  const EXT_ORIGIN = new URL(PANEL_URL).origin;
  let host = null;

  function create() {
    host = document.createElement("div");
    host.id = "gesture-presenter-overlay";
    // Shadow DOM so Figma's CSS can't touch ours (and vice versa).
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          width: 300px; display: flex; flex-direction: column;
          border-radius: 14px; overflow: hidden;
          background: rgba(17, 19, 24, 0.35);
          backdrop-filter: blur(6px);
          box-shadow: 0 8px 30px rgba(0,0,0,.35);
          font: 12px system-ui, sans-serif; color: #f2f3f5;
        }
        .bar {
          display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px;
          cursor: move; user-select: none; background: rgba(0,0,0,.35);
        }
        .bar span { flex: 1; opacity: .8; }
        .bar button {
          all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
          text-align: center; line-height: 22px; opacity: .8;
        }
        .bar button:hover { background: rgba(255,255,255,.15); opacity: 1; }
        iframe { border: 0; width: 100%; height: 300px; background: transparent; color-scheme: normal; display: block; }
        .box.mini iframe { height: 1px; opacity: 0; } /* kept alive so the camera keeps running */
      </style>
      <div class="box">
        <div class="bar">
          <span>✋ Gesture Presenter</span>
          <button class="min" title="Minimize">–</button>
          <button class="close" title="Close (stops the camera)">✕</button>
        </div>
        <iframe src="${PANEL_URL}" allow="camera" allowtransparency="true"></iframe>
      </div>`;

    const box = root.querySelector(".box");
    const bar = root.querySelector(".bar");
    const frame = root.querySelector("iframe");

    root.querySelector(".min").onclick = () => box.classList.toggle("mini");
    root.querySelector(".close").onclick = remove;

    // Drag by the title bar.
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => {
        box.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)) + "px";
        box.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy)) + "px";
        box.style.right = box.style.bottom = "auto";
      };
      const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });

    // The panel tells us its content height so the overlay fits it.
    window.addEventListener("message", onMessage);
    function onMessage(e) {
      if (e.origin !== EXT_ORIGIN || e.source !== frame.contentWindow) return;
      if (e.data?.type === "gp-height") {
        frame.style.height = Math.min(e.data.height, innerHeight - 80) + "px";
      }
    }
    host._cleanup = () => window.removeEventListener("message", onMessage);

    document.documentElement.appendChild(host);
  }

  function remove() {
    if (!host) return;
    host._cleanup();
    host.remove(); // removing the iframe also stops the camera
    host = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggleOverlay") host ? remove() : create();
  });
})();
