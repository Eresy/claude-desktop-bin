/*
 * spinner_injector.js - runtime brand-glyph -> custom spinner replacement,
 * live-switchable.
 *
 * Injected into the claude.ai webview by patches/add_feature_custom_themes.nim on
 * `dom-ready` AND re-run on every live theme switch. The Nim/main side PREPENDS
 *   var __CDB_SPINNER_SPEC = <json|null>;
 * (serialized from the active theme's `spinner` object) ahead of this IIFE. The runtime
 * does NOT read the config file; it only consumes the baked-in global.
 *
 * LIVE SWITCHING is the whole point of the structure below. Running the file installs
 * a single window-level engine ONCE:
 *   window.__cdbSpinnerApply(specOrNull) -> re-themes every glyph we own, any number
 *                                          of times; null restores Claude's own glyph.
 * A second run of the file does NOT re-install (no duplicate observers); it only calls
 * that API with the new spec. The engine can do this because the FIRST swap of an
 * element stashes the original markup (child nodes + viewBox) on the element, so the
 * star geometry we match on is never actually lost - and the first stash is also kept
 * as a document-wide fallback for glyph elements that were cloned from one of ours.
 *
 * Behavior:
 *   - No-ops cleanly when the spec is null/undefined/empty (feature opt-in), but the
 *     engine + observer stay armed so a later apply() can still theme the page.
 *   - Finds the Anthropic 7-point brand-star SVGs via a cheap viewBox "0 0 100 100"
 *     pre-filter + a child <path d> matching the signature "m19.6 66.5 19.7-11"
 *     (overridable per spec via spec.match).
 *   - Replaces the matched <svg>'s children using document.createElementNS
 *     (NOT innerHTML -> CSP / Trusted-Types safe). Keeps the <svg> wrapper so the
 *     `fill-current` class + box size are preserved.
 *   - Multi-path with optional per-path `fill` (omitted/"currentColor" -> inherits the
 *     theme accent; explicit hex/hsl -> fixed color, needed for the Mario mushroom).
 *   - animation "spin"|"bounce"|"pulse" -> a cdb-anim-<name> class on the <svg>.
 *     animation "flip" -> TWO <g data-cdb-frame="1|2"> groups (paths and paths2),
 *     toggled by a steps() keyframe pair at ~2 frames/sec: a retro two-frame sprite
 *     cycle. Keyframes ship with the theme CSS (insertCSS), for every animation name
 *     regardless of which one the active theme uses, so switching never lacks one.
 *   - Defensive validation: a malformed spec (no usable path, "flip" without paths2)
 *     is REFUSED with a diagnostic line and the current glyph is left untouched -
 *     never a half-built SVG.
 *   - Idempotent via a data-cdb-spinner=<specHash> stamp; the stamp also breaks the
 *     MutationObserver loop (re-seeing our own writes is a cheap no-op).
 *   - MutationObserver on document.documentElement scans ONLY addedNodes, rAF-debounced,
 *     and always installs the CURRENT spec - not the one baked in at injection time.
 *   - window.__cdbSpinner = { spec, version, apply, sweep, managed, disconnect } for
 *     live debugging.
 *   - Logs "[spinner] themed N glyph(s)" so a sudden 0 means the logo geometry drifted
 *     (update the signature) - NOT "feature removed".
 *
 * ES5 ONLY (var / function; no arrow / let / const). This file is concatenated into a
 * Nim string and run inside a webview; it must `node --check` clean even though the DOM
 * APIs it calls cannot execute under node.
 */
