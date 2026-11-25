/* ===========================================================================
   wi-reader.js -- wild-inter.net reader UI for the pdf2htmlEX paper pages.

   Must be loaded synchronously in <head>, AFTER the inline script that creates
   pdf2htmlEX.defaultViewer and before DOMContentLoaded: it switches off the
   viewer's own key and hash handling and replaces them with the ones below.
   Nothing in pdf2htmlEX.min.js is changed; this file only uses its viewer API
   (pages, scale, rescale, scroll_to, navigate_to_dest, load_page).

   Adds: toolbar, help panel (?), footer with a link back to the paper page,
   narrow-screen defaults (contents closed, fit width), Chrome/pdf.js style
   URL anchors (#page=, #zoom=, #view=, #search=, #pagemode=, #nameddest=),
   the PDF's own named destinations as anchors (#section.3, #theorem.1.8,
   #cite.Key; table written into the page by _tools/pdf-reader.py), working
   #[page,"XYZ",x,y,z] links when opened in a new tab, and "load all pages"
   so the browser's Ctrl+F finds text on every page.
   Old #pfN anchors (N = page number in hex) keep working.

   Source: assets/pdf-reader/wi-reader.js (see _tools/README-pdf-reader.md).
   =========================================================================== */
(function () {
  'use strict';

  var V = window.pdf2htmlEX && window.pdf2htmlEX.defaultViewer;
  if (!V || !V.config) return;
  V.config.key_handler = false;        // keys are handled below
  V.config.hashchange_handler = false; // the viewer's handler could not parse %22
  V.config.view_history_handler = false; // back/forward handled below, too

  var NARROW = 1000;      // px; below this the contents panel floats and starts closed
  var KEY_STEP = 0.95;    // zoom step per key press (as in the old viewer)
  var BTN_STEP = 0.9;     // zoom step per toolbar click
  var MIN_SCALE = 0.2, MAX_SCALE = 6;

  var root = document.documentElement;
  root.classList.add('wi-reader');

  var mode = 'auto';      // 'auto' (fit width, at most 100%), 'width', 'page' or 'free'
  var ctm0 = null;        // px per PDF point at scale 1 (from the first loaded page)
  var allState = 0;       // 0 = lazy, 1 = loading, 2 = all pages loaded and shown
  var allWaiting = [];
  var ui = {};
  var outlineItems = [];
  var named = {};         // PDF name -> destination, e.g. "section.3" -> [7,"XYZ",74.4,491.3,null]
  var nameOf = {};        // normalized destination -> preferred name (the table lists best names first)

  function narrow() { return window.innerWidth < NARROW; }
  function $(id) { return document.getElementById(id); }
  function gap() {
    var g = parseFloat(getComputedStyle(root).getPropertyValue('--r-gap'));
    return isFinite(g) ? g : 16;
  }
  function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }
  function curIdx() { return Math.max(0, Math.min(V.pages.length - 1, V.cur_page_idx || 0)); }
  function curPage() { return V.pages[curIdx()]; }

  /* --- where this page belongs ------------------------------------------------
     pdf-reader-fixup.py writes <link rel="up"> (paper page, with its title) and
     <link rel="alternate" type="application/pdf">. Without them, fall back to
     /publications/html/X.pdf.html -> /publications/X and /publications/X.pdf. */
  // read in init(): the script runs in <head>, before <title> and these links are parsed
  var paperHref = null, pdfHref = null, paperTitle = '', docTitle = 'PDF';
  function readMeta() {
    var upLink = document.querySelector('link[rel="up"]');
    var pdfLink = document.querySelector('link[rel="alternate"][type="application/pdf"]');
    var m = location.pathname.match(/^(.*\/)html\/([^\/]+?)\.pdf\.html$/);
    paperHref = upLink ? upLink.getAttribute('href')
      : m ? m[1] + m[2].replace(/-(slides|print|fig\d+)$/, '') : null;
    pdfHref = pdfLink ? pdfLink.getAttribute('href') : m ? m[1] + m[2] + '.pdf' : null;
    paperTitle = (upLink && upLink.getAttribute('title')) || '';
    docTitle = document.title || paperTitle || (m ? m[2] : 'PDF');
    var tbl = document.getElementById('wi-dests');
    if (tbl) {
      try { named = JSON.parse(tbl.textContent) || {}; } catch (e) { named = {}; }
      for (var k in named) if (named.hasOwnProperty(k)) {
        var key = destKey(named[k]);
        if (key && !nameOf.hasOwnProperty(key)) nameOf[key] = k;
      }
    }
  }
  function destKey(d) {
    try { return JSON.stringify(typeof d === 'string' ? JSON.parse(d) : d); } catch (e) { return null; }
  }

  /* --- zoom -------------------------------------------------------------------- */

  function fitWidthScale() {
    var p = curPage();
    return (V.container.clientWidth - 2 * gap()) / p.original_width;
  }
  function fitPageScale() {
    var p = curPage();
    return Math.min((V.container.clientHeight - 2 * gap()) / p.original_height, fitWidthScale());
  }
  function applyMode(scrollToCurrent) {
    var idx = curIdx(), s;
    if (mode === 'width') s = fitWidthScale();
    else if (mode === 'page') s = fitPageScale();
    else if (mode === 'auto') s = Math.min(1, fitWidthScale());
    else return;
    s = clampScale(s);
    if (Math.abs(s - V.scale) > 1e-4) V.rescale(s, false);
    if (scrollToCurrent) scrollToPage(idx);
    update();
  }
  function setMode(m) { mode = m; applyMode(m === 'page'); }
  function zoomBy(f, center) {
    var s = clampScale(V.scale * f);
    mode = 'free';
    V.rescale(s / V.scale, true, center);
    update();
  }
  function setPercent(pct) {  // pct of actual size (96 dpi), as in Chrome's #zoom=
    var c = ctm0 || 1000 / 612;
    mode = 'free';
    V.rescale(clampScale(pct / 75 / c), false);
    update();
  }

  /* --- navigation ------------------------------------------------------------ */

  function scrollToPage(idx) {
    if (idx == null || !V.pages[idx]) return;
    V.scroll_to(idx, [0, -gap()]);
  }
  function idxOfNum(num) { var i = V.page_map[num]; return i == null ? null : i; }

  // navigate_to_dest is only exact when the target page is loaded; if the
  // viewer is already fetching it, it silently drops our callback. So wait.
  function whenLoaded(idx, cb) {
    var t0 = Date.now();
    (function poll() {
      var pg = V.pages[idx];
      if (!pg) return;
      if (pg.loaded) return cb(pg);
      if (!V.pages_loading[idx]) V.load_page(idx, 1);
      if (Date.now() - t0 > 8000) return cb(pg);
      setTimeout(poll, 40);
    })();
  }
  function goDest(dest) {
    var idx = idxOfNum(dest[0]);
    if (idx == null) return;
    scrollToPage(idx);   // coarse jump right away, exact once loaded
    whenLoaded(idx, function () { V.navigate_to_dest(JSON.stringify(dest)); update(); });
  }

  function decodeHash() {
    var raw = location.hash.replace(/^#/, '');
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  // Returns true if the hash meant something to us.
  function applyHash() {
    var h = decodeHash();
    if (!h) return false;

    // 1. pdf2htmlEX destinations: #[7,"XYZ",74.4,491.3,null]
    if (h.charAt(0) === '[') {
      var d;
      try { d = JSON.parse(h); } catch (e) { return false; }
      if (d instanceof Array) { goDest(d); return true; }
      return false;
    }

    // 2. element ids, above all the old #pf1a page anchors
    var el = document.getElementById(h);
    if (el) {
      if (el.classList.contains('pf')) scrollToPage(idxOfNum(parseInt(el.getAttribute('data-page-no'), 16)));
      else el.scrollIntoView();
      return true;
    }

    // 3. the PDF's named destinations: #section.3, #theorem.1.8, #cite.Key
    if (named.hasOwnProperty(h)) { goDest(named[h]); return true; }

    // 4. Chrome / Acrobat / pdf.js open parameters: page=4&zoom=150,72,700 ...
    if (h.indexOf('=') < 0) return false;
    var p = {};
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) p[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
    });
    if (p.nameddest != null && named.hasOwnProperty(p.nameddest)) { goDest(named[p.nameddest]); return true; }
    if (p.pagemode != null) setSidebar(p.pagemode === 'bookmarks' && hasOutline());
    if (p.navpanes != null) setSidebar(p.navpanes !== '0' && hasOutline());
    var n = parseInt(p.page, 10);
    var idx = isFinite(n) ? Math.max(0, Math.min(V.pages.length - 1, n - 1)) : curIdx();
    var z = p.zoom ? p.zoom.split(',') : null;
    var view = p.view ? p.view.split(',') : null;

    whenLoaded(idx, function (pg) {
      if (pg.ctm && !ctm0) ctm0 = pg.ctm[0];
      if (z) {
        var zs = z[0].toLowerCase();
        if (zs === 'page-width') { mode = 'width'; applyMode(false); }
        else if (zs === 'page-fit') { mode = 'page'; applyMode(false); }
        else if (zs === 'auto') { mode = 'auto'; applyMode(false); }
        else if (parseFloat(zs) > 0) setPercent(parseFloat(zs));
      }
      var v = view ? view[0].toLowerCase() : '';
      if (v === 'fit' || v === 'fitb' || v === 'fitv' || v === 'fitbv') { mode = 'page'; applyMode(false); }
      else if (v === 'fith' || v === 'fitbh') { mode = 'width'; applyMode(false); }

      if (z && z.length >= 3 && isFinite(parseFloat(z[1])) && isFinite(parseFloat(z[2])))
        V.navigate_to_dest(JSON.stringify([pg.num, 'XYZ', parseFloat(z[1]), parseFloat(z[2]), null]));
      else if (view && view.length >= 2 && isFinite(parseFloat(view[1])) && (v === 'fith' || v === 'fitbh'))
        V.navigate_to_dest(JSON.stringify([pg.num, 'XYZ', null, parseFloat(view[1]), null]));
      else scrollToPage(idx);
      update();
      if (p.search) findText(p.search.replace(/\+/g, ' ').replace(/^"|"$/g, ''));
    });
    return true;
  }

  // In-document links: the viewer only reacts when the <a> itself is clicked, but
  // the click lands on the transparent box inside it, so the browser just jumped
  // to the page (#pfN). Handle them here: exact target, and the address bar gets
  // a link to that spot -- the PDF's name for it (#theorem.1.8) where it has one,
  // else #[page,"XYZ",x,y,zoom]. Back returns to the exact previous position.
  function onLinkClick(e) {
    var a = e.target.closest && e.target.closest('a[data-dest-detail]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    var dest = a.getAttribute('data-dest-detail'), d;
    try { d = JSON.parse(dest); } catch (err) { return; }
    e.preventDefault();
    e.stopPropagation();
    try {
      // remember where we are (for Back) without changing this entry's URL
      history.replaceState(V.get_current_view_hash(), '', location.href);
      var name = nameOf[destKey(dest)];
      history.pushState(dest, '', '#' + (name ? encodeURI(name) : dest));
    } catch (err) { /* e.g. file:// */ }
    goDest(d);
    if (narrow() && V.outline.contains(a)) setSidebar(false);
  }
  function onPopState(e) {
    if (typeof e.state === 'string') { try { goDest(JSON.parse(e.state)); return; } catch (err) { /* fall through */ } }
    applyHash();
  }

  /* --- load all pages (for the browser's own search) --------------------------- */

  // Fetches the missing pages a few at a time (some servers, e.g. a local
  // jekyll serve, drop requests when all of them come at once), retries a page
  // that failed, and gives up on a page only after three tries.
  var MAX_INFLIGHT = 6, MAX_TRIES = 3, PAGE_TIMEOUT = 15000, STALL = 20000;

  // The viewer only handles a page request that comes back (onload); after a
  // network error it keeps the page marked as "loading" forever, so it never
  // asks again -- the page stays blank, and "load all" waited for it. Watch the
  // page requests and clear that mark, so the page is asked for again.
  (function () {
    var X = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (!X) return;
    var open = X.open, send = X.send;
    X.open = function (m, url) { this.__wiUrl = url; return open.apply(this, arguments); };
    X.send = function () {
      var x = this, url = x.__wiUrl;
      if (url && /\.page$/.test(url)) {
        var failed = function () {
          for (var i = 0; V.pages && i < V.pages.length; i++)
            if (V.pages[i].page.getAttribute('data-page-url') === url) { delete V.pages_loading[i]; break; }
        };
        x.addEventListener('error', failed);
        x.addEventListener('abort', failed);
        x.addEventListener('timeout', failed);
      }
      return send.apply(this, arguments);
    };
  })();
  function loadAll(cb, quiet) {
    if (cb) allWaiting.push(cb);
    if (allState === 2) return flushAll();
    if (allState === 1) return;
    allState = 1;
    setBtnState();
    var N = V.pages.length, tries = [], started = [], lastK = -1, lastProgress = Date.now();
    for (var i = 0; i < N; i++) { tries.push(0); started.push(0); }
    function done(i) { var pg = V.pages[i]; return pg.loaded || !pg.page.getAttribute('data-page-url'); }
    (function poll() {
      var now = Date.now(), k = 0, inflight = 0, i;
      for (i = 0; i < N; i++) {
        if (done(i)) { k++; continue; }
        if (V.pages_loading[i]) {
          // a request that never came back: forget it, so it can be retried
          if (started[i] && now - started[i] > PAGE_TIMEOUT) delete V.pages_loading[i];
          else inflight++;
        }
      }
      for (i = 0; i < N && inflight < MAX_INFLIGHT; i++) {
        if (!done(i) && !V.pages_loading[i] && tries[i] < MAX_TRIES && now - started[i] > 1000) {
          tries[i]++; started[i] = now; inflight++;
          V.load_page(i, 1);
        }
      }
      if (k !== lastK) { lastK = k; lastProgress = now; }
      var hopeless = true;
      for (i = 0; i < N; i++) if (!done(i) && (tries[i] < MAX_TRIES || V.pages_loading[i])) hopeless = false;
      if (k < N && !hopeless && now - lastProgress < STALL) {
        if (!quiet) toast('Loading all pages for search \u2026 ' + k + ' / ' + N, 0);
        return setTimeout(poll, 120);
      }
      // keep every page rendered: the viewer normally hides off-screen pages,
      // and the browser's find does not see hidden text
      var proto = Object.getPrototypeOf(V.pages[0]);
      proto.hide = function () {};
      V.pages.forEach(function (pg) { pg.show(); });
      allState = 2;
      setBtnState();
      var failed = [];
      for (i = 0; i < N; i++) if (!done(i)) failed.push(i);
      failed.forEach(reportFailure);
      if (!quiet) toast(failed.length
        ? 'Could not load page' + (failed.length > 1 ? 's ' : ' ') + failed.map(function (i) { return i + 1; }).join(', ') +
          ' \u2013 search covers the other ' + k + ' pages'
        : 'All ' + N + ' pages loaded \u2013 Ctrl+F now searches the whole document', failed.length ? 8000 : 3500);
      flushAll();
    })();
  }
  // say in the console why a page did not load (the viewer swallows it)
  function reportFailure(i) {
    var url = V.pages[i].page.getAttribute('data-page-url');
    if (!window.fetch || !url) return;
    fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text().then(function (txt) {
        var why = !r.ok ? 'HTTP ' + r.status
          : txt.indexOf('class="pf') < 0 ? 'no page in the file (' + txt.length + ' bytes)'
          : 'the file looks fine; loading it into the page failed';
        console.warn('wi-reader: page ' + (i + 1) + ' (' + url + ') did not load: ' + why);
      });
    }, function (e) { console.warn('wi-reader: page ' + (i + 1) + ' (' + url + ') did not load: ' + e); });
  }
  function flushAll() { var w = allWaiting; allWaiting = []; w.forEach(function (f) { f(); }); }
  function findText(s) {
    if (!s) return;
    loadAll(function () {
      V.container.focus({ preventScroll: true });
      if (window.find && !window.find(s, false, false, true)) toast('“' + s + '” not found', 3000);
    });
  }

  /* --- contents panel ------------------------------------------------------------ */

  function hasOutline() { return !!(V.outline && V.outline.querySelector('a')); }
  function sidebarOpen() { return V.sidebar.classList.contains('opened'); }
  function setSidebar(open) {
    V.sidebar.style.width = '';           // undo inline styles of the old 'o' handler
    V.container.style.left = '';
    V.sidebar.classList.toggle('opened', !!open);
    V.sidebar.classList.toggle('closed', !open);
    if (ui.toc) ui.toc.classList.toggle('on', !!open);
    root.classList.toggle('wi-side-open', !!open);
    if (!narrow()) applyMode(false);       // the page area changed width
    if (open) revealCurrentOutline();
  }
  // the panel's right edge can be dragged; the width is remembered per browser
  var SIDE_KEY = 'wi-reader-side', SIDE_MIN = 180;
  function sideMax() { return Math.max(SIDE_MIN, Math.min(640, window.innerWidth - 420)); }
  function setSideWidth(w, save) {
    if (w == null) root.style.removeProperty('--r-side-user');
    else root.style.setProperty('--r-side-user', Math.round(Math.max(SIDE_MIN, Math.min(sideMax(), w))) + 'px');
    if (save) {
      try {
        if (w == null) localStorage.removeItem(SIDE_KEY);
        else localStorage.setItem(SIDE_KEY, String(Math.round(w)));
      } catch (e) { /* private mode etc. */ }
    }
  }
  function initSplitter() {
    try { var w = parseFloat(localStorage.getItem(SIDE_KEY)); if (w > 0) setSideWidth(w, false); } catch (e) { /* ignore */ }
    var sp = document.createElement('div');
    sp.id = 'wi-split';
    sp.title = 'Drag to resize the contents; double-click for the default width';
    document.body.appendChild(sp);
    var dragging = false, raf = 0, lastX = 0;
    sp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; lastX = e.clientX;
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag'); root.classList.add('wi-dragging');
      e.preventDefault();
    });
    sp.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      lastX = e.clientX;
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; setSideWidth(lastX, false); });
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('drag'); root.classList.remove('wi-dragging');
      setSideWidth(lastX, true);
      applyMode(false);
      refocus();
    }
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
    sp.addEventListener('dblclick', function () { setSideWidth(null, true); applyMode(false); refocus(); });
  }

  function collectOutline() {
    outlineItems = [];
    if (!V.outline) return;
    var as = V.outline.querySelectorAll('a[data-dest-detail]');
    for (var i = 0; i < as.length; i++) {
      try {
        var idx = idxOfNum(JSON.parse(as[i].getAttribute('data-dest-detail'))[0]);
        if (idx != null) outlineItems.push({ a: as[i], idx: idx });
      } catch (e) { /* ignore */ }
    }
  }
  var curOutline = null;
  function markOutline() {
    var c = curIdx(), best = null;
    for (var i = 0; i < outlineItems.length; i++) if (outlineItems[i].idx <= c) best = outlineItems[i].a;
    if (best === curOutline) return;
    if (curOutline) curOutline.classList.remove('wi-cur');
    curOutline = best;
    if (best) { best.classList.add('wi-cur'); if (sidebarOpen()) revealCurrentOutline(); }
  }
  function revealCurrentOutline() {
    if (!curOutline) return;
    var sb = V.sidebar, top = curOutline.offsetTop, h = curOutline.offsetHeight;
    for (var e = curOutline.offsetParent; e && e !== sb; e = e.offsetParent) top += e.offsetTop;
    if (top < sb.scrollTop + 40) sb.scrollTop = Math.max(0, top - 40);
    else if (top + h > sb.scrollTop + sb.clientHeight - 40) sb.scrollTop = top + h - sb.clientHeight + 40;
  }

  /* --- UI ------------------------------------------------------------------------ */

  var ICON = {
    toc:   '<path d="M3 5h2M8 5h9M3 10h2M8 10h9M3 15h2M8 15h9"/>',
    minus: '<path d="M5 10h10"/>',
    plus:  '<path d="M5 10h10M10 5v10"/>',
    fitw:  '<path d="M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3"/>',
    fitp:  '<rect x="5.5" y="2.5" width="9" height="15" rx="1"/><path d="M8 7h4M8 10h4M8 13h4"/>',
    find:  '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5L17 17"/>',
    link:  '<path d="M8.5 11.5l3-3M7.2 9.3l-1.6 1.6a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6M12.8 10.7l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7L9.1 7"/>',
    pdf:   '<path d="M10 3v10M6 9l4 4 4-4M4 16.5h12"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 20 20" aria-hidden="true">' + ICON[name] + '</svg>'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function buildUI() {
    var bar = document.createElement('header');
    bar.id = 'wi-bar';
    bar.innerHTML =
      '<button id="wi-toc" title="Contents (o)" aria-label="Contents">' + svg('toc') + '</button>' +
      (paperHref ? '<a class="wi-title" href="' + esc(paperHref) + '" title="Back to the paper page">' + esc(docTitle) + '</a>'
                 : '<span class="wi-title">' + esc(docTitle) + '</span>') +
      '<span class="wi-grp wi-page"><input id="wi-pageno" type="text" inputmode="numeric" aria-label="Page" title="Go to page (g)"> / <span id="wi-pages"></span></span>' +
      '<span class="wi-sep"></span>' +
      '<span class="wi-grp">' +
        '<button id="wi-zout" title="Zoom out (−)" aria-label="Zoom out">' + svg('minus') + '</button>' +
        '<span id="wi-zoom" class="wi-zoom" title="Default size (0)"></span>' +
        '<button id="wi-zin" title="Zoom in (+)" aria-label="Zoom in">' + svg('plus') + '</button>' +
      '</span>' +
      '<span class="wi-grp wi-wide">' +
        '<button id="wi-fitw" title="Fit width (f)" aria-label="Fit width">' + svg('fitw') + '</button>' +
        '<button id="wi-fitp" title="Fit page (p)" aria-label="Fit page">' + svg('fitp') + '</button>' +
      '</span>' +
      '<span class="wi-sep wi-wide"></span>' +
      '<span class="wi-grp wi-wide">' +
        '<button id="wi-all" title="Load all pages, so that Ctrl+F searches everything">' + svg('find') + '</button>' +
        '<button id="wi-link" title="Copy a link to this page" aria-label="Copy link to this page">' + svg('link') + '</button>' +
        (pdfHref ? '<a class="wi-btn" id="wi-pdf" href="' + esc(pdfHref) + '" title="Download the PDF" aria-label="Download the PDF">' + svg('pdf') + '</a>' : '') +
      '</span>' +
      '<button id="wi-helpbtn" title="Help and keyboard shortcuts (?)" aria-label="Help">?</button>';
    document.body.insertBefore(bar, document.body.firstChild);

    var head = document.createElement('div');
    head.className = 'wi-side-head';
    head.textContent = 'Contents';
    V.sidebar.insertBefore(head, V.sidebar.firstChild);

    var foot = document.createElement('footer');
    foot.className = 'wi-foot';
    foot.innerHTML =
      '<div class="wi-foot-title">' + esc(docTitle) + '</div>' +
      (paperHref ? '<a href="' + esc(paperHref) + '">← Back to the paper page</a><span class="wi-dot">·</span>' : '') +
      (pdfHref ? '<a href="' + esc(pdfHref) + '">Download the PDF</a><span class="wi-dot">·</span>' : '') +
      '<a href="/">wild-inter.net</a>';
    V.container.appendChild(foot);

    var help = document.createElement('div');
    help.id = 'wi-help';
    help.setAttribute('role', 'dialog');
    help.setAttribute('aria-label', 'Help');
    help.innerHTML =
      '<div class="wi-card">' +
      '<button class="wi-close" aria-label="Close">×</button>' +
      '<h2>Reading this document</h2>' +
      '<h3 class="wi-keys-only">Keyboard</h3>' +
      '<table class="wi-keys-only">' +
      row('<kbd>o</kbd>', 'show / hide the contents') +
      row('<kbd>g</kbd>', 'go to page') +
      row('<kbd>PgDn</kbd> <kbd>PgUp</kbd>', 'one screen down / up') +
      row('<kbd>Alt</kbd>+<kbd>PgDn</kbd> <kbd>PgUp</kbd>', 'next / previous page') +
      row('<kbd>Home</kbd> <kbd>End</kbd>', 'beginning / end') +
      row('<kbd>+</kbd> <kbd>−</kbd>', 'zoom in / out') +
      row('<kbd>Ctrl</kbd>+wheel', 'zoom around the mouse pointer') +
      row('<kbd>0</kbd>', 'default size') +
      row('<kbd>f</kbd>', 'fit width') +
      row('<kbd>p</kbd>', 'fit whole page') +
      row('<kbd>Ctrl</kbd>+<kbd>F</kbd>', 'search; loads all pages first') +
      row('<kbd>?</kbd>', 'this help; <kbd>Esc</kbd> closes it') +
      '</table>' +
      '<h3>Links into this document</h3>' +
      '<table>' +
      row('<code>#page=7</code>', 'page 7') +
      row('<code>#page=7&amp;zoom=150</code>', 'page 7 at 150 %') +
      row('<code>#view=FitH</code>', 'fit width') +
      row('<code>#search=word</code>', 'find a word') +
      (Object.keys(named).length ? row('<code>#theorem.2.1</code>', 'the PDF\u2019s own names: <code>section.3</code>, <code>figure.caption.2</code>, <code>cite.Key</code>, \u2026') : '') +
      '</table>' +
      '<p style="margin:8px 0 0">After following a reference or a contents entry, the address bar holds a link to exactly that spot.</p>' +
      '<div class="wi-actions">' +
      '<button id="wi-h-all">Load all pages for search</button>' +
      '<button id="wi-h-link">Copy link to this page</button>' +
      (pdfHref ? '<a href="' + esc(pdfHref) + '">Download the PDF</a>' : '') +
      (paperHref ? '<a href="' + esc(paperHref) + '">Back to the paper page</a>' : '') +
      '</div></div>';
    document.body.appendChild(help);

    var t = document.createElement('div');
    t.id = 'wi-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);

    ui = {
      bar: bar, help: help, toast: t, toc: $('wi-toc'), pageno: $('wi-pageno'), pages: $('wi-pages'),
      zoom: $('wi-zoom'), all: $('wi-all'), hall: $('wi-h-all')
    };
    ui.pages.textContent = V.pages.length;
    if (!hasOutline()) ui.toc.disabled = true;

    function click(id, f) { var e = $(id); if (e) e.addEventListener('click', function (ev) { f(ev); refocus(); }); }
    click('wi-toc', function () { setSidebar(!sidebarOpen()); });
    click('wi-zout', function () { zoomBy(BTN_STEP); });
    click('wi-zin', function () { zoomBy(1 / BTN_STEP); });
    click('wi-zoom', function () { setMode('auto'); });
    click('wi-fitw', function () { setMode('width'); });
    click('wi-fitp', function () { setMode('page'); });
    click('wi-all', function () { loadAll(); });
    click('wi-link', copyLink);
    click('wi-helpbtn', function () { showHelp(!help.classList.contains('open')); });
    click('wi-h-all', function () { showHelp(false); loadAll(); });
    click('wi-h-link', function () { showHelp(false); copyLink(); });
    help.addEventListener('click', function (e) {
      if (e.target === help || e.target.classList.contains('wi-close')) { showHelp(false); refocus(); }
    });

    ui.pageno.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var n = parseInt(ui.pageno.value, 10);
        if (isFinite(n)) scrollToPage(Math.max(0, Math.min(V.pages.length - 1, n - 1)));
        refocus(true);
      } else if (e.key === 'Escape') { update(true); refocus(true); }
    });
    ui.pageno.addEventListener('focus', function () { ui.pageno.select(); });
    ui.pageno.addEventListener('blur', function () { update(true); });
  }
  function row(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }

  function setBtnState() {
    if (ui.all) { ui.all.classList.toggle('on', allState === 2); ui.all.disabled = allState === 1; }
    if (ui.hall) ui.hall.disabled = allState !== 0;
  }
  function showHelp(open) { ui.help.classList.toggle('open', !!open); }
  function refocus(force) { if (force || document.activeElement !== ui.pageno) V.container.focus({ preventScroll: true }); }

  var toastTimer = null;
  function toast(msg, ms) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, ms);
  }
  function copyLink() {
    var url = location.href.split('#')[0] + '#page=' + (curIdx() + 1);
    var done = function () { toast('Link to page ' + (curIdx() + 1) + ' copied', 2500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, function () { toast(url, 6000); });
    else toast(url, 6000);
  }

  var pending = false;
  function update(force) {
    if (!ctm0) for (var i = 0; i < V.pages.length; i++) if (V.pages[i].loaded && V.pages[i].ctm) { ctm0 = V.pages[i].ctm[0]; break; }
    if (ui.pageno && (force || document.activeElement !== ui.pageno)) ui.pageno.value = curIdx() + 1;
    if (ui.zoom) ui.zoom.textContent = ctm0 ? Math.round(V.scale * ctm0 * 75) + '%' : Math.round(V.scale * 100) + '%';
    markOutline();
  }
  function queueUpdate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; update(); });
  }

  /* --- keys ---------------------------------------------------------------------- */

  function onKey(e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey, C = V.container, handled = true;

    if (mod && (k === 'f' || k === 'F')) { loadAll(); return; }   // browser's find still opens
    if (ui.help.classList.contains('open')) {
      if (k === 'Escape' || k === '?') { showHelp(false); e.preventDefault(); }
      return;
    }
    switch (k) {
      // zoom keys work with or without Ctrl (Ctrl+/- zooms the paper, not the browser)
      case '+': case '=': if (e.altKey) return; zoomBy(1 / KEY_STEP); break;
      case '-': case '_': if (e.altKey) return; zoomBy(KEY_STEP); break;
      case '0': if (e.altKey) return; setMode('auto'); break;
      case 'PageDown': if (e.altKey) scrollToPage(curIdx() + 1); else C.scrollTop += C.clientHeight; break;
      case 'PageUp':   if (e.altKey) scrollToPage(curIdx() - 1); else C.scrollTop -= C.clientHeight; break;
      case 'Home': if (mod) return; C.scrollTop = 0; break;
      case 'End':  if (mod) return; C.scrollTop = C.scrollHeight; break;
      case 'Escape':
        if (narrow() && sidebarOpen()) setSidebar(false); else handled = false;
        break;
      default:
        if (mod || e.altKey) return;  // leave Ctrl+P, Ctrl+G, ... to the browser
        switch (k.toLowerCase()) {
          case 'o': if (hasOutline()) setSidebar(!sidebarOpen()); break;
          case 'f': setMode('width'); break;
          case 'p': setMode('page'); break;
          case 'g': ui.pageno.focus(); break;
          case '?': showHelp(true); break;
          default: handled = false;
        }
    }
    if (handled) e.preventDefault();
  }

  /* --- start ---------------------------------------------------------------------- */

  function init() {
    if (!V.container || !V.pages || !V.pages.length) return;
    readMeta();
    buildUI();
    initSplitter();
    collectOutline();

    setSidebar(hasOutline() && !narrow());
    mode = 'auto';
    applyMode(false);

    // repaint the toolbar whenever the viewer re-renders (scroll, page loaded)
    var sr = V.schedule_render;
    V.schedule_render = function (a) { sr.call(V, a); queueUpdate(); };
    V.container.addEventListener('scroll', queueUpdate, { passive: true });

    V.container.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      var r = V.container.getBoundingClientRect();
      var unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002;
      zoomBy(Math.exp(-e.deltaY * unit), [e.clientX - r.left - V.container.clientLeft, e.clientY - r.top - V.container.clientTop]);
    }, { passive: false });

    // narrow screens: tapping the page or picking a section closes the floating panel
    V.container.addEventListener('click', function () { if (narrow() && sidebarOpen()) setSidebar(false); });
    V.outline.addEventListener('click', function (e) {
      if (narrow() && e.target.closest && e.target.closest('a')) setTimeout(function () { setSidebar(false); }, 0);
    });

    window.addEventListener('keydown', onKey, false);
    window.addEventListener('hashchange', applyHash, false);
    window.addEventListener('popstate', onPopState, false);
    V.container.addEventListener('click', onLinkClick, true);
    V.outline.addEventListener('click', onLinkClick, true);

    var wasNarrow = narrow(), rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        var nw = narrow();
        if (nw && !wasNarrow && sidebarOpen()) setSidebar(false);
        wasNarrow = nw;
        applyMode(false);
      }, 120);
    });

    // single-file documents (cv.html: no split pages) are loaded from the start;
    // show every page right away, so the browser's search finds everything
    if (V.pages.every(function (pg) { return pg.loaded; })) loadAll(null, true);

    V.container.tabIndex = -1;
    refocus();
    applyHash();
    update();
    // following a #pfN anchor moves focus to <body>; give it back so arrow keys scroll
    window.addEventListener('load', function () { if (document.activeElement === document.body) refocus(); });
  }

  // The viewer's own DOMContentLoaded handler was registered first, so ours
  // runs after it has found the pages and the outline.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, false);
  else init();
})();
