// =============================================================================
// preload.js — THE SAFE BRIDGE between the window and main.js
// =============================================================================
// The window (renderer/) can't talk to Node directly (that would be unsafe).
// This file exposes ONLY these 4 functions as window.api.*:
//   window.api.sendKey("next")      → press → in the window in front
//   window.api.quit()               → close the app
//   window.api.loadSettings()       → read the saved settings
//   window.api.saveSettings(obj)    → save the settings

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  sendKey: (action) => ipcRenderer.invoke("send-key", action),
  quit: () => ipcRenderer.send("quit"),
  loadSettings: () => ipcRenderer.invoke("load-settings"),
  saveSettings: (settings) => ipcRenderer.send("save-settings", settings),
});