;(function () {
  "use strict";

  if (typeof window === "undefined" || !window.document) return;

  var SVGNS = "http://www.w3.org/2000/svg";
  var STAMP_ATTR = "data-cdb-spinner";
  var FRAME_ATTR = "data-cdb-frame";
  var ANIM_PREFIX = "cdb-anim-";
  // The brand glyph's own box. This is the matcher's pre-filter and is independent of
  // a spec's own viewBox (a shape may draw in any box it likes).
  var GLYPH_VIEWBOX = "0 0 100 100";
  var ANIMS = { spin: 1, bounce: 1, pulse: 1, flip: 1 };
  // Detection signatures: distinctive fragments of the Anthropic 7-point star path.
  // Matching on the literal logo geometry is what keeps us from reshaping unrelated
  // 0 0 100 100 icons. We keep SEVERAL fragments from different rays so that if upstream
  // re-emits/normalizes one coordinate run, another fragment still matches (robustness).
  // A theme's `match` (string or array of strings) overrides this set entirely.
  var DEFAULT_SIGS = [
    "m19.6 66.5 19.7-11",  // upper-left ray (the original, confirmed live on v1.15962)
    "19.7-11 .3-1-.3-.5",  // continuation of that ray
    "66.5 19.7-11"         // looser fragment of the same run
  ];

  // --- helpers (ES5-safe; Array.isArray exists in webviews but stay defensive) -------

  function isArray(x) {
    return Array.isArray ? Array.isArray(x) :
      (Object.prototype.toString.call(x) === "[object Array]");
  }

  function safeStringify(x) {
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }

  function hash(s) {
    var h = 5381, i = s.length;
    while (i) { h = (h * 33) ^ s.charCodeAt(--i); }
    return (h >>> 0).toString(36);
  }

  function log(msg) {
    try { if (window.console && console.log) console.log("[spinner] " + msg); } catch (e) {}
  }

  // --- the engine, installed exactly once per window ---------------------------------

  function install() {
    var CURRENT = null;        // validated spec in effect (null = Claude's own glyph)
    var SIGS = DEFAULT_SIGS;   // star signatures the matcher is using right now
    var MANAGED = [];          // <svg> elements we reshaped (pruned as they detach)
    var STAR = null;           // first captured original; fallback for cloned glyphs

    // --- spec validation -------------------------------------------------------------
    // Returns {ok:true, spec:<normalized|null>} or {ok:false, error:"..."}. Anything
    // that would produce a broken SVG is an error, and an error means "keep what is
    // on screen" - never a partial render.

    function cleanPaths(arr) {
      var out = [], i, p;
      if (!isArray(arr)) return out;
      for (i = 0; i < arr.length; i++) {
        p = arr[i];
        if (!p || typeof p !== "object") continue;
        if (typeof p.d !== "string" || p.d.length === 0) continue;
        out.push({ d: p.d, fill: (typeof p.fill === "string" && p.fill) ? p.fill : null });
      }
      return out;
    }

    function sigsOf(spec) {
      var m = spec.match;
      if (typeof m === "string" && m) return [m];
      if (isArray(m) && m.length) {
        var out = [], i;
        for (i = 0; i < m.length; i++) if (typeof m[i] === "string" && m[i]) out.push(m[i]);
        if (out.length) return out;
      }
      return DEFAULT_SIGS;
    }

    function validate(raw) {
      if (raw === null || raw === undefined || raw === "") return { ok: true, spec: null };
      if (typeof raw !== "object" || isArray(raw)) return { ok: false, error: "spec is not an object" };
      var paths = cleanPaths(raw.paths);
      if (paths.length === 0) return { ok: false, error: "spec.paths has no usable {d:\"...\"} entry" };
      var anim = null;
      if (raw.animation !== null && raw.animation !== undefined && raw.animation !== "") {
        if (typeof raw.animation !== "string" || !ANIMS[raw.animation]) {
          log("unknown animation " + safeStringify(raw.animation) +
              " ignored (want spin|bounce|pulse|flip)");
        } else {
          anim = raw.animation;
        }
      }
      var frame2 = cleanPaths(raw.paths2);
      if (anim === "flip" && frame2.length === 0) {
        return { ok: false, error: "animation \"flip\" needs a second frame in spec.paths2" };
      }
      if (anim !== "flip" && frame2.length > 0) {
        log("spec.paths2 ignored - only animation \"flip\" renders a second frame");
      }
      var spec = {
        viewBox: (typeof raw.viewBox === "string" && raw.viewBox) ? raw.viewBox : null,
        animation: anim,
        paths: paths,
        paths2: (anim === "flip") ? frame2 : [],
        sigs: sigsOf(raw)
      };
      // Version stamp: a spec change re-processes previously-stamped svgs instead of
      // being skipped as "already done".
      spec.ver = hash(safeStringify(spec));
      return { ok: true, spec: spec };
    }

    // --- matcher ---------------------------------------------------------------------

    function isOurs(svg) {
      return !!(svg.getAttribute && svg.getAttribute(STAMP_ATTR));
    }

    function isStarSvg(svg) {
      if (!svg || svg.namespaceURI !== SVGNS) return false;
      if (!svg.tagName || String(svg.tagName).toLowerCase() !== "svg") return false;
      if (isOurs(svg)) return false; // already reshaped: re-themed via MANAGED, not here
      // cheap pre-filter: brand glyph lives in a 0 0 100 100 box
      var vb = (svg.getAttribute("viewBox") || "").replace(/\s+/g, " ").trim();
      if (vb !== GLYPH_VIEWBOX) return false;
      // precise: a child <path d> contains any of the star signatures
      var paths = svg.getElementsByTagNameNS(SVGNS, "path");
      for (var i = 0; i < paths.length; i++) {
        var d = (paths[i].getAttribute("d") || "").trim();
        if (d.length === 0) continue;
        for (var k = 0; k < SIGS.length; k++) {
          if (d.indexOf(SIGS[k]) > -1) return true;
        }
      }
      return false;
    }

    // --- original-glyph custody ------------------------------------------------------

    function clear(svg) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    function dropAnimClasses(svg) {
      if (!svg.classList) return;
      var doomed = [], i, c;
      for (i = 0; i < svg.classList.length; i++) {
        c = svg.classList[i];
        if (c && c.indexOf(ANIM_PREFIX) === 0) doomed.push(c);
      }
      for (i = 0; i < doomed.length; i++) svg.classList.remove(doomed[i]);
    }

    // Capture the untouched glyph BEFORE the first swap. Skipped for an element that
    // already carries our stamp: its children are ours, not the original, and stashing
    // them would make a later restore put OUR shape back as "Claude's own".
    function stash(svg) {
      if (svg.__cdbSpinnerOrig) return;
      if (isOurs(svg)) return;
      var kids = [], cn = svg.childNodes, i;
      for (i = 0; i < cn.length; i++) kids.push(cn[i].cloneNode(true));
      var o = { kids: kids, vb: svg.getAttribute("viewBox") };
      svg.__cdbSpinnerOrig = o;
      if (!STAR) STAR = o; // every instance is the same glyph -> a safe global fallback
    }

    function restoreOne(svg) {
      var o = svg.__cdbSpinnerOrig || STAR, i;
      if (!o) return false;
      clear(svg);
      for (i = 0; i < o.kids.length; i++) svg.appendChild(o.kids[i].cloneNode(true));
      if (o.vb === null || o.vb === undefined) svg.removeAttribute("viewBox");
      else svg.setAttribute("viewBox", o.vb);
      dropAnimClasses(svg);
      svg.removeAttribute(STAMP_ATTR);
      try { delete svg.__cdbSpinnerOrig; } catch (e) { svg.__cdbSpinnerOrig = null; }
      return true;
    }

    // --- render ----------------------------------------------------------------------

    function pathEl(p) {
      var el = document.createElementNS(SVGNS, "path");
      el.setAttribute("d", p.d);
      // omitted / "currentColor" -> inherit theme accent via the svg's fill-current class.
      // explicit hex/hsl -> fixed color (multi-color shapes like the mushroom).
      if (p.fill && p.fill !== "currentColor") el.setAttribute("fill", p.fill);
      return el;
    }

    function frameGroup(paths, n) {
      var g = document.createElementNS(SVGNS, "g"), i;
      g.setAttribute(FRAME_ATTR, n);
      for (i = 0; i < paths.length; i++) g.appendChild(pathEl(paths[i]));
      return g;
    }

    function render(svg, spec) {
      stash(svg);
      clear(svg);
      if (spec.viewBox) svg.setAttribute("viewBox", spec.viewBox);
      if (spec.animation === "flip") {
        // Two sprite frames; the steps() keyframes in the theme CSS show one at a time.
        svg.appendChild(frameGroup(spec.paths, "1"));
        svg.appendChild(frameGroup(spec.paths2, "2"));
      } else {
        for (var i = 0; i < spec.paths.length; i++) svg.appendChild(pathEl(spec.paths[i]));
      }
      dropAnimClasses(svg);
      if (spec.animation && svg.classList) svg.classList.add(ANIM_PREFIX + spec.animation);
      svg.setAttribute(STAMP_ATTR, spec.ver); // idempotency mark (also breaks the loop)
      if (MANAGED.indexOf(svg) < 0) MANAGED.push(svg);
    }

    // --- sweep -----------------------------------------------------------------------

    function sweep(root, spec) {
      if (!root || !spec) return 0;
      var n = 0, svgs, i;
      // the root node might itself BE a target svg (added directly)
      if (root.tagName && String(root.tagName).toLowerCase() === "svg") {
        if (isStarSvg(root)) { render(root, spec); n++; }
      }
      try {
        svgs = root.querySelectorAll ? root.querySelectorAll("svg") : null;
      } catch (e) { svgs = null; }
      if (svgs) {
        for (i = 0; i < svgs.length; i++) {
          if (isStarSvg(svgs[i])) { render(svgs[i], spec); n++; }
        }
      }
      return n;
    }

    // Drop elements the SPA has thrown away, so MANAGED tracks the live page only.
    function prune() {
      var keep = [], i, el, root = document.documentElement;
      for (i = 0; i < MANAGED.length; i++) {
        el = MANAGED[i];
        if (el && root && root.contains(el)) keep.push(el);
      }
      MANAGED = keep;
    }

    // --- the live API ----------------------------------------------------------------
    // Idempotent and re-callable: pass a spec to (re)theme, null to restore Claude's
    // own glyph. Everything else in this file routes through here.

    function apply(raw) {
      var v = validate(raw);
      if (!v.ok) {
        log("refusing spinner spec: " + v.error + " - glyph left untouched");
        return { ok: false, error: v.error };
      }
      var spec = v.spec, i, live;
      CURRENT = spec;
      SIGS = spec ? spec.sigs : DEFAULT_SIGS;
      if (window.__cdbSpinner) {
        window.__cdbSpinner.spec = spec;
        window.__cdbSpinner.version = spec ? spec.ver : null;
      }
      prune();
      live = MANAGED.slice();
      if (!spec) {
        var restored = 0;
        for (i = 0; i < live.length; i++) if (restoreOne(live[i])) restored++;
        MANAGED = [];
        log("restored " + restored + " glyph(s) to Claude's own");
        return { ok: true, applied: 0, restored: restored };
      }
      for (i = 0; i < live.length; i++) render(live[i], spec);
      var fresh = sweep(document.documentElement, spec);
      log("themed " + (live.length + fresh) + " glyph(s) (" + live.length + " re-themed, " +
          fresh + " new)" + (spec.animation ? ", anim=" + spec.animation : ""));
      return { ok: true, applied: live.length + fresh, restored: 0 };
    }

    // --- debounced observer -----------------------------------------------------------
    // Scans ONLY addedNodes (+ their nested svgs), never the whole document, and always
    // with the CURRENT spec. The STAMP_ATTR check makes re-seeing our own writes a no-op,
    // so there is no infinite loop. A burst of mutations collapses into one rAF sweep.

    var pending = false;
    var queued = [];
    var schedule = window.requestAnimationFrame
      ? function (fn) { window.requestAnimationFrame(fn); }
      : function (fn) { window.setTimeout(fn, 16); };

    function flush() {
      pending = false;
      var batch = queued, total = 0, k;
      queued = [];
      if (!CURRENT) return; // stock glyph in effect: nothing to install on new nodes
      for (k = 0; k < batch.length; k++) {
        try { total += sweep(batch[k], CURRENT); } catch (e) {}
      }
      if (total) log("themed " + total + " newly rendered glyph(s)");
    }

    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        if (!added) continue;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) queued.push(added[j]); // ELEMENT_NODE only
        }
      }
      if (pending || queued.length === 0) return;
      pending = true;
      schedule(flush);
    });

    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      log("observer attach error: " + (e && e.message ? e.message : e));
    }

    window.__cdbSpinnerApply = apply;
    window.__cdbSpinner = {
      spec: null,
      version: null,
      apply: apply,
      restore: function () { return apply(null); },
      sweep: function (root) { return sweep(root || document.documentElement, CURRENT); },
      managed: function () { return MANAGED.length; },
      disconnect: function () { try { obs.disconnect(); } catch (e) {} }
    };
  }

  // Install once per window; a re-run of this file only pushes the new spec.
  if (typeof window.__cdbSpinnerApply !== "function") install();

  // The main process re-runs this file (spec prepended) on every theme switch and for
  // every window it opens. For console testing, set window.__CDB_SPINNER_SPEC first.
  if (typeof __CDB_SPINNER_SPEC !== "undefined") {
    try {
      window.__cdbSpinnerApply(__CDB_SPINNER_SPEC);
    } catch (e) {
      log("apply error: " + (e && e.message ? e.message : e));
    }
  }
})();
