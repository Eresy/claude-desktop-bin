/*
 * extra_settings_page.js - the "Extra" area inside the claude.ai Settings modal.
 *
 * Injected with webContents.executeJavaScript() on every http(s) dom-ready by
 * patches/add_feature_extra_settings.nim. The IIFE returns a one-line status
 * string, which the main process logs to logs/claude-patches.log.
 *
 * The Settings modal belongs to the REMOTE claude.ai SPA: we do not control its
 * markup and it can change without a desktop release. The shape this file is
 * fitted to is captured verbatim in baseline/SETTINGS_NAV_CAPTURE.md - READ THAT
 * FIRST when refitting. Its load-bearing facts:
 *
 *   - there is NO per-group wrapper. ONE scroll container holds a group HEADER
 *     div and a group <ul> as plain alternating SIBLINGS, and the last group is
 *     a header followed by a bare <a> with no list at all.
 *   - a row is <li><button><span data-cds="Icon"><span label>. The icon is an
 *     Anthropicons ICON-FONT span whose text is a private-use ligature - not an
 *     <svg>, not an <img>.
 *   - the selected row carries aria-current="page" on the BUTTON, plus a class
 *     swap against its unselected siblings.
 *
 * Four rules follow from that.
 *
 *   1. SEMANTIC ANCHORS ONLY. Never a minified or generated class name. The nav
 *      is located by finding known settings labels ("General", "Account", ...)
 *      inside a [role=dialog] and taking the CONTROL each label sits in; the
 *      insertion point is the group header whose visible text is "Desktop app".
 *      The icon box is found by its data-cds attribute, and the label span by
 *      being the element that is NOT that box.
 *   2. NOTHING IS FABRICATED THAT CAN BE CLONED. Our group header is a clone of
 *      a real header, our list a clone of a real <ul>, our rows clones of a real
 *      row, and the selected look is BORROWED at click time by diffing the real
 *      selected button against its siblings. Font, size, indentation, icon box
 *      and pill all come from upstream classes we never have to name - and they
 *      keep working when upstream restyles them.
 *   3. EVERY FAILURE IS SOFT, AND NEVER PRODUCES INVALID MARKUP. If the dialog
 *      never appears, or the nav cannot be identified, we log at most one line
 *      and do nothing. With no group header to anchor on, our rows are appended
 *      to the last real list behind a divider row - a <li> inside a <ul>, never
 *      a <div>. If the selected-row diff is ambiguous, our own outline marks the
 *      active item rather than a wrong pill. The standalone Ctrl+Shift+T theme
 *      picker window stays the robust fallback.
 *   4. The installer logs one sanitized DOM-shape line (tag names and class
 *      COUNTS) to logs/claude-patches.log: that line, together with the capture
 *      above, is the ground truth to re-fit this file and
 *      scripts/test-extra-settings-dom.mjs against when the remote SPA changes.
 *
 * Upstream content is hidden, never removed: the detected content pane keeps its
 * node and only gets display:none while our panel is mounted next to it, and it
 * is restored when the user clicks any upstream nav item. What we hide is the
 * SCROLLING BODY of the content area, so the modal's own header row - which
 * carries the close button - stays visible next to our panel.
 */
