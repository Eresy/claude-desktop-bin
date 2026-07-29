/*
 * extra_settings_main.js - main-process half of the "Extra" settings area.
 * Injected into .vite/build/index.js by patches/add_feature_extra_settings.nim.
 *
 * Three jobs:
 *   1. Register the ipcMain handlers the page's cdbExtra bridge talks to.
 *   2. Own the ONLY writer of growthbookOverrides in claude-desktop-bin.json
 *      (the .jsonc is human-owned and never created or rewritten here).
 *   3. Install the page-side UI on every http(s) dom-ready (insertCSS + one
 *      executeJavaScript whose return value is logged).
 *
 * Cross-patch state is read LAZILY through globalThis, never captured at load:
 * same-anchor prefix injections stack in reverse, so this IIFE runs BEFORE the
 * custom-themes IIFE that installs globalThis.__cdbThemes. Every handler
 * therefore tolerates a missing registry and answers {ok:false,error:...}.
 *
 * SECURITY: the caller is remote claude.ai code. Every handler validates its
 * sender (main frame of an http(s) webContents), flag ids must exist in the
 * catalog, and values are restricted to JSON scalars.
 *
 * The two placeholder string literals below are replaced at build time by the
 * Nim patch with the contents of js/extra_settings_page.js and
 * js/extra_settings_page.css. They stay plain strings here so this file passes
 * node --check on its own.
 */
