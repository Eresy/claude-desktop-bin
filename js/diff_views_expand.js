/*
 * diff_views_expand.js - Expand / collapse ALL files in the Code tab's diff
 * panel. Injected into the claude.ai page AHEAD of js/diff_views_page.js: both
 * halves travel as ONE evaluated string built by
 * patches/add_feature_diff_views.nim, so this file's global exists by the time
 * the page script runs.
 *
 * PUBLIC API - the only thing js/diff_views_page.js may use:
 *
 *   window.__cdbDvExpandAll.create(view, closeControl, log)
 *     -> { button, notifyModeChange, destroy }   or null when it cannot mount
 *
 * WHY CLICKS AND NOT STATE (live-confirmed 1.24012.9, 2026-08-01):
 * upstream's per-file header is a Collapsible trigger over LOCAL useState -
 * `W(e => !e)` - with no store, context or expandAll anywhere in the diff
 * chunk. A synthetic click on the header is the only lever that exists.
 *
 * WHY "EXPAND ALL" CANNOT BE ONE SWEEP: the per-file patch is fetched behind an
 * IntersectionObserver (`enabled: T && isIntersecting`, rootMargin 200px).
 * Until it lands the parsed patch is null, which makes the header `disabled`
 * AND strips its aria-expanded - and browsers do not dispatch click on a
 * disabled button. So a file below the viewport is not expandable yet, at all.
 * Expand-all therefore ARMS a sticky mode: it expands what is expandable now
 * and keeps expanding files as their patches arrive.
 *
 * WHY COLLAPSE RUNS BOTTOM-UP: collapsing runs
 * scrollIntoView({block:"nearest"}) on that file, so the last file collapsed is
 * the one the viewport lands on. Reverse order leaves the user at the top of
 * the diff instead of the bottom.
 *
 * A claude.ai redeploy that renames these hooks degrades this to a disabled
 * button (see refresh()); it must never break the stock panel.
 */
