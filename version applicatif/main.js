// =============================================================================
// main.js — THE APP'S "BACKSTAGE" (runs in Node, not in the window)
// =============================================================================
// Electron apps have 2 parts:
//   - main.js (this file): creates the window, presses the keys, saves settings.
//   - renderer/ : the page you SEE (camera, buttons, gesture engine).
// They talk through preload.js (a safe bridge).
//
// Jobs of this file:
//   1. Serve the app's files on a tiny local web server (needed by MediaPipe)
//   2. Create the window (small, always on top)
//   3. Allow the camera
//   4. When the window says "next" / "prev": press the → / ← key (Windows)
//   5. Save / load the settings
// =============================================================================

const { app, BrowserWindow, ipcMain, session, Menu } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let win = null;    // the app window
let server = null; // the local web server

// ---- 1. Local web server -----------------------------------------------------
// Why? MediaPipe loads its .wasm and .task files with fetch(), and Chrome-based
// apps refuse fetch() on file:// paths. Over http://127.0.0.1 it works.
// Only the renderer/ and lib/ folders are served (nothing else is reachable).
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
};
const ALLOWED_FOLDERS = [path.join(__dirname, "renderer"), path.join(__dirname, "lib")];

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/") urlPath = "/renderer/index.html";
      const file = path.normalize(path.join(__dirname, urlPath));

      const allowed = ALLOWED_FOLDERS.some((folder) => file.startsWith(folder + path.sep));
      if (!allowed) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      fs.readFile(file, (error, data) => {
        if (error) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    // Port 0 = "any free port". 127.0.0.1 = this computer only (not the network).
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// ---- 2. The window -----------------------------------------------------------
function createWindow(port) {
  win = new BrowserWindow({
    width: 420,
    height: 760,
    title: "Point Right",
    alwaysOnTop: true, // stays above your slides
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false, // keep detecting even when the window is hidden
      contextIsolation: true,
    },
  });
  // The page must be loaded from /renderer/ so its relative links (panel.js, panel.css) work.
  win.loadURL(`http://127.0.0.1:${port}/renderer/index.html`);
  win.on("closed", () => (win = null));
  // For debugging: set the POINTRIGHT_DEBUG variable to open the developer tools.
  if (process.env.POINTRIGHT_DEBUG) {
    win.webContents.openDevTools({ mode: "detach" });
    // Also print the window's console messages (errors...) in the terminal.
    win.webContents.on("console-message", (event) => console.log("[window]", event.message ?? event));
  }
}

// ---- 3. Allow the camera -----------------------------------------------------
// Only our own page ("media" = camera) gets the permission.
function allowCamera() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media");
}

// ---- 4. Press the arrow keys (Windows) ---------------------------------------
// We start ONE PowerShell and keep it open (no 0.5 s delay per key). We send it
// one command per line:
//   "K{RIGHT}"  → press the → key in the window in front (SendKeys)
//   "FFigma"    → bring the window whose title contains "Figma" to the front
//
// Why the "F" command? If you last clicked on THIS app, the arrow key would go to
// the app instead of your slides. So when our window is in front, we first jump to
// the Figma window (Figma desktop app, or a browser tab named "... Figma").
// If a presentation window other than Figma is in front, we leave it alone.
const KEYS = { next: "{RIGHT}", prev: "{LEFT}" };
const FIGMA_TITLE = "Figma";
let powershell = null;

// The PowerShell script. (Sent as -EncodedCommand = base64, so no quoting problems.)
const POWERSHELL_SCRIPT = `
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.StartsWith("K")) {
    [System.Windows.Forms.SendKeys]::SendWait($line.Substring(1))
  } elseif ($line.StartsWith("F")) {
    $title = $line.Substring(1)
    $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
    if ($p) {
      if ([Win]::IsIconic($p.MainWindowHandle)) { [Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }
      [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
  }
}
`;

function getPowerShell() {
  if (powershell) return powershell;
  const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
  powershell = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
  });
  powershell.stderr.on("data", (data) => {
    const text = data.toString();
    if (!text.startsWith("#< CLIXML")) console.error("[powershell]", text); // ignore PowerShell's harmless progress noise
  });
  powershell.on("exit", () => (powershell = null));
  return powershell;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle("send-key", async (_event, action) => {
  const key = KEYS[action]; // only "next" and "prev" are accepted
  if (!key) return { ok: false, error: `unknown action ${action}` };
  if (process.platform !== "win32") return { ok: false, error: "Key sending only works on Windows" };
  try {
    const shell = getPowerShell();
    // Our window is in front → the key would stay in the app. Jump to Figma first.
    if (win && win.isFocused()) {
      shell.stdin.write("F" + FIGMA_TITLE + "\n");
      await wait(250); // let Windows finish switching windows
    }
    shell.stdin.write("K" + key + "\n");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

// ---- 5. Settings: a small JSON file in the app's data folder -----------------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

ipcMain.handle("load-settings", () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return null; // first launch: no file yet
  }
});

ipcMain.on("save-settings", (_event, settings) => {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("Could not save settings", error);
  }
});

// ---- Quit ("close" action = love sign) ---------------------------------------
ipcMain.on("quit", () => app.quit());

// ---- Start-up ----------------------------------------------------------------
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // no File / Edit menu
  allowCamera();
  const port = await startServer();
  createWindow(port);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  powershell?.kill();
  server?.close();
});
