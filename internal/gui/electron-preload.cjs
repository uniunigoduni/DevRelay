const { contextBridge, ipcRenderer } = require("electron");

const send = (action) => ipcRenderer.send("devrelay-chrome", action);

contextBridge.exposeInMainWorld("devrelayChrome", {
  minimize: () => send("minimize"),
  toggleMaximize: () => send("toggle-maximize"),
  close: () => send("close"),
  power: () => send("power"),
  settings: () => send("settings"),
  onState: (callback) => { ipcRenderer.on("devrelay-chrome-state", (_event, state) => callback(state)); }
});