;/*__CDB_EXTRA_SETTINGS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _path = require("path");
  var _fs = require("fs");

  var __cdbEx_pageSrc = "__CDB_EX_PAGE_SRC__";
  var __cdbEx_pageCss = "__CDB_EX_PAGE_CSS__";
  var __cdbEx_marker = "__cdb_extra_settings";

  function __cdbEx_log(m) {
    try { (globalThis.__cdbDiag || console.log)("[ExtraSettings] " + m); } catch (e) {}
  }

  function __cdbEx_paths() {
    var ud = _app.getPath("userData");
    return {
      json: _path.join(ud, "claude-desktop-bin.json"),
      jsonc: _path.join(ud, "claude-desktop-bin.jsonc"),
      userData: ud
    };
  }

  // JSONC comment + trailing-comma stripping. MUST stay byte-identical in
  // behavior to stripJsonComments() in js/growthbook_overrides.js: if the two
  // disagreed about whether an id is set in the .jsonc, this page would offer a
  // toggle whose value the flag loader then ignores.
  function __cdbEx_strip(s) {
    var out = "", inStr = false, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (inStr) {
        out += c;
        if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; }
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
      if (c === ",") {
        var j = i + 1;
        while (j < s.length) {
          if (s[j] === " " || s[j] === "\t" || s[j] === "\r" || s[j] === "\n") { j++; continue; }
          if (s[j] === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j++; continue; }
          if (s[j] === "/" && s[j + 1] === "*") { j += 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++; j += 2; continue; }
          break;
        }
        if (s[j] === "}" || s[j] === "]") { i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  // --- theme swatches -------------------------------------------------------
  // Five tokens per variant, each with fallbacks, reduced to CSS colors here so
  // the ~90 full token maps never cross into the remote page.
  var __cdbEx_swatch = [
    ["--bg-100", "--bg-000", "--bg-200"],
    ["--text-000", "--text-100", "--text-200"],
    ["--accent-brand", "--accent-100", "--accent-000"],
    ["--accent-pro-100", "--accent-pro-000", "--accent-200"],
    ["--success-100", "--success-000", "--warning-100"]
  ];

  // Only two shapes are accepted: #hex and the "H S% L%" triple the theme schema
  // uses. Anything else is dropped rather than forwarded into a style property.
  function __cdbEx_color(map, chain) {
    for (var i = 0; i < chain.length; i++) {
      var v = map && map[chain[i]];
      if (typeof v !== "string") continue;
      var t = v.trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t;
      if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+)?$/.test(t)) return "hsl(" + t + ")";
    }
    return null;
  }

  function __cdbEx_dots(map) {
    var out = [];
    for (var i = 0; i < __cdbEx_swatch.length; i++) {
      var c = __cdbEx_color(map, __cdbEx_swatch[i]);
      if (c) out.push(c);
    }
    return out;
  }

  // --- flag catalog / state -------------------------------------------------

  function __cdbEx_gb() {
    return globalThis.__cdbGbFlags || null;
  }

  function __cdbEx_catalog() {
    var gb = __cdbEx_gb();
    if (!gb) return null;
    try { return gb.catalog(); } catch (e) { return null; }
  }

  function __cdbEx_scalar(v) {
    var t = typeof v;
    if (v === null || v === undefined || t === "boolean" || t === "number") return v;
    if (t === "string") return v.length > 200 ? v.slice(0, 200) + "..." : v;
    try {
      var s = JSON.stringify(v);
      return s && s.length > 200 ? s.slice(0, 200) + "..." : s;
    } catch (e) { return "[unserializable]"; }
  }

  function __cdbEx_project(map, ids) {
    var out = {};
    if (!map || typeof map !== "object") return out;
    for (var i = 0; i < ids.length; i++) {
      var e = map[ids[i]];
      if (!e || typeof e !== "object") continue;
      out[ids[i]] = { on: e.on === true, value: __cdbEx_scalar(e.value) };
    }
    return out;
  }

  // --- the single writer of growthbookOverrides in the .json ---------------
  // The .jsonc is a human-owned file with an auto-created template; it already
  // has two writers (template creation + activeTheme persistence) and this page
  // deliberately does not become a third. Writes are atomic (tmp + rename).
  function __cdbEx_writeOverrides(mutate) {
    var p = __cdbEx_paths();
    var raw = null;
    try {
      raw = _fs.readFileSync(p.json, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p.json + ": " + e.message };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = __cdbEx_strip(raw);
      try {
        cfg = stripped.trim() ? JSON.parse(stripped) : {};
      } catch (e2) {
        return { ok: false, error: p.json + " is not valid JSON (" + e2.message + ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p.json + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try {
          _fs.writeFileSync(p.json + ".cdb-bak", raw, { flag: "wx" });
          __cdbEx_log("comments in " + p.json + " cannot survive a rewrite; original kept as " + p.json + ".cdb-bak");
        } catch (e3) {}
      }
    }
    var o = cfg.growthbookOverrides;
    if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
    mutate(o);
    if (Object.keys(o).length) cfg.growthbookOverrides = o;
    else delete cfg.growthbookOverrides;

    var tmp = p.json + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p.json);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p.json + ": " + e4.message };
    }
    return { ok: true, overridesJson: o, path: p.json };
  }

  function __cdbEx_readFileOverrides(file) {
    var raw;
    try {
      raw = _fs.readFileSync(file, "utf8");
    } catch (e) { return {}; }
    try {
      var cfg = JSON.parse(__cdbEx_strip(raw) || "{}");
      var o = cfg && cfg.growthbookOverrides;
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (e2) {}
    return {};
  }

  // An id may only be written if the catalog knows it (or we force it on Linux
  // ourselves) - remote code cannot invent flag ids to persist.
  function __cdbEx_knownId(id) {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return false;
    var catalog = __cdbEx_catalog();
    if (catalog) {
      for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return true;
    }
    var gb = __cdbEx_gb();
    try {
      if (gb && Object.prototype.hasOwnProperty.call(gb.builtins(), id)) return true;
    } catch (e) {}
    return false;
  }

  function __cdbEx_warned(id) {
    var catalog = __cdbEx_catalog();
    if (!catalog) return "";
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === id) return catalog[i].warn || "";
    }
    return "";
  }

  // --- sender validation ---------------------------------------------------
  // Only the main frame of an http(s) webContents, i.e. the mainView that our
  // preload bridge lives in. Subframes never get the preload, but reject them
  // explicitly rather than relying on that.
  function __cdbEx_okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!/^https?:\/\//i.test(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  function __cdbEx_guard(fn) {
    return function (ev) {
      if (!__cdbEx_okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
      try {
        return fn.apply(null, Array.prototype.slice.call(arguments, 1));
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    };
  }

  // --- handlers ------------------------------------------------------------

  var __cdbEx_diagSeen = {};

  var __cdbEx_handlers = {
    // Reduced projection of the theme registry. cdb-themes:apply / :active stay
    // owned by the theme picker patch; only this list is ours, because the full
    // entries carry every token of every palette.
    "cdb-extra:themes-list": function () {
      var themes = globalThis.__cdbThemes;
      if (!themes) return { ok: false, error: "the custom themes patch did not install globalThis.__cdbThemes in this build" };
      var entries = themes.list().map(function (e) {
        return {
          name: e.name,
          displayName: e.displayName || e.name,
          source: e.source || "",
          // Passed through from the registry so the page can section by category
          // independently of the source tier. "" when the theme has none, and
          // absent entirely in builds whose registry predates the field - the
          // page treats both the same way.
          category: e.category || "",
          light: __cdbEx_dots(e.light),
          dark: __cdbEx_dots(e.dark)
        };
      });
      return { ok: true, entries: entries, active: themes.active(), configPath: themes.configPath || "" };
    },

    "cdb-extra:paths": function () {
      return { ok: true, paths: __cdbEx_paths() };
    },

    "cdb-flags:catalog": function () {
      var catalog = __cdbEx_catalog();
      if (!catalog) {
        return { ok: false, error: "the growthbook overrides patch did not install globalThis.__cdbGbFlags in this build" };
      }
      return { ok: true, count: catalog.length, entries: catalog };
    },

    "cdb-flags:read": function () {
      var gb = __cdbEx_gb();
      var catalog = __cdbEx_catalog();
      if (!gb || !catalog) {
        return { ok: false, error: "the growthbook overrides patch did not install globalThis.__cdbGbFlags in this build" };
      }
      var p = __cdbEx_paths();
      var builtins = {};
      try { builtins = gb.builtins() || {}; } catch (e) {}
      var ids = catalog.map(function (e) { return e.id; }).concat(Object.keys(builtins));
      var server = null, effective = null;
      try { server = gb.server(); } catch (e2) {}
      try { effective = gb.effective(); } catch (e3) {}
      return {
        ok: true,
        storeSeen: !!(server || effective),
        server: __cdbEx_project(server, ids),
        effective: __cdbEx_project(effective, ids),
        overridesJson: __cdbEx_readFileOverrides(p.json),
        overridesJsonc: __cdbEx_readFileOverrides(p.jsonc),
        builtins: builtins,
        paths: p
      };
    },

    "cdb-flags:set": function (id, value) {
      if (!__cdbEx_knownId(id)) return { ok: false, error: "unknown flag id" };
      var t = typeof value;
      if (!(t === "boolean" || t === "number" || (t === "string" && value.length <= 200))) {
        return { ok: false, error: "a flag override must be a boolean, a number or a short string" };
      }
      var warn = __cdbEx_warned(id);
      if (warn && value !== false) {
        return { ok: false, error: "refusing to enable " + id + ": " + warn };
      }
      var jsonc = __cdbEx_readFileOverrides(__cdbEx_paths().jsonc);
      if (Object.prototype.hasOwnProperty.call(jsonc, id)) {
        return { ok: false, error: id + " is set in claude-desktop-bin.jsonc, which wins over this page - edit that file instead" };
      }
      var res = __cdbEx_writeOverrides(function (o) { o[id] = value; });
      if (res.ok) __cdbEx_log("override " + id + "=" + JSON.stringify(value) + " saved to " + res.path);
      return res;
    },

    "cdb-flags:unset": function (id) {
      if (!__cdbEx_knownId(id)) return { ok: false, error: "unknown flag id" };
      var res = __cdbEx_writeOverrides(function (o) { delete o[id]; });
      if (res.ok) __cdbEx_log("override " + id + " removed from " + res.path);
      return res;
    },

    "cdb-app:relaunch": function () {
      __cdbEx_log("relaunch requested from the Extra settings page");
      setTimeout(function () {
        try { _app.relaunch(); _app.exit(0); } catch (e) { __cdbEx_log("relaunch failed: " + e.message); }
      }, 150);
      return { ok: true };
    },

    // Page-side diagnostics, deduped so a hostile or looping page cannot flood
    // the log file.
    "cdb-extra:diag": function (message) {
      var m = String(message || "").slice(0, 300);
      if (__cdbEx_diagSeen[m]) return { ok: true, deduped: true };
      if (Object.keys(__cdbEx_diagSeen).length > 40) return { ok: true, deduped: true };
      __cdbEx_diagSeen[m] = 1;
      __cdbEx_log("page: " + m);
      return { ok: true };
    }
  };

  // removeHandler first, so re-evaluating this module replaces the handlers
  // instead of throwing.
  try {
    if (_ipc) {
      Object.keys(__cdbEx_handlers).forEach(function (ch) {
        try { _ipc.removeHandler(ch); } catch (e) {}
        _ipc.handle(ch, __cdbEx_guard(__cdbEx_handlers[ch]));
      });
    } else {
      __cdbEx_log("ipcMain unavailable; the Extra settings page cannot be served");
    }
  } catch (e) {
    __cdbEx_log("IPC registration failed: " + e.message);
  }

  // --- page installation ---------------------------------------------------
  // insertCSS survives navigations within a webContents, so it is inserted once
  // per webContents; the page script is idempotent on its own side and re-runs
  // after a real reload.
  var __cdbEx_styled = new WeakSet();

  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = wc.getURL() || "";
        if (!/^https?:\/\//i.test(url)) return;
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) return;
        if (!__cdbEx_styled.has(wc)) {
          __cdbEx_styled.add(wc);
          wc.insertCSS(__cdbEx_pageCss).catch(function () {});
        }
        wc.executeJavaScript(__cdbEx_pageSrc).then(function (status) {
          // Deduped: every OAuth popup and helper view reports "skipped", and a
          // line per navigation would be noise.
          var line = String(status || "");
          if (!line || __cdbEx_diagSeen[line]) return;
          __cdbEx_diagSeen[line] = 1;
          __cdbEx_log(line);
        }, function (err) {
          __cdbEx_log("page script failed: " + ((err && err.message) || String(err)));
        });
      } catch (e) {
        __cdbEx_log("dom-ready hook error: " + e.message);
      }
    });
  });

  __cdbEx_log("Extra settings area armed [" + __cdbEx_marker + "]");
})();
