'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function sub(ch, cb) {
  const h = (_e, ...a) => cb(...a)
  ipcRenderer.on(ch, h)
  return () => ipcRenderer.removeListener(ch, h)
}

contextBridge.exposeInMainWorld('api', {
  detectEncoder: () => ipcRenderer.invoke('detect-encoder'),
  chooseAudio: () => ipcRenderer.invoke('choose-audio'),
  chooseImage: (kind) => ipcRenderer.invoke('choose-image', kind),
  chooseVideo: () => ipcRenderer.invoke('choose-video'),
  chooseOutput: (def) => ipcRenderer.invoke('choose-output', def),
  loadAudio: (p) => ipcRenderer.invoke('load-audio', p),
  previewBands: (n, ap, wantWave) => ipcRenderer.invoke('preview-bands', n, ap, wantWave),
  estimate: (o) => ipcRenderer.invoke('estimate', o),
  startRender: (o) => ipcRenderer.invoke('start-render', o),
  cancelRender: () => ipcRenderer.invoke('cancel-render'),
  savePreset: (name, data) => ipcRenderer.invoke('save-preset', name, data),
  loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
  listPresets: () => ipcRenderer.invoke('list-presets'),
  deletePreset: (name) => ipcRenderer.invoke('delete-preset', name),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  onDecodeProgress: (cb) => sub('decode-progress', cb),
  onRenderProgress: (cb) => sub('render-progress', cb)
})

// Hand the render MessagePort to the page (main world) so the WebGL engine can
// answer frame requests directly — keeps the 8MB/frame transfers zero-copy.
ipcRenderer.on('render-port', (e, meta) => {
  window.postMessage({ __visiblazerPort: true, meta }, '*', e.ports)
})
