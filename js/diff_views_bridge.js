/*
 * diff_views_bridge.js - the ONLY channel the claude.ai page can use to reach
 * the diff view modes backend. Injected into .vite/build/mainView.js by
 * patches/add_feature_diff_views_bridge.nim.
 *
 * SECURITY: the page behind this preload is REMOTE code. Fixed wrappers around
 * fixed channel names - no generic invoke passthrough. Argument shapes are
 * re-validated on the main side (js/diff_views_main.js).
 */
"use strict";
(function () {
  // __cdb_diff_views_bridge
  var electron = require("electron");
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return;

  contextBridge.exposeInMainWorld("cdbDiffViews", {
    version: 2,
    state: function () { return ipcRenderer.invoke("cdb-diff:state"); },
    // Diff CONTENT is no longer produced here: the main process rewrites the
    // arguments of the stock LocalSessions git-diff IPC handlers instead, so
    // the stock renderer draws every mode. All the page can do is select the
    // mode; the main side validates the enum and owns every git invocation.
    setMode: function (mode) { return ipcRenderer.invoke("cdb-diff:set-mode", String(mode)); }
  });
})();