(function () {
  "use strict";

  if (window.__cdbExtraInstalled) return "extra-settings: already installed";

  // Not a hostname check on purpose: 3p / gateway deployments serve a different
  // origin through this same preload. The bindings + our bridge ARE the check.
  var api = window.cdbExtra;
  if (!window.claudeAppBindings || !api || typeof api.flagsCatalog !== "function") {
    return "extra-settings: skipped, no claudeAppBindings/cdbExtra in this view";
  }
  window.__cdbExtraInstalled = true;

  // Labels of upstream settings nav items, lowercased. Only used to LOCATE the
  // nav - a stale entry costs nothing, and the nav is accepted only when at
  // least MIN_HITS of them resolve to a control.
  var NAV_LABELS = [
    "general", "account", "profile", "appearance", "capabilities", "connectors",
    "data controls", "privacy", "notifications", "desktop app", "desktop",
    "keyboard shortcuts", "shortcuts", "integrations", "extensions", "billing",
    "subscription", "plan", "security", "usage", "language", "models",
    "experimental", "developer", "about", "sessions", "memory", "projects",
    "spaces", "skills", "plugins", "personalization", "behavior", "beta",
    "cowork"
  ];

  // Texts upstream uses as GROUP headers, lowercased and in priority order. The
  // first one found becomes the INSERTION ANCHOR (our header and list go
  // immediately before it) and the group whose header and list we clone, so
  // "desktop app" first keeps Extra where it has always been: after the group
  // that ends with Cowork.
  var GROUP_LABELS = ["desktop app", "customize", "settings"];

  var MIN_HITS = 3;
  var MIN_PANE_AREA = 20000;

  // A nav row is a CONTROL, never a class: upstream uses <button> inside <li>
  // for settings rows and a bare <a> for the organization link.
  var CONTROL_SEL = 'button,a,[role="button"],[role="tab"],[role="menuitem"],[role="option"]';

  // Upstream row icons are Anthropicons ICON-FONT spans - a 1em flex box whose
  // text is a private-use ligature character. This attribute is the only stable
  // handle on them, and it is what tells the icon box apart from the label span.
  var ICON_SEL = '[data-cds="Icon"]';

  // Attributes upstream may use to mark the selected row, in addition to
  // classes. aria-current is the one the capture shows.
  var SEL_ATTRS = ["aria-current", "aria-selected", "data-state", "data-active"];

  // Attributes that belong to the row we cloned, not to us.
  var CLONE_DROP = ["id", "href", "data-testid", "aria-controls", "aria-labelledby", "aria-describedby"];

  var logged = {};
  function diag(key, message) {
    if (logged[key]) return;
    logged[key] = 1;
    try { api.diag(message); } catch (e) {}
  }

  // --- tiny DOM helpers ----------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function area(node) {
    try {
      var r = node.getBoundingClientRect();
      var a = r.width * r.height;
      if (a > 0) return a;
    } catch (e) {}
    return node.offsetWidth * node.offsetHeight;
  }

  // --- nav discovery -------------------------------------------------------

  function isControl(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === "BUTTON" || node.tagName === "A") return true;
    var role = node.getAttribute("role");
    return role === "button" || role === "tab" || role === "menuitem" || role === "option";
  }

  function isList(node) {
    return !!node && (node.tagName === "UL" || node.tagName === "OL");
  }

  function isOurs(node) {
    return node.classList.contains("cdbx-item") ||
      node.classList.contains("cdbx-item-btn") ||
      node.classList.contains("cdbx-group") ||
      !!(node.closest && node.closest(".cdbx-item,.cdbx-group"));
  }

  // The smallest element whose whole text is exactly one known nav label.
  function isLabelLeaf(node) {
    var text = (node.textContent || "").trim();
    if (!text || text.length > 28) return false;
    if (NAV_LABELS.indexOf(text.toLowerCase()) < 0) return false;
    return !hasChildWithSameText(node);
  }

  // The control a label sits in - that IS the nav row. A label leaf that
  // resolves to no control is a GROUP HEADER (upstream's headers are plain text
  // divs), so it drops out here and findAnchor picks it up again.
  function controlFor(node, stop) {
    var n = node;
    var depth = 0;
    while (n && n !== stop && depth++ < 8) {
      if (isControl(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  // The element a list holds. Upstream wraps every settings row in an <li>; the
  // organization link is its own list-less child. Cloning the CELL rather than
  // the control is what lets us append valid <li> children to a cloned <ul>.
  function cellFor(row) {
    var n = row;
    var depth = 0;
    while (n && depth++ < 4) {
      if (n.tagName === "LI") return n;
      if (isList(n)) break;
      n = n.parentElement;
    }
    return row;
  }

  // Locate the nav and the ONE container that holds every group: rows are the
  // controls the known labels sit in, and the container is the parent of the
  // biggest row list - which in the capture is exactly the scroll container
  // where group headers and group lists alternate as siblings.
  //
  // Always returns a record. `leaves` is how settings-like the dialog looked at
  // all, which is what tells "this was not the settings modal" (a confirm dialog,
  // a share sheet - stay quiet) apart from "this WAS the settings modal and we
  // failed" (worth one log line).
  function findNav(dialog) {
    var leaves = [];
    var all = dialog.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (isLabelLeaf(all[i])) leaves.push(all[i]);
    }
    if (leaves.length < MIN_HITS) return { ok: false, leaves: leaves.length, rows: 0 };

    var rows = [];
    for (var j = 0; j < leaves.length; j++) {
      var row = controlFor(leaves[j], dialog);
      if (row && !isOurs(row) && rows.indexOf(row) < 0) rows.push(row);
    }
    if (rows.length < MIN_HITS) return { ok: false, leaves: leaves.length, rows: rows.length };

    var lists = new Map();
    var loose = new Map();
    for (var k = 0; k < rows.length; k++) {
      var parent = cellFor(rows[k]).parentElement;
      if (!parent) continue;
      var bag = isList(parent) ? lists : loose;
      bag.set(parent, (bag.get(parent) || 0) + 1);
    }
    var primary = null;
    var primaryN = 0;
    lists.forEach(function (n, list) {
      if (n > primaryN) { primaryN = n; primary = list; }
    });
    var container = primary ? primary.parentElement : null;
    if (!container) {
      var looseN = 0;
      loose.forEach(function (n, parent) {
        if (n > looseN) { looseN = n; container = parent; }
      });
    }
    if (!container) return { ok: false, leaves: leaves.length, rows: rows.length };
    return {
      ok: true, container: container, rows: rows,
      primaryList: primary, leaves: leaves.length
    };
  }

  function containsAny(node, nodes) {
    for (var i = 0; i < nodes.length; i++) {
      if (node === nodes[i] || node.contains(nodes[i])) return true;
    }
    return false;
  }

  // The content pane: walking up from the nav container, the first large sibling
  // subtree that is no part of the nav itself. Found at click time, when layout
  // is settled. `rows` is what keeps a tall SIBLING GROUP of nav rows from being
  // mistaken for the pane - a pane never contains nav rows.
  function findPane(dialog, container, rows) {
    var node = container;
    var depth = 0;
    while (node && node !== dialog && depth++ < 12) {
      var parent = node.parentElement;
      if (!parent) break;
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var kid = parent.children[i];
        if (kid === node || kid.contains(container)) continue;
        if (kid.classList.contains("cdbx-panel") || isOurs(kid)) continue;
        if (containsAny(kid, rows)) continue;
        var a = area(kid);
        if (a > bestArea) { bestArea = a; best = kid; }
      }
      if (best && bestArea >= MIN_PANE_AREA) return scrollBody(best) || best;
      node = parent;
    }
    return null;
  }

  // Take over the pane's SCROLLING BODY rather than the whole pane: in the
  // capture the pane's first child is the header row that carries the modal's
  // close button, and hiding that would trap the user in the dialog. Anchored on
  // computed overflow, not on a class, and only accepted when that child is most
  // of the pane - otherwise the pane itself is the honest answer.
  function scrollBody(pane) {
    var total = area(pane);
    if (!total) return null;
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < pane.children.length; i++) {
      var kid = pane.children[i];
      if (kid.classList.contains("cdbx-panel")) continue;
      var style = null;
      try { style = getComputedStyle(kid); } catch (e) {}
      if (!style) continue;
      if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
      var a = area(kid);
      if (a > bestArea) { bestArea = a; best = kid; }
    }
    return best && bestArea >= total * 0.5 ? best : null;
  }

  // The row to clone: an UNSELECTED cell of the group we insert next to, so its
  // classes are the plain ones and its icon box is the one we repaint. Cloning
  // the selected row would leave our items looking permanently active. A row
  // that carries an icon is preferred - it is the shape every upstream row has.
  function pickTemplate(list, rows, selected) {
    var cells = [];
    if (list) {
      for (var i = 0; i < list.children.length; i++) {
        var kid = list.children[i];
        if (isOurs(kid)) continue;
        if (isControl(kid) || kid.querySelector(CONTROL_SEL)) cells.push(kid);
      }
    }
    if (!cells.length) {
      for (var j = 0; j < rows.length; j++) {
        var cell = cellFor(rows[j]);
        if (cells.indexOf(cell) < 0) cells.push(cell);
      }
    }
    var plain = null;
    for (var k = cells.length - 1; k >= 0; k--) {
      var candidate = cells[k];
      var control = controlIn(candidate);
      if (!control || control === selected) continue;
      if (isMarkedSelected(control) || isMarkedSelected(candidate)) continue;
      if (control.querySelector(ICON_SEL) || control.querySelector("svg")) return candidate;
      if (!plain) plain = candidate;
    }
    return plain || cells[cells.length - 1] || null;
  }

  // The clickable element of a cell (the cell itself for a list-less row).
  function controlIn(cell) {
    if (isControl(cell)) return cell;
    return cell.querySelector(CONTROL_SEL);
  }

  // The most common control tag among the nav rows. Diffing the selected look
  // only against rows of that tag keeps a differently shaped link (the
  // organization row in the capture) from passing for a second "deviating" row
  // and making the diff ambiguous.
  function majorTag(rows) {
    var counts = {};
    var best = null;
    var bestN = 0;
    for (var i = 0; i < rows.length; i++) {
      var tag = rows[i].tagName;
      counts[tag] = (counts[tag] || 0) + 1;
      if (counts[tag] > bestN) { bestN = counts[tag]; best = tag; }
    }
    return best;
  }

  // Every upstream nav control inside the container, optionally of one tag only.
  function selectionRows(container, tag) {
    var out = [];
    var all = container.querySelectorAll(CONTROL_SEL);
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (isOurs(node)) continue;
      if (tag && node.tagName !== tag) continue;
      out.push(node);
    }
    return out;
  }

  function isMarkedSelected(node) {
    for (var i = 0; i < SEL_ATTRS.length; i++) {
      var v = node.getAttribute(SEL_ATTRS[i]);
      if (v && v !== "false" && v !== "inactive") return true;
    }
    return false;
  }

  function classesOf(node) {
    return Array.prototype.slice.call(node.classList);
  }

  // A clone must carry none of the identity or state of the row it came from:
  // its id and test id would be duplicates, its selection attribute would make
  // our row look active before it is.
  function stripState(root) {
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i++) {
      for (var j = 0; j < CLONE_DROP.length; j++) nodes[i].removeAttribute(CLONE_DROP[j]);
      for (var k = 0; k < SEL_ATTRS.length; k++) nodes[i].removeAttribute(SEL_ATTRS[k]);
    }
  }

  // --- icons ---------------------------------------------------------------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var STROKE = {
    fill: "none", stroke: "currentColor", "stroke-width": "1.7",
    "stroke-linecap": "round", "stroke-linejoin": "round"
  };
  var SOLID = { fill: "currentColor", stroke: "none" };

  // Our own glyphs in a 24x24 box, built from primitives rather than one hand
  // written path: every shape carries its own paint attributes, so they render
  // whether the cloned <svg> was fill-based or stroke-based (attributes on a
  // child win over presentation attributes inherited from the svg element).
  var ICON_THEMES = [
    ["rect", { x: "3.2", y: "3.2", width: "7.6", height: "7.6", rx: "2" }, STROKE],
    ["rect", { x: "13.2", y: "3.2", width: "7.6", height: "7.6", rx: "2" }, SOLID],
    ["rect", { x: "3.2", y: "13.2", width: "7.6", height: "7.6", rx: "2" }, SOLID],
    ["rect", { x: "13.2", y: "13.2", width: "7.6", height: "7.6", rx: "2" }, STROKE]
  ];
  var ICON_FEATURES = [
    ["line", { x1: "3.2", y1: "8", x2: "20.8", y2: "8" }, STROKE],
    ["line", { x1: "3.2", y1: "16", x2: "20.8", y2: "16" }, STROKE],
    ["circle", { cx: "15.5", cy: "8", r: "2.6" }, SOLID],
    ["circle", { cx: "8.5", cy: "16", r: "2.6" }, SOLID]
  ];

  function applyAttrs(node, map) {
    Object.keys(map).forEach(function (k) { node.setAttribute(k, map[k]); });
  }

  function shapeNode(spec) {
    var node = document.createElementNS(SVG_NS, spec[0]);
    applyAttrs(node, spec[1]);
    applyAttrs(node, spec[2]);
    return node;
  }

  // Our glyph, sized in the box upstream gave the row: 1em square inside the
  // icon font's own 1em flex box, so it comes out at the row's font-size (20px
  // in the capture) and in the row's color, exactly like the ligature character
  // it replaces.
  function iconSvg(shapes) {
    var svg = document.createElementNS(SVG_NS, "svg");
    applyAttrs(svg, {
      width: "1em", height: "1em", viewBox: "0 0 24 24",
      fill: "currentColor", "aria-hidden": "true", focusable: "false"
    });
    for (var i = 0; i < shapes.length; i++) svg.appendChild(shapeNode(shapes[i]));
    return svg;
  }

  // Upstream's icon box is kept and only its CONTENT becomes ours: the box holds
  // the font-size, the color class and the flex centering we want to inherit,
  // and its text is a ligature character that must go or it renders next to our
  // glyph.
  function paintIconBox(box, shapes) {
    clear(box);
    box.appendChild(iconSvg(shapes));
  }

  // Should upstream ever go back to a real <svg> icon, repaint it in place: the
  // element itself is left alone (its class and its rendered size are upstream's,
  // and that is the whole point), only its children are replaced. viewBox is the
  // one exception - our coordinates are 24x24, so a different box has to be
  // corrected or the glyph is cropped.
  function paintSvgIcon(svg, shapes) {
    clear(svg);
    if ((svg.getAttribute("viewBox") || "") !== "0 0 24 24") {
      svg.setAttribute("viewBox", "0 0 24 24");
    }
    for (var i = 0; i < shapes.length; i++) svg.appendChild(shapeNode(shapes[i]));
  }

  // --- item cloning --------------------------------------------------------

  // Reuse a real nav row so our items inherit upstream styling without ever
  // naming one of its classes. cloneNode does not copy React's per-node props,
  // so the clone carries no upstream behavior - which is exactly what we want,
  // our own listener is attached afterwards.
  //
  // Returns both halves of the row: the CELL is what a list holds, the CONTROL
  // is what gets clicked and what carries the selected look.
  function makeItem(template, text, shapes) {
    var cell = template.cloneNode(true);
    stripState(cell);
    cell.classList.add("cdbx-item");

    var control = controlIn(cell) || cell;
    control.classList.add("cdbx-item-btn");

    // The icon: upstream's font box if there is one, else a real svg, else
    // nothing but a logged line - a row without a glyph still works.
    var keep = control.querySelector(ICON_SEL);
    if (keep) {
      paintIconBox(keep, shapes);
    } else {
      keep = control.querySelector("svg");
      if (keep) paintSvgIcon(keep, shapes);
    }
    if (!keep) {
      diag("no-icon", "[ExtraSettings] the upstream nav row carries no " + ICON_SEL +
        " icon box and no <svg> - Extra items render without a glyph");
    }
    // A trailing chevron, a second glyph or a bitmap belongs to the row we
    // copied, not to ours, and none of them can be repainted: they go.
    var extra = control.querySelectorAll(ICON_SEL + ",img,picture,svg");
    for (var i = 0; i < extra.length; i++) {
      if (keep && (extra[i] === keep || keep.contains(extra[i]))) continue;
      extra[i].remove();
    }

    setLabel(control, text, keep);
    if (control.tagName !== "BUTTON") {
      // A cloned <a> has had its href stripped, so it is neither focusable nor
      // keyboard-activatable on its own.
      control.setAttribute("role", "button");
      control.setAttribute("tabindex", "0");
    }
    return { cell: cell, control: control };
  }

  // The label element, found SEMANTICALLY: the element inside the row that is
  // not the icon box and does not contain it. Writing into the "first text node"
  // instead lands the word INSIDE the icon-font span, where it renders through
  // the Anthropicons stack while the real label span stays empty - the exact bug
  // this file was refitted for (see baseline/SETTINGS_NAV_CAPTURE.md).
  function labelSlot(control, icon) {
    var best = null;
    var bestScore = 0;
    var all = control.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.namespaceURI === SVG_NS) continue;
      if (icon && (node === icon || icon.contains(node) || node.contains(icon))) continue;
      if (node.matches(ICON_SEL)) continue;
      if (node.querySelector(ICON_SEL + ",svg,img,picture")) continue;
      // A leaf that already held text is the label; the class hints only break
      // ties, so upstream renaming them costs nothing.
      var score = 1;
      if (!node.children.length) score += 4;
      if ((node.textContent || "").trim()) score += 2;
      if (/(^|\s)(truncate|flex-1|min-w-0)(\s|$)/.test(node.getAttribute("class") || "")) score += 3;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  // Our label replaces the cloned one; every other text the row carried (a
  // badge, a description we have no text for) is blanked rather than left to
  // claim it came from us.
  function setLabel(control, text, icon) {
    var slot = labelSlot(control, icon);
    var walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT, null);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (var i = 0; i < texts.length; i++) {
      if (icon && icon.contains(texts[i])) continue;
      texts[i].nodeValue = "";
    }
    if (slot) {
      slot.textContent = text;
      return true;
    }
    control.appendChild(document.createTextNode(text));
    return false;
  }

  // --- group building ------------------------------------------------------

  // The insertion anchor: a DIRECT CHILD of the scroll container whose whole
  // text is one of the known group labels and that holds no nav row. Upstream has
  // no per-group wrapper - headers and lists are plain alternating siblings - so
  // this header is both what we clone and what we insert in front of.
  function findAnchor(container) {
    var kids = container.children;
    for (var g = 0; g < GROUP_LABELS.length; g++) {
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (isList(kid) || isControl(kid) || isOurs(kid)) continue;
        if (kid.querySelector(CONTROL_SEL)) continue;
        if ((kid.textContent || "").trim().toLowerCase() !== GROUP_LABELS[g]) continue;
        return { header: kid, label: GROUP_LABELS[g] };
      }
    }
    return null;
  }

  function hasChildWithSameText(node) {
    var text = (node.textContent || "").trim();
    for (var i = 0; i < node.children.length; i++) {
      if ((node.children[i].textContent || "").trim() === text) return true;
    }
    return false;
  }

  // Where the header's text lives: the header element itself, or the innermost
  // descendant that carries all of it. Putting our word there keeps whatever
  // classes upstream gave that element.
  function textSlot(header) {
    var text = (header.textContent || "").trim();
    var node = header;
    var depth = 0;
    while (depth++ < 4) {
      var hit = null;
      for (var i = 0; i < node.children.length; i++) {
        if ((node.children[i].textContent || "").trim() === text) { hit = node.children[i]; break; }
      }
      if (!hit) break;
      node = hit;
    }
    return node;
  }

  // Our group is TWO SIBLINGS, mirroring upstream: a clone of a real group header
  // (only its text becomes "Extra", on an inner span so our rainbow gradient does
  // not disturb upstream's own size and spacing) and a clone of a real group list
  // holding our two cloned rows. The list is cloned SHALLOW: it keeps every class
  // and no upstream row comes along.
  function buildGroup(anchor, list, template) {
    var header = anchor.header.cloneNode(true);
    stripState(header);
    var slot = textSlot(header);
    clear(slot);
    if (slot !== header) {
      var walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT, null);
      var texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (var t = 0; t < texts.length; t++) texts[t].nodeValue = "";
    }
    slot.appendChild(el("span", "cdbx-navgroup", "Extra"));
    header.classList.add("cdbx-group", "cdbx-navhdr");

    var ourList = list.cloneNode(false);
    stripState(ourList);
    ourList.classList.add("cdbx-group", "cdbx-navlist");

    var items = [makeItem(template, "Themes", ICON_THEMES),
                 makeItem(template, "Features", ICON_FEATURES)];
    for (var i = 0; i < items.length; i++) ourList.appendChild(items[i].cell);

    return {
      header: header, list: ourList, items: items,
      label: anchor.label, fallback: false
    };
  }

  function lastList(container) {
    var found = null;
    for (var i = 0; i < container.children.length; i++) {
      var kid = container.children[i];
      if (isList(kid) && !isOurs(kid)) found = kid;
    }
    return found;
  }

  // Fallback rendering: no group header to anchor on, so the frame is ours -
  // cdbx-navgroup-fb carries the size and spacing upstream would have given it.
  // The rows are still real clones, and whatever the host turns out to be we
  // append a VALID child to it: an <li> divider inside a list, a <div> only
  // inside a non-list. A <div> in a <ul> is what the previous fallback produced,
  // and it is what made the injection misrender.
  function fabricateGroup(container, list, template) {
    var items = [makeItem(template, "Themes", ICON_THEMES),
                 makeItem(template, "Features", ICON_FEATURES)];
    var host = list && template.tagName === "LI" ? list : container;
    var header = document.createElement(isList(host) ? "li" : "div");
    header.className = "cdbx-group cdbx-navgroup-fb";
    header.appendChild(el("span", "cdbx-navgroup", "Extra"));
    host.appendChild(header);
    for (var i = 0; i < items.length; i++) host.appendChild(items[i].cell);
    return {
      header: header, list: null, items: items,
      label: "", fallback: true, host: host
    };
  }

  // --- selection state -----------------------------------------------------

  // Upstream marks the selected row with extra classes and/or an attribute - in
  // the capture, aria-current="page" on the BUTTON plus a swap of colour classes.
  // The difference is discovered at runtime by comparing every row against the
  // class shape most of them share, so our item can borrow the real pill instead
  // of an imitation of it. Returns the node plus the exact two-way diff.
  function findSelected(rows) {
    var counts = {};
    var base = null;
    var bestN = 0;
    var candidates = [];
    for (var i = 0; i < rows.length; i++) {
      if (isOurs(rows[i])) continue;
      candidates.push(rows[i]);
      var key = classesOf(rows[i]).sort().join(" ");
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestN) { bestN = counts[key]; base = key; }
    }
    if (base === null || candidates.length < 2) return null;
    var baseClasses = base ? base.split(" ") : [];

    var attrHit = null;
    var odd = [];
    for (var j = 0; j < candidates.length; j++) {
      var row = candidates[j];
      var mine = classesOf(row);
      var add = mine.filter(function (c) { return baseClasses.indexOf(c) < 0; });
      var drop = baseClasses.filter(function (c) { return mine.indexOf(c) < 0; });
      var attrs = [];
      for (var a = 0; a < SEL_ATTRS.length; a++) {
        var v = row.getAttribute(SEL_ATTRS[a]);
        if (v && v !== "false" && v !== "inactive") attrs.push({ name: SEL_ATTRS[a], value: v });
      }
      var hit = { node: row, add: add, drop: drop, attrs: attrs };
      if (attrs.length && !attrHit) attrHit = hit;
      if (add.length || drop.length) odd.push(hit);
    }
    // An attribute is unambiguous. A class diff is only trusted when EXACTLY one
    // row deviates from the shared shape: with several deviating rows the diff
    // could just as well be a badge, and borrowing it would be a wrong pill.
    if (attrHit) return attrHit;
    return odd.length === 1 ? odd[0] : null;
  }

  // --- one-time DOM shape diagnostic ---------------------------------------

  // Tag names and class COUNTS only, never a class name and never page text:
  // ground truth for the next refit when the remote SPA changes shape. Compare it
  // against baseline/SETTINGS_NAV_CAPTURE.md, which is the shape this file fits.
  function shapeOf(node, depth) {
    if (!node || node.nodeType !== 1) return "?";
    var tag = (node.namespaceURI === SVG_NS ? node.nodeName : node.tagName).toLowerCase();
    var out = tag + "." + node.classList.length;
    if (depth > 0 && node.children.length) {
      var parts = [];
      var n = Math.min(node.children.length, 4);
      for (var i = 0; i < n; i++) parts.push(shapeOf(node.children[i], depth - 1));
      if (node.children.length > n) parts.push("+" + (node.children.length - n));
      out += "(" + parts.join(",") + ")";
    }
    return out;
  }

  // --- toast ---------------------------------------------------------------

  var toastNode = null;
  var toastTimer = null;
  function toast(message, bad) {
    if (!toastNode) {
      toastNode = el("div", "cdbx-toast");
      document.body.appendChild(toastNode);
    }
    toastNode.textContent = message;
    toastNode.className = "cdbx-toast cdbx-toast-on" + (bad ? " cdbx-toast-bad" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastNode.className = "cdbx-toast";
    }, bad ? 6000 : 2600);
  }

  function failed(result) {
    return !result || result.ok !== true;
  }

  function reason(result) {
    if (!result) return "no response from the main process";
    return result.error || "unknown error";
  }

  // --- themes panel --------------------------------------------------------

  // Sections in render order, mirroring the standalone Ctrl+Shift+T picker. A
  // section with no themes is omitted entirely. "gaming" is keyed on the entry's
  // category rather than its source, and "other" exists so a source tier we do
  // not know yet is still shown instead of silently dropped.
  var THEME_SECTIONS = [
    { key: "custom", label: "Your themes" },
    { key: "gaming", label: "Gaming" },
    { key: "builtin", label: "Built-in" },
    { key: "community", label: "Community" },
    { key: "other", label: "More" }
  ];

  // Category wins over source, so a gaming palette is in Gaming wherever it came
  // from. An entry with no category (or from a registry that does not report one
  // yet) is bucketed by source exactly as before.
  function themeBucket(entry) {
    if ((entry.category || "") === "gaming") return "gaming";
    var source = entry.source || "";
    if (source === "custom" || source === "builtin" || source === "community") return source;
    return "other";
  }

  function themeName(entry) {
    return (entry.displayName || entry.name || "").toLowerCase();
  }

  // --- motion: the pulsing Cowork glow ------------------------------------
  // Sits at the top of the Features panel rather than in its own nav entry - it
  // is ours and applies live, so it goes ahead of the GrowthBook flag list.
  function renderGlowRow(panel) {
    // The bridge half of this switch lives in the mainView preload. If an older
    // preload is in place (a partially updated install), skip the row instead of
    // throwing and taking the whole Features panel down with it.
    if (!api || typeof api.glowRead !== "function" || typeof api.glowSet !== "function") return;

    var head = el("div", "cdbx-sec-h");
    head.appendChild(el("span", "cdbx-sec-t", "Motion"));
    panel.appendChild(head);

    var host = el("div", "cdbx-list");
    var node = el("div", "cdbx-row");
    var main = el("div", "cdbx-row-main");
    main.appendChild(el("div", "cdbx-id", "Calm the Cowork glow"));
    // Keep this short: the mechanism and the GPU reasoning belong in the README
    // and the patch header, not in front of the user.
    main.appendChild(el("div", "cdbx-note",
      "Stops the Cowork hero glow from pulsing and dims it. Easier on laptops and weak GPUs. Applies live."));
    var stateLine = el("div", "cdbx-state", "Loading...");
    main.appendChild(stateLine);
    node.appendChild(main);

    var aside = el("div", "cdbx-row-aside");
    node.appendChild(aside);
    var toggle = el("button", "cdbx-switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", "false");
    toggle.setAttribute("aria-label", "calm the Cowork glow");
    toggle.disabled = true;
    aside.appendChild(toggle);

    host.appendChild(node);
    panel.appendChild(host);

    api.glowRead().then(function (res) {
      if (failed(res)) {
        stateLine.textContent = "Unavailable: " + reason(res);
        return;
      }
      var pct = Math.round((res.opacity || 0) * 100);
      function describe() {
        return toggle.getAttribute("aria-checked") === "true"
          ? "calm - static at " + pct + "% opacity"
          : "pulsing (claude.ai default)";
      }
      toggle.setAttribute("aria-checked", res.mode === "calm" ? "true" : "false");

      // A hand-edited .jsonc wins the startup merge, so the switch must not
      // pretend it can override it.
      if (res.lockedByJsonc) {
        toggle.title = "Edit claude-desktop-bin.jsonc to change this";
        stateLine.textContent = describe() + " - set in claude-desktop-bin.jsonc";
        return;
      }

      toggle.disabled = false;
      stateLine.textContent = describe();
      toggle.addEventListener("click", function () {
        if (toggle.disabled) return;
        var next = toggle.getAttribute("aria-checked") !== "true";
        toggle.disabled = true;
        api.glowSet(next ? "calm" : "pulse").then(function (r) {
          toggle.disabled = false;
          if (failed(r)) { toast("Could not change the glow: " + reason(r), true); return; }
          toggle.setAttribute("aria-checked", next ? "true" : "false");
          stateLine.textContent = describe();
          node.classList.add("cdbx-flash");
          setTimeout(function () { node.classList.remove("cdbx-flash"); }, 700);
          toast(next
            ? "Cowork glow calmed in " + r.windows + " window(s)"
            : "Cowork glow restored to pulsing");
        }, function (err) {
          toggle.disabled = false;
          toast("Could not change the glow: " + (err && err.message ? err.message : String(err)), true);
        });
      });
    }, function (err) {
      stateLine.textContent = "Unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  function renderThemes(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Themes"));
    panel.appendChild(el("div", "cdbx-sub",
      "Every theme this build knows about: built-ins, the bundled community palettes and your own. " +
      "Colors apply live in every window; a theme's custom spinner shape needs a restart."));

    var status = el("div", "cdbx-empty", "Loading themes...");
    panel.appendChild(status);

    api.themesList().then(function (result) {
      if (failed(result)) {
        status.className = "cdbx-error";
        status.textContent = "Themes are unavailable: " + reason(result);
        return;
      }
      status.remove();

      var search = el("input", "cdbx-search");
      search.type = "search";
      search.placeholder = "Filter " + result.entries.length + " themes";
      panel.appendChild(search);

      var host = el("div", "cdbx-sections");
      panel.appendChild(host);

      if (result.configPath) {
        panel.appendChild(el("div", "cdbx-path", "Saved to " + result.configPath));
      }

      var active = result.active || null;

      function card(entry) {
        var node = el("button", "cdbx-card" + (entry.name === active ? " cdbx-on" : ""));
        node.type = "button";

        var dots = el("div", "cdbx-dots");
        (entry.light || []).forEach(function (color) {
          var dot = el("span", "cdbx-dot");
          dot.style.background = color;
          dots.appendChild(dot);
        });
        if ((entry.light || []).length && (entry.dark || []).length) {
          dots.appendChild(el("span", "cdbx-dots-sep"));
        }
        (entry.dark || []).forEach(function (color) {
          var dot = el("span", "cdbx-dot");
          dot.style.background = color;
          dots.appendChild(dot);
        });
        node.appendChild(dots);
        node.appendChild(el("div", "cdbx-cardname", entry.displayName));
        node.appendChild(el("div", "cdbx-badge",
          entry.source + (entry.name === active ? " - active" : "")));

        node.addEventListener("click", function () {
          api.themesApply(entry.name).then(function (res) {
            if (failed(res)) {
              toast("Could not apply " + entry.displayName + ": " + reason(res), true);
              return;
            }
            active = entry.name;
            draw(search.value);
            toast("Applied " + entry.displayName + " - saved to " + (res.saved || "the config file"));
          }, function (err) {
            toast("Could not apply " + entry.displayName + ": " + (err && err.message ? err.message : String(err)), true);
          });
        });
        return node;
      }

      // One pass per keystroke: bucket the matching entries, then render the
      // sections that have any. The filter searches every section at once and a
      // section whose matches are all filtered out disappears with its heading.
      function draw(filter) {
        clear(host);
        var needle = (filter || "").trim().toLowerCase();
        var buckets = {};
        var shown = 0;
        result.entries.forEach(function (entry) {
          if (needle &&
              (entry.displayName || "").toLowerCase().indexOf(needle) < 0 &&
              (entry.name || "").toLowerCase().indexOf(needle) < 0 &&
              (entry.category || "").toLowerCase().indexOf(needle) < 0) return;
          var key = themeBucket(entry);
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(entry);
          shown++;
        });

        THEME_SECTIONS.forEach(function (section) {
          var list = buckets[section.key];
          if (!list || !list.length) return;
          list.sort(function (a, b) {
            var an = themeName(a), bn = themeName(b);
            return an < bn ? -1 : an > bn ? 1 : 0;
          });
          var head = el("div", "cdbx-sec-h");
          head.appendChild(el("span", "cdbx-sec-t", section.label));
          head.appendChild(el("span", "cdbx-sec-n", String(list.length)));
          host.appendChild(head);
          var grid = el("div", "cdbx-grid");
          list.forEach(function (entry) { grid.appendChild(card(entry)); });
          host.appendChild(grid);
        });

        if (!shown) host.appendChild(el("div", "cdbx-empty", "No theme matches that filter."));
      }

      search.addEventListener("input", function () { draw(search.value); });
      draw("");
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "Themes are unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  // --- features panel ------------------------------------------------------

  function renderFeatures(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Features"));

    // Ours, and it applies live - so it goes above the GrowthBook description
    // and the restart notice, both of which only speak for the flag list.
    renderGlowRow(panel);

    panel.appendChild(el("div", "cdbx-sub",
      "Anthropic's GrowthBook feature flags, as observed being read by this build. " +
      "Flags already on for your account are switched on below; turning one off writes an explicit override."));

    var notice = el("div", "cdbx-notice");
    notice.appendChild(el("div", "cdbx-notice-title", "Changes here require a restart of Claude Desktop"));
    notice.appendChild(el("div", "cdbx-notice-body",
      "Overrides are saved immediately, but most flags are read once at startup. " +
      "Quitting Claude Desktop and reopening it from your desktop launcher is the cleanest way: " +
      "\"Restart now\" relaunches the app directly and so skips the launcher's systemd scope and environment."));
    var restart = el("button", "cdbx-btn", "Restart now");
    restart.type = "button";
    restart.addEventListener("click", function () {
      restart.disabled = true;
      restart.textContent = "Restarting...";
      api.appRelaunch().then(function (res) {
        if (failed(res)) {
          restart.disabled = false;
          restart.textContent = "Restart now";
          toast("Could not restart: " + reason(res), true);
        }
      }, function (err) {
        restart.disabled = false;
        restart.textContent = "Restart now";
        toast("Could not restart: " + (err && err.message ? err.message : String(err)), true);
      });
    });
    notice.appendChild(restart);
    panel.appendChild(notice);

    var status = el("div", "cdbx-empty", "Loading flags...");
    panel.appendChild(status);

    Promise.all([api.flagsCatalog(), api.flagsRead()]).then(function (both) {
      var catalog = both[0];
      var state = both[1];
      if (failed(catalog)) {
        status.className = "cdbx-error";
        status.textContent = "The flag catalog is unavailable: " + reason(catalog);
        return;
      }
      if (failed(state)) {
        status.className = "cdbx-error";
        status.textContent = "Flag state is unavailable: " + reason(state);
        return;
      }
      status.remove();

      var search = el("input", "cdbx-search");
      search.type = "search";
      search.placeholder = "Filter " + catalog.entries.length + " flags by id or description";
      panel.appendChild(search);

      var list = el("div", "cdbx-list");
      panel.appendChild(list);

      var paths = state.paths || {};
      var pathLine = el("div", "cdbx-path");
      pathLine.textContent = "Overrides are written to " + (paths.json || "claude-desktop-extra.json") +
        (paths.jsonc ? "  |  hand-edited entries in " + paths.jsonc + " win over this page" : "");
      panel.appendChild(pathLine);
      if (!state.storeSeen) {
        panel.appendChild(el("div", "cdbx-path",
          "The feature store has not loaded yet in this session, so the switches below show your saved overrides only."));
      }

      var server = state.server || {};
      var effective = state.effective || {};
      var overrides = state.overridesJson || {};
      var jsoncIds = state.overridesJsonc || {};
      var builtins = state.builtins || {};

      // Pre-toggle state: what the app is actually going to see. The effective
      // map is the server payload with every override already merged, so it is
      // the truth when the store has loaded; before that, fall back to the saved
      // override files.
      function isOn(id) {
        var entry = effective[id] || server[id];
        if (entry) return entry.on === true;
        if (Object.prototype.hasOwnProperty.call(jsoncIds, id)) return jsoncIds[id] === true;
        if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] === true;
        if (Object.prototype.hasOwnProperty.call(builtins, id)) return builtins[id] === true;
        return false;
      }

      function origin(id) {
        if (Object.prototype.hasOwnProperty.call(jsoncIds, id)) return "set in claude-desktop-extra.jsonc";
        if (Object.prototype.hasOwnProperty.call(overrides, id)) return "your override (" + JSON.stringify(overrides[id]) + ")";
        if (Object.prototype.hasOwnProperty.call(builtins, id)) return "forced on by claude-desktop-extra for Linux";
        var entry = server[id];
        if (entry) return entry.on === true ? "on for your account" : "off for your account";
        return "not in your account's flag payload";
      }

      function row(entry) {
        var id = entry.id;
        var node = el("div", "cdbx-row");
        var main = el("div", "cdbx-row-main");
        main.appendChild(el("div", "cdbx-id", id));
        if (entry.note) main.appendChild(el("div", "cdbx-note" + (entry.warn ? " cdbx-warn" : ""), entry.note));
        var stateLine = el("div", "cdbx-state", origin(id));
        main.appendChild(stateLine);
        node.appendChild(main);

        var aside = el("div", "cdbx-row-aside");
        node.appendChild(aside);

        function flash() {
          node.classList.add("cdbx-flash");
          setTimeout(function () { node.classList.remove("cdbx-flash"); }, 700);
        }

        // Value-carrying flags are never switches: a bare true would replace a
        // server-provided number/string/object with something meaningless.
        if (entry.valueFlag) {
          var current = effective[id] || server[id];
          var text = current && current.value !== undefined
            ? JSON.stringify(current.value)
            : "not set";
          var chip = el("div", "cdbx-value", text);
          chip.title = text;
          aside.appendChild(chip);
          stateLine.textContent = origin(id) + " - value flag, read-only here";
          return node;
        }

        var lockedJsonc = Object.prototype.hasOwnProperty.call(jsoncIds, id);
        var toggle = el("button", "cdbx-switch");
        toggle.type = "button";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", isOn(id) ? "true" : "false");
        toggle.setAttribute("aria-label", "feature flag " + id);

        if (entry.warn) {
          toggle.disabled = true;
          toggle.title = entry.note;
          stateLine.textContent = origin(id) + " - locked by claude-desktop-extra";
        } else if (lockedJsonc) {
          toggle.disabled = true;
          toggle.title = "Edit claude-desktop-extra.jsonc to change this flag";
        }

        var clearBtn = null;
        function syncClear() {
          var has = Object.prototype.hasOwnProperty.call(overrides, id);
          if (has && !clearBtn) {
            clearBtn = el("button", "cdbx-clear", "clear");
            clearBtn.type = "button";
            clearBtn.title = "Remove this override and follow your account again";
            clearBtn.addEventListener("click", function () {
              api.flagsUnset(id).then(function (res) {
                if (failed(res)) { toast("Could not clear " + id + ": " + reason(res), true); return; }
                delete overrides[id];
                if (effective[id]) delete effective[id];
                toggle.setAttribute("aria-checked", isOn(id) ? "true" : "false");
                stateLine.textContent = origin(id);
                syncClear();
                flash();
                toast("Cleared the override for " + id + " - restart to pick it up");
              }, function (err) {
                toast("Could not clear " + id + ": " + (err && err.message ? err.message : String(err)), true);
              });
            });
            aside.insertBefore(clearBtn, toggle);
          } else if (!has && clearBtn) {
            clearBtn.remove();
            clearBtn = null;
          }
        }

        toggle.addEventListener("click", function () {
          if (toggle.disabled) return;
          var next = toggle.getAttribute("aria-checked") !== "true";
          toggle.disabled = true;
          api.flagsSet(id, next).then(function (res) {
            toggle.disabled = false;
            if (failed(res)) { toast("Could not save " + id + ": " + reason(res), true); return; }
            overrides[id] = next;
            effective[id] = { on: next, value: next };
            toggle.setAttribute("aria-checked", next ? "true" : "false");
            stateLine.textContent = origin(id);
            syncClear();
            flash();
            toast(id + " set to " + next + " - saved, restart to pick it up");
          }, function (err) {
            toggle.disabled = false;
            toast("Could not save " + id + ": " + (err && err.message ? err.message : String(err)), true);
          });
        });

        aside.appendChild(toggle);
        syncClear();
        return node;
      }

      // Built-in Linux forces that are not in the catalog still deserve a row -
      // they are flags this package changes for you.
      var entries = catalog.entries.slice();
      var known = {};
      entries.forEach(function (entry) { known[entry.id] = 1; });
      Object.keys(builtins).forEach(function (id) {
        if (known[id]) return;
        entries.push({ id: id, note: "forced on by claude-desktop-extra on Linux", valueFlag: false, warn: "" });
      });

      function draw(filter) {
        clear(list);
        var needle = (filter || "").trim().toLowerCase();
        var shown = 0;
        entries.forEach(function (entry) {
          if (needle && entry.id.indexOf(needle) < 0 &&
              (entry.note || "").toLowerCase().indexOf(needle) < 0) return;
          shown++;
          list.appendChild(row(entry));
        });
        if (!shown) list.appendChild(el("div", "cdbx-empty", "No flag matches that filter."));
      }

      search.addEventListener("input", function () { draw(search.value); });
      draw("");
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "Flags are unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  // --- mounting ------------------------------------------------------------

  // {dialog, container, rowTag, rows, header, list, items, panel, pane,
  //  paneDisplay, selection}. `items` are {cell, control} pairs: the cell is what
  //  the list holds and what is clicked, the control is what carries the look.
  var mounted = null;

  // Give the borrowed selection state back: our item drops what it took and the
  // upstream row that was selected when the user came to Extra gets it back. Both
  // sides are guarded - React may have replaced either node in the meantime.
  function releaseSelection() {
    var s = mounted && mounted.selection;
    if (!s) return;
    mounted.selection = null;
    if (s.fallback) {
      s.item.classList.remove("cdbx-sel-fb");
      return;
    }
    s.add.forEach(function (c) { s.item.classList.remove(c); });
    s.drop.forEach(function (c) { s.item.classList.add(c); });
    s.attrs.forEach(function (a) { s.item.removeAttribute(a.name); });
    if (s.node && s.node.isConnected) {
      s.add.forEach(function (c) { s.node.classList.add(c); });
      s.drop.forEach(function (c) { s.node.classList.remove(c); });
      s.attrs.forEach(function (a) { s.node.setAttribute(a.name, a.value); });
    }
  }

  // Take the real selected look over to our item. The look lives on the row's
  // CONTROL (the button), which is what `item` is here. Without a computable diff
  // we do NOT invent a pill - a subtle outline of our own says "this one" without
  // pretending to be upstream's.
  function selectOurs(item) {
    releaseSelection();
    if (!mounted) return;
    // Re-scan every group: the row selected right now may well live in a group
    // other than the one findNav measured, and React may have replaced nodes.
    var rows = mounted.rows;
    if (mounted.container && mounted.container.isConnected) {
      var wide = selectionRows(mounted.container, mounted.rowTag);
      if (wide.length < 2) wide = selectionRows(mounted.container, null);
      if (wide.length >= rows.length) rows = wide;
    }
    var hit = findSelected(rows);
    if (!hit || (!hit.add.length && !hit.drop.length && !hit.attrs.length)) {
      diag("no-seldiff", "[ExtraSettings] no selected-row class diff could be computed in this nav - " +
        "Extra marks its active item with its own outline");
      item.classList.add("cdbx-sel-fb");
      mounted.selection = { fallback: true, item: item };
      return;
    }
    hit.add.forEach(function (c) { item.classList.add(c); hit.node.classList.remove(c); });
    hit.drop.forEach(function (c) { item.classList.remove(c); hit.node.classList.add(c); });
    hit.attrs.forEach(function (a) { item.setAttribute(a.name, a.value); hit.node.removeAttribute(a.name); });
    mounted.selection = {
      fallback: false, item: item, node: hit.node,
      add: hit.add, drop: hit.drop, attrs: hit.attrs
    };
  }

  function restoreUpstream() {
    if (!mounted) return;
    if (mounted.panel) mounted.panel.remove();
    if (mounted.pane && mounted.pane.isConnected) {
      mounted.pane.style.display = mounted.paneDisplay;
    }
    mounted.panel = null;
    mounted.pane = null;
    releaseSelection();
  }

  function show(kind, item) {
    if (!mounted) return;
    var pane = mounted.panel
      ? mounted.pane
      : findPane(mounted.dialog, mounted.container, mounted.rows);
    if (!pane) {
      diag("no-pane", "[ExtraSettings] found the settings nav but no content pane to take over - Extra is inert in this modal");
      toast("This settings dialog has an unexpected layout - use Ctrl+Shift+T for themes.", true);
      return;
    }
    if (!mounted.panel) {
      mounted.pane = pane;
      mounted.paneDisplay = pane.style.display;
      pane.style.display = "none";
      mounted.panel = el("div", "cdbx-panel");
      pane.parentElement.insertBefore(mounted.panel, pane.nextSibling);
    }
    selectOurs(item.control);
    if (kind === "themes") renderThemes(mounted.panel);
    else renderFeatures(mounted.panel);
    mounted.panel.scrollTop = 0;
  }

  function install(dialog) {
    var found = findNav(dialog);
    if (!found.ok) {
      // Silent for dialogs that were never the settings modal (confirmations,
      // share sheets); one line only when it did look like settings.
      if (found.leaves > 0) {
        diag("no-nav", "[ExtraSettings] a dialog with " + found.leaves +
          " settings-like nav labels appeared but only " + (found.rows || 0) +
          " of them resolved to a nav row, so no container could be identified - " +
          "Extra not added; refit against baseline/SETTINGS_NAV_CAPTURE.md");
      }
      return false;
    }
    var container = found.container;

    // A previous mount may have left orphans behind if React recycled the
    // container without our items' listeners.
    var stale = dialog.querySelectorAll(".cdbx-group,.cdbx-item");
    for (var s = 0; s < stale.length; s++) stale[s].remove();

    var rowTag = majorTag(found.rows);
    var selected = findSelected(selectionRows(container, rowTag));
    var anchor = findAnchor(container);
    // The group's own list, so header and rows come from the SAME group; the
    // biggest list is the fallback when that group has none (the bare-link shape).
    var list = anchor && isList(anchor.header.nextElementSibling)
      ? anchor.header.nextElementSibling
      : found.primaryList;
    var template = pickTemplate(list, found.rows, selected && selected.node);
    if (!template) {
      diag("no-template", "[ExtraSettings] the settings nav offers no row to clone - Extra not added");
      return false;
    }
    shapeDiag(container, anchor, list, template, found.rows.length);

    // PRIMARY: two siblings before the anchor header, exactly as upstream lays
    // its own groups out. Both must live at the container's level or the pair
    // would end up split.
    var built = null;
    if (anchor && list &&
        anchor.header.parentElement === container && list.parentElement === container) {
      built = buildGroup(anchor, list, template);
      container.insertBefore(built.header, anchor.header);
      container.insertBefore(built.list, anchor.header);
    } else {
      diag("fabricated", "[ExtraSettings] no group header to insert next to (" +
        (anchor ? "its list is not a sibling of the header" : "no known group header text in the nav") +
        ") - Extra appends its rows behind a divider instead");
      built = fabricateGroup(container, lastList(container), template);
    }

    var items = built.items;

    mounted = {
      dialog: dialog,
      container: container,
      rowTag: rowTag,
      rows: found.rows,
      header: built.header,
      list: built.list,
      items: items,
      panel: null,
      pane: null,
      paneDisplay: "",
      selection: null
    };

    bindItem(items[0], "themes");
    bindItem(items[1], "features");

    // Any click on an upstream nav row hands the pane and the selected look back.
    // Capture phase, so upstream's own handler still runs and renders into the
    // restored pane. The listener sits on the container - the level our header and
    // list live at - so rows of every group are covered.
    container.addEventListener("click", function (ev) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].cell.contains(ev.target)) return;
      }
      restoreUpstream();
    }, true);

    diag("installed", "[ExtraSettings] Extra nav group added to the settings dialog (" +
      found.rows.length + " upstream nav rows, " +
      (built.fallback ? "appended behind a divider" : "cloned from the \"" + built.label + "\" group") + ")");
    return true;
  }

  // Our rows are clones, so they carry no React handler: these are the only ones.
  // A cloned <button> activates on Enter and Space by itself; anything else needs
  // the key handler, and would fire twice if a button had one too.
  function bindItem(item, kind) {
    item.cell.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      show(kind, item);
    });
    if (item.control.tagName === "BUTTON") return;
    item.control.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      show(kind, item);
    });
  }

  // One line, once per page: the structure we anchored on, for the next refit.
  // Which anchors were found matters as much as their shape - "hdr=-" is the
  // signature of upstream having renamed or restructured its group headers.
  function shapeDiag(container, anchor, list, template, rowCount) {
    diag("shape", ("[ExtraSettings] nav shape rows=" + rowCount +
      " box=" + shapeOf(container, 1) +
      " hdr[" + (anchor ? anchor.label : "-") + "]=" + (anchor ? shapeOf(anchor.header, 1) : "-") +
      " list=" + (list ? shapeOf(list, 1) : "-") +
      " item=" + shapeOf(template, 3) +
      " icon=" + (template.querySelector(ICON_SEL) ? "box" :
        template.querySelector("svg") ? "svg" : "none")).slice(0, 290));
  }

  function attached() {
    return !!(mounted && mounted.header.isConnected && mounted.items[0].cell.isConnected &&
      (!mounted.list || mounted.list.isConnected));
  }

  function scan() {
    if (attached()) return;
    // Our nav items are gone but a previous mount may still be live: if the SPA
    // re-rendered the nav while our panel was open, hand the pane back before
    // forgetting about it, or it stays display:none with an orphan panel next to
    // it and the modal looks broken.
    if (mounted) {
      restoreUpstream();
      mounted = null;
    }
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      if (install(dialogs[i])) return;
    }
  }

  // Never swallow a scan error silently - a broken scan is exactly the failure
  // that must show up in the log instead of a mysteriously missing nav item.
  function safeScan() {
    try {
      scan();
    } catch (e) {
      diag("scan-error", "[ExtraSettings] settings-dialog scan failed: " + ((e && e.message) || String(e)));
    }
  }

  // One persistent observer covers modal open/close and SPA route changes; a
  // real reload re-fires dom-ready and re-runs this script from scratch.
  var pending = null;
  var observer = new MutationObserver(function (records) {
    if (pending) return;
    // Element insertions only: chat streaming mutates text constantly and a
    // scan per keystroke would be wasteful.
    var relevant = false;
    for (var i = 0; i < records.length && !relevant; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) { relevant = true; break; }
      }
    }
    if (!relevant) return;
    pending = setTimeout(function () { pending = null; safeScan(); }, 80);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  safeScan();

  return "extra-settings: installed, watching for the settings dialog";
})();
