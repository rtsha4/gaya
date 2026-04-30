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

  // ---- Pack Preview window bridge ----
  // The preview window (renderer/preview.html) uses these to drive the
  // pack-author UI. openWindow is also exposed here so the mascot window
  // could open the preview later if we ever want a renderer-side trigger.
  preview: {
    openWindow: () => ipcRenderer.invoke('preview:open'),
    listPacks: () => ipcRenderer.invoke('pack:list'),
    loadPack: (id) => ipcRenderer.invoke('pack:load', id),
    revealInFinder: (id) => ipcRenderer.invoke('preview:reveal', id),
    validatePack: (id) => ipcRenderer.invoke('preview:validate', id),
    // Subscribe to filesystem-driven pack reload notifications. Returns an
    // unsubscribe function. The main process is responsible for ensuring
    // the watcher is alive for the requested packId.
    watchPack: (packId, cb) => {
      ipcRenderer.send('pack:watch', packId);
      const listener = (_event, payload) => {
        if (payload && payload.packId === packId) cb(payload);
      };
      ipcRenderer.on('preview:pack-changed', listener);
      return () => {
        ipcRenderer.removeListener('preview:pack-changed', listener);
        ipcRenderer.send('pack:unwatch', packId);
      };
    },
  },
});
