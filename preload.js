const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_event, payload) => cb(payload)),
  // Tray-driven character pack swap. Renderer reloads SVG/CSS on receipt.
  onSwitchPack: (cb) => ipcRenderer.on('switch-pack', (_event, id) => cb(id)),
  // Walk visualization: payload { walking: bool, direction: 'left'|'right' }
  onMovement: (cb) => ipcRenderer.on('movement', (_event, payload) => cb(payload)),
  // Overlay state: payload { overlay: 'dragging'|'falling'|'landed'|null }.
  // The renderer overrides the visible state with this overlay when non-null,
  // then snaps back to realState when it becomes null. Drives the
  // dragging -> falling -> landed -> null sequence around user drags.
  onOverlay: (cb) => ipcRenderer.on('overlay', (_event, payload) => cb(payload)),
  // Per-window identity. Sent once after renderer-ready: payload
  // { sessionId, isDefault, displayName, cwd }.
  onSessionInfo: (cb) => ipcRenderer.on('session-info', (_event, payload) => cb(payload)),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  // Pack assets are read by main (fs) and shipped over IPC because fetch()
  // under sandbox:true on file:// is blocked.
  listPacks: () => ipcRenderer.invoke('pack:list'),
  loadPack: (id) => ipcRenderer.invoke('pack:load', id),
});
