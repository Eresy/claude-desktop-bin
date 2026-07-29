/*
 * theme_picker_preload.js - the only bridge between the theme picker page and
 * the main process. Written to
 *   <userData>/cdb-theme-picker/preload.js
 * by patches/add_feature_theme_picker.nim when the window opens, and loaded with
 * contextIsolation:true, nodeIntegration:false, sandbox:true. A sandboxed preload
 * may still require("electron") for this subset.
 *
 * Every channel returns a plain {ok:...} record so the page can show a real
 * message instead of swallowing a rejected promise.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cdbThemes", {
  list: function () {
    return ipcRenderer.invoke("cdb-themes:list");
  },
  active: function () {
    return ipcRenderer.invoke("cdb-themes:active");
  },
  apply: function (name) {
    return ipcRenderer.invoke("cdb-themes:apply", name);
  },
  close: function () {
    return ipcRenderer.invoke("cdb-themes:close");
  },
});