(function () {
  if (window.__cdbDvExpandAll) return;   // idempotent: injected once per page

  // DUPLICATED ON PURPOSE (kept in step by hand, not shared): the same literal
  // is FILE_HEADER_SELECTOR in js/diff_views_page.js. The two halves travel as
  // one evaluated string but neither exports to the other, and threading a
  // shared constant through would mean the page half depending on this module
  // it is designed to work without. A claude.ai redeploy that renames this class
  // MUST change BOTH sites - see js/diff_views_page.js FILE_HEADER_SELECTOR.
  var HEADER_SELECTOR = "button.epitaxy-panel-subheader";
  var CLOSE_CONTROL_CLASS = "epitaxy-pane-close-control";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var FONT_FAMILY = "Anthropicons-Variable";
  // Anthropicons codepoints, verified against the shipped woff2 cmap AND by
  // rasterising the real font (2026-08-01, 1.24012.9). CaretUpDown's carets
  // point AWAY from each other (expand), CaretDownUp's point TOWARD (collapse).
  var CP_EXPAND = 0xe02c;
  var CP_COLLAPSE = 0xe028;
  var TITLE_EMPTY = "no files in this diff";
  // How long "headers exist but not one exposes aria-expanded" has to hold
  // before we say so. On a large diff that state is briefly NORMAL - nothing
  // has loaded yet - so it is not evidence of a broken contract until it lasts.
  var STUCK_MS = 5000;

  function setAttrs(node, map) {
    for (var k in map) { if (map.hasOwnProperty(k)) node.setAttribute(k, map[k]); }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- header classification ---------------------------------------------
  // ARIA, not class names: aria-expanded is upstream's own state contract and
  // survives a re-minify that renames every class in the panel.
  function classify(view) {
    var out = { total: 0, expandable: [], expanded: [], pending: 0 };
    var all;
    try { all = view.querySelectorAll(HEADER_SELECTOR); } catch (e) { return out; }
    out.total = all.length;
    for (var i = 0; i < all.length; i++) {
      var a = all[i].getAttribute("aria-expanded");
      if (a === "false") out.expandable.push(all[i]);
      else if (a === "true") out.expanded.push(all[i]);
      else out.pending++;
    }
    return out;
  }

  // ---- icons --------------------------------------------------------------

  // Our own glyph, drawn from primitives - no innerHTML (CSP / Trusted Types).
  // 1em square so it takes the size of the cloned control's own box.
  function svgIcon(dir) {
    var svg = document.createElementNS(SVG_NS, "svg");
    setAttrs(svg, {
      width: "1em", height: "1em", viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false"
    });
    // expand: apexes point AWAY (up on top, down below).
    // collapse: apexes point TOWARD each other.
    var pts = dir === "expand"
      ? ["6,10 12,4 18,10", "6,14 12,20 18,14"]
      : ["6,4 12,10 18,4", "6,20 12,14 18,20"];
    for (var i = 0; i < pts.length; i++) {
      var p = document.createElementNS(SVG_NS, "polyline");
      p.setAttribute("points", pts[i]);
      svg.appendChild(p);
    }
    return svg;
  }

  // Upstream's own icon markup, plus the family INLINE: if a future release
  // renames the .ico class, the inline family still resolves the font.
  function fontIcon(cp) {
    var s = document.createElement("span");
    s.className = "ico";
    s.setAttribute("data-cds", "Icon");
    s.setAttribute("aria-hidden", "true");
    s.style.fontFamily = FONT_FAMILY;
    s.style.fontSize = "16px";
    s.style.lineHeight = "1";
    s.textContent = String.fromCodePoint(cp);
    return s;
  }

  // THE WHOLE REASON THIS EXISTS: Anthropicons' .notdef is EMPTY (verified
  // 2026-08-01 against 1.24012.9). An unmapped codepoint draws NOTHING - no
  // tofu, no error - and every codepoint reports the same advance width, so
  // width cannot tell them apart. Only ink can. A codepoint that shifts in a
  // future release would otherwise turn the button invisible, silently.
  function glyphHasInk(cp) {
    try {
      var c = document.createElement("canvas");
      c.width = 32;
      c.height = 32;
      var g = c.getContext("2d");
      if (!g) return false;
      g.clearRect(0, 0, 32, 32);
      g.fillStyle = "#000";
      g.font = '400 24px "' + FONT_FAMILY + '"';
      g.textBaseline = "alphabetic";
      g.fillText(String.fromCodePoint(cp), 2, 26);
      var d = g.getImageData(0, 0, 32, 32).data;
      for (var i = 3; i < d.length; i += 4) { if (d[i] > 8) return true; }
      return false;
    } catch (e) { return false; }
  }

  // Linux/Chromium's OWN last-resort fallback draws a visible (non-empty)
  // tofu glyph for an unmapped Private Use Area codepoint when the requested
  // family does not exist at all - measured 2026-08-01: canvas fillText with
  // an undeclared "Anthropicons-Variable" still returns max alpha 131 for
  // U+E02C. That defeats glyphHasInk on its own: ink alone cannot tell "our
  // font is loaded and this codepoint moved" apart from "our font never
  // loaded and the platform substituted something else." So gate on the font
  // actually being registered via @font-face (status "loaded") FIRST; only
  // then does ink measurement mean anything.
  // Wrapped like its sibling glyphHasInk: document.fonts is a live FontFaceSet
  // and iterating it can throw in a hostile/partial environment. Throwing here
  // must FAIL SAFE - false means "cannot prove the font is loaded", which keeps
  // the hand-drawn SVG, never a possibly-blank glyph.
  function fontFamilyLoaded() {
    try {
      if (!document.fonts || typeof document.fonts.forEach !== "function") return false;
      var found = false;
      document.fonts.forEach(function (f) {
        if (f.family === FONT_FAMILY && f.status === "loaded") found = true;
      });
      return found;
    } catch (e) { return false; }
  }

  var fontOk = null;          // null = undecided, true/false = decided once
  var fontWaiters = [];
  var fontLogged = false;

  function probeFont(log, cb) {
    if (fontOk !== null) { cb(fontOk); return; }
    fontWaiters.push(cb);
    if (fontWaiters.length > 1) return;   // a probe is already in flight
    var decide = function () {
      fontOk = fontFamilyLoaded() && glyphHasInk(CP_EXPAND) && glyphHasInk(CP_COLLAPSE);
      if (!fontLogged) {
        fontLogged = true;
        log("expand-all icon source: " + (fontOk ? "font (Anthropicons glyphs verified)"
          : "svg fallback (the icon-font glyphs draw no ink here)"));
      }
      var list = fontWaiters;
      fontWaiters = [];
      for (var i = 0; i < list.length; i++) { try { list[i](fontOk); } catch (e) {} }
    };
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('16px "' + FONT_FAMILY + '"').then(decide, decide);
        return;
      }
    } catch (e) {}
    decide();
  }

  window.__cdbDvExpandAll = {
    marker: "__CDB_DV_EXPAND_ALL__",

    create: function (view, closeControl, log) {
      if (!view || !view.querySelectorAll) return null;
      if (!closeControl || !closeControl.cloneNode) return null;
      var say = (typeof log === "function") ? log : function () {};

      // ---- the button: a stripped clone of the close control --------------
      // Cloning is what gives us upstream's hover, focus ring, size and theme
      // without naming one of its classes. cloneNode copies no React props, so
      // the clone carries none of upstream's behavior - our listener is the
      // only one on it.
      var button = closeControl.cloneNode(true);
      clear(button);
      // MANDATORY: without this, the page script's own close-control sweep
      // discovers our clone and installs another UI beside it, every sweep,
      // forever.
      if (button.classList) button.classList.remove(CLOSE_CONTROL_CLASS);
      var names = [];
      if (button.attributes) {
        for (var i = 0; i < button.attributes.length; i++) names.push(button.attributes[i].name);
      }
      for (var j = 0; j < names.length; j++) {
        var n = names[j];
        // `on*` is in the list because an inline handler is the one attribute
        // cloneNode DOES carry over: upstream's close control has none today,
        // but if one ever grows an onclick, our clone would close the panel on
        // top of expanding it. Everything else here is identity/interaction
        // state that must not be duplicated onto a second node.
        if (n === "id" || n === "title" || n === "disabled" ||
            n.indexOf("aria-") === 0 || n === "data-state" ||
            n.indexOf("data-radix") === 0 || n.indexOf("data-headlessui") === 0 ||
            n.indexOf("on") === 0) {
          button.removeAttribute(n);
        }
      }
      if (button.tagName === "BUTTON") button.setAttribute("type", "button");
      button.setAttribute("data-cdb-dv-toggle", "1");
      if (button.classList) button.classList.add("cdb-dv-toggle");

      var destroyed = false;
      var iconDir = null;
      var iconSource = "none";   // what is on screen RIGHT NOW: none|svg|font

      // SVG FIRST, then upgrade. The button is never blank in any failure mode:
      // no canvas, no font, a codepoint that moved - all of them just keep the
      // SVG. The upgrade is guarded on iconDir so a slow probe cannot repaint
      // the wrong direction.
      function paintIcon(dir) {
        if (iconDir === dir) return;
        iconDir = dir;
        clear(button);
        var svg = svgIcon(dir);
        svg.setAttribute("data-cdb-dir", dir);
        button.appendChild(svg);
        iconSource = "svg";
        probeFont(say, function (ok) {
          if (destroyed || !ok || iconDir !== dir) return;
          clear(button);
          button.appendChild(fontIcon(dir === "expand" ? CP_EXPAND : CP_COLLAPSE));
          iconSource = "font";
        });
      }

      function setDisabled(off) {
        if (off) {
          if (!button.hasAttribute("disabled")) button.setAttribute("disabled", "");
          button.setAttribute("aria-disabled", "true");
        } else if (button.hasAttribute("disabled")) {
          button.removeAttribute("disabled");
          button.removeAttribute("aria-disabled");
        }
      }

      var armed = false;
      // BELT AND BRACES, and measured to be inert: MutationObserver callbacks are
      // MICROTASKS, and element.click() does not run a microtask checkpoint, so
      // every record from clickExpand/clickCollapse is delivered after the
      // `finally { busy = false }` has already run. Nothing today depends on it.
      // Kept anyway: it costs nothing and it is the only guard that would still
      // hold if a future browser (or a synthetic-event shim) ever delivered a
      // record synchronously. The two LOAD-BEARING guards are elsewhere - see
      // the observer below.
      var busy = false;
      var frame = 0;
      var stuckSince = 0;
      var stuckLogged = false;

      function titleFor(dir, st) {
        if (button.hasAttribute("disabled")) {
          return st.total > 0
            ? "no files loaded yet - scroll the diff to load them"
            : TITLE_EMPTY;
        }
        var t = dir === "expand" ? "Expand all files" : "Collapse all files";
        if (armed) {
          t += dir === "expand"
            ? " (auto-expanding newly loaded files - click Collapse to stop)"
            : " (also stops auto-expanding)";
        }
        if (dir === "expand" && st.pending > 0) {
          t += " - " + st.pending + " file(s) not loaded yet; they expand as you scroll";
        }
        return t;
      }

      // "Headers exist but not one exposes aria-expanded" is NORMAL for a moment
      // on a large diff - nothing has loaded yet. It only becomes evidence that
      // upstream's contract moved once it PERSISTS, so it is timed, not
      // latched on the first observation. Logged once either way.
      function maybeLogStuck(st) {
        var stuck = st.total > 0 && st.expandable.length === 0 && st.expanded.length === 0;
        if (!stuck) { stuckSince = 0; return; }
        var now = new Date().getTime();
        if (!stuckSince) { stuckSince = now; return; }
        if (stuckLogged || now - stuckSince < STUCK_MS) return;
        stuckLogged = true;
        say("expand-all: " + st.total + " file header(s) and not one exposes aria-expanded after " +
            Math.round((now - stuckSince) / 1000) + "s - either nothing has loaded or upstream's " +
            "attribute contract changed; the button stays disabled rather than clicking blindly");
      }

      function refresh() {
        if (destroyed) return;
        var st = classify(view);
        for (var i = 0; i < st.expanded.length; i++) handled.add(st.expanded[i]);
        // SAFETY NET, before anything is painted: sticky can outlive the last
        // open file, because `armed` is only cleared by a collapse press, a
        // scope change or destroy(). Close every file by hand and the direction
        // flips to EXPAND while armed is still true - and the tooltip would then
        // tell the user to "click Collapse to stop" a button that offers no
        // Collapse. Make the STATE honest instead of the copy cleverer. Every
        // one of those headers is already in `handled` (seen open), so nothing
        // was going to be re-expanded anyway; this only stops the lie. It is a
        // real transition, so it is logged once - and it can only fire once,
        // because it clears the very flag it tests.
        if (armed && st.expanded.length === 0 && st.expandable.length > 0) {
          armed = false;
          say("expand-all: auto-expand OFF - nothing is open any more, so the button " +
              "reads Expand again");
        }
        var dir = st.expanded.length > 0 ? "collapse" : "expand";
        setDisabled(st.expandable.length + st.expanded.length === 0);
        paintIcon(dir);
        if (armed) button.setAttribute("data-cdb-dv-armed", "1");
        else button.removeAttribute("data-cdb-dv-armed");
        button.title = titleFor(dir, st);
        if (armed && !busy) autoExpand(st);
        maybeLogStuck(st);
      }

      // Coalesce a burst of mutations into ONE recompute. setTimeout, NOT
      // requestAnimationFrame, deliberately: rAF is suspended outright while the
      // window is hidden or occluded, so a panel that changed while the user was
      // away would keep a stale button; the work here is a title/attribute/icon
      // update, not animation, so paint alignment buys nothing; and rAF never
      // fires at all under the `chromium --headless --dump-dom` harness this
      // project tests with (measured 2026-08-01: RAF=0, TIMEOUT=5, OBS=2 in one
      // run), which would leave this whole repaint path unobservable.
      function schedule() {
        if (destroyed || frame) return;
        frame = setTimeout(function () { frame = 0; refresh(); }, 16);
      }

      // Headers we have SEEN OPEN. Marking on observed-expanded (not merely on
      // our own click) is what stops sticky mode fighting the user: a file the
      // user opened by hand and then closed went true -> false, and because it
      // was marked while it was open, sticky leaves it closed. Marking only our
      // own clicks would re-expand it on the very next tick.
      //
      // Keying on the element is safe here: the scroll container maps over the
      // FULL file list and only the patch CONTENT is lazy, so per-file wrappers
      // persist across scrolling. If upstream ever virtualises the list itself,
      // a recycled element loses its mark and could be re-expanded once.
      var handled = new WeakSet();

      function clickExpand(list) {
        busy = true;
        try {
          for (var i = 0; i < list.length; i++) {
            handled.add(list[i]);            // mark BEFORE clicking
            try { list[i].click(); } catch (e) {}
          }
        } finally { busy = false; }
        schedule();
      }

      // Sticky mode's payoff: anything expandable that has not been SEEN OPEN
      // yet (never marked in `handled`) gets clicked. Because refresh() marks
      // every currently-expanded header before calling this, a file the user
      // just collapsed by hand is already in `handled` and is correctly
      // skipped here - only a genuinely new/never-opened header qualifies.
      function autoExpand(st) {
        var todo = [];
        for (var i = 0; i < st.expandable.length; i++) {
          if (!handled.has(st.expandable[i])) todo.push(st.expandable[i]);
        }
        if (todo.length) clickExpand(todo);
      }

      // NOT marked: `handled` means "seen open", and these are being closed.
      function clickCollapse(list) {
        busy = true;
        try {
          for (var i = 0; i < list.length; i++) {
            try { list[i].click(); } catch (e) {}
          }
        } finally { busy = false; }
        schedule();
      }

      function press() {
        if (destroyed || button.hasAttribute("disabled")) return;
        var st = classify(view);
        if (st.expanded.length > 0) {
          // Disarm FIRST: with sticky still on, the observer would re-expand
          // everything we are about to close.
          armed = false;
          // Bottom-up: upstream runs scrollIntoView({block:"nearest"}) on each
          // collapse, so the LAST file closed is the one the viewport lands on.
          var rev = st.expanded.slice().reverse();
          clickCollapse(rev);
          say("expand-all: collapsed " + rev.length + " file(s); auto-expand OFF");
          return;
        }
        armed = true;
        clickExpand(st.expandable);
        say("expand-all: expanded " + st.expandable.length + " file(s), " +
            st.pending + " not loaded yet; auto-expand ON");
      }

      button.addEventListener("click", function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        press();
      });

      // ONE observer, always running - NOT armed-only. Two of its three jobs
      // have nothing to do with sticky mode: repainting the direction when
      // someone else expands a file, and re-enabling the button once the file
      // list mounts (which happens AFTER the chrome row, every time).
      //
      // OUR OWN BUTTON IS INSIDE THIS SUBTREE: it lives in the chrome row, which
      // is inside `view`. Repainting it therefore mutates the very tree we are
      // observing, and every external transition would come back to us as one
      // echo tick. TWO things are load-bearing against that: this filter, which
      // drops records originating in our own button, and paintIcon/setDisabled
      // being idempotent, which makes an echo that slips through a no-op. (The
      // `busy` flag above is a third mechanism on paper only - see its comment:
      // it is always back to false before any record is delivered.) The filter
      // is what makes "no self-retrigger" a property of the observer rather than
      // a side effect of the idempotence staying intact.
      var obs = new MutationObserver(function (records) {
        if (busy) return;
        for (var i = 0; i < records.length; i++) {
          var t = records[i].target;
          if (t !== button && !(button.contains && button.contains(t))) {
            schedule();
            return;
          }
        }
      });
      try {
        obs.observe(view, {
          subtree: true, childList: true,
          attributes: true, attributeFilter: ["aria-expanded", "disabled"]
        });
      } catch (e) {
        say("expand-all: could not observe the diff view (" + String(e) +
            ") - the button will not follow later changes");
      }

      refresh();

      // MANDATORY one-shot install line (spec section 4). It is the ONLY log a
      // renamed `button.epitaxy-panel-subheader` would produce: classify() would
      // return total=0, maybeLogStuck() short-circuits on `st.total > 0`, and the
      // user would otherwise get a disabled button claiming "no files in this
      // diff" on a panel full of files, with nothing in the log at all.
      //
      // `icon=` reports WHAT IS ON SCREEN AT THIS MOMENT, not the final answer:
      // the font probe is asynchronous and is usually still in flight here, so
      // this normally says svg. The separate one-shot "expand-all icon source:"
      // line is what records the decision, including a later upgrade to the
      // glyph. Said explicitly in the text so the two lines cannot be read as
      // contradicting each other.
      var st0 = classify(view);
      say("expand-all installed: headers=" + st0.total +
          " expandable=" + st0.expandable.length +
          " expanded=" + st0.expanded.length +
          " pending=" + st0.pending +
          " icon=" + iconSource +
          " (icon as painted now; the async font probe reports its verdict on the " +
          "\"icon source\" line)");

      return {
        button: button,
        // Called by the page script when the diff-scope dropdown changes. The
        // file list is wholly replaced, so staying armed could dump a large
        // branch diff open unasked - a conservative, deliberate choice.
        notifyModeChange: function () {
          if (armed) {
            armed = false;
            say("expand-all: auto-expand OFF (the diff scope changed)");
          }
          schedule();
        },
        // IDEMPOTENT BY CONSTRUCTION, and it has to be: the page script reaches
        // it from three paths that can overlap - pruneInstalls() on unmount,
        // removeAllUi() when the feature switch goes off, and the reinstall
        // branch of installOnCloseControl. Every step below is either a plain
        // assignment or guarded, and disconnect() on an already-disconnected
        // observer is a no-op, so a second call changes nothing.
        destroy: function () {
          destroyed = true;
          try { obs.disconnect(); } catch (e) {}
          if (frame) { clearTimeout(frame); frame = 0; }
          if (button.parentNode) button.parentNode.removeChild(button);
        }
      };
    }
  };
})();

