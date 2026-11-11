/* wi-mathjax.js -- site-wide setup for MathJax 4 on wild-inter.net
 *
 * Load it AFTER the page's own `window.MathJax = {...}` (if there is one) and
 * BEFORE MathJax itself:
 *
 *   <script src="/assets/mathjax/wi-mathjax.js" data-output="svg"></script>
 *   <script defer src="/assets/mathjax/v4/tex-svg.js"></script>
 *
 * or data-output="chtml" with tex-chtml.js (the default if data-output is absent).
 *
 * It merges the following into the page's configuration; page settings win
 * where they conflict, except that font paths always point here (never a CDN).
 *
 *  1. Local files: MathJax and its fonts come from /assets/mathjax/v4.
 *  2. Euler: the mathjax-euler font extension (Latin and Greek letters, digits
 *     and many symbols in Euler) on top of the default NewCM font.
 *  3. Text fonts as with LaTeX's eulervm package: \text{..}, \mathrm{..},
 *     \mathit{..} and operator names (\log, \max, \operatorname{rank}) are set
 *     in the surrounding text font (Pagella), while variables, digits, Greek
 *     and symbols stay Euler.  \text{..} follows italic/bold surroundings like
 *     amsmath's \text does.  Formulas made off-page (MathJax.tex2svg & co.)
 *     use the font of <body>.
 *  4. Startup waits (at most 3 s) until the text fonts are loaded: MathJax
 *     measures each text-font word once and caches the width for the page.
 *
 * Per-page switches (all optional), e.g. window.MathJax = { wi: { operators: false }, ... }
 *   euler       true   load the Euler font extension
 *   textFonts   true   parts 3 and 4 above
 *   operators   true   \log, \max, \operatorname{..} in the text font too
 *   bold        false  \mathbf{..} in bold text font (else: Euler bold)
 *   fontWait    3000   max ms to wait for the text fonts (0: don't wait)
 *
 * It also defines wiTypeset(nodes): (re)typeset elements, queued until MathJax
 * is ready, so pages can call it at any time (the MathJax 4 replacement for
 * MathJax 2's MathJax.Hub.Queue(["Typeset", MathJax.Hub, node])).
 *
 * See _tools/README-mathjax.md.
 */
(function () {
  "use strict";
  var me = document.currentScript;
  var V4 = (me ? me.src.replace(/[^\/]*$/, "") : "/assets/mathjax/") + "v4";

  var cfg = window.MathJax;
  if (cfg && cfg.version) {
    console.warn("wi-mathjax.js must be loaded before MathJax itself; ignored.");
    return;
  }
  cfg = window.MathJax = cfg || {};
  var opt = { euler: true, textFonts: true, operators: true, bold: false, fontWait: 3000 };
  for (var k in cfg.wi || {}) opt[k] = cfg.wi[k];
  delete cfg.wi;

  function sub(o, key) {
    if (!o[key] || typeof o[key] !== "object") o[key] = {};
    return o[key];
  }

  /* ---- 1. local files only ---------------------------------------------- */
  var paths = sub(sub(cfg, "loader"), "paths");
  for (var p in paths) {
    if (/^(https?:)?\/\//.test(paths[p]) && /mathjax/i.test(p + paths[p])) delete paths[p];
  }
  paths.fonts = V4 + "/fonts";
  // the Euler extension 4.1.3 is stamped "4.0.0"; we pin a matching set ourselves
  if (cfg.loader.versionWarnings === undefined) cfg.loader.versionWarnings = false;
  paths["mathjax-euler-extension"] = V4 + "/fonts/mathjax-euler-font-extension";

  /* ---- 2. Euler ------------------------------------------------------------ */
  // The extension comes in an svg and a chtml flavour, which must match the
  // output of the MathJax component the page loads; hence data-output.
  // (output.fontExtensions would avoid this, but in 4.1.3 it breaks the
  // extension's dynamically loaded ranges, e.g. \mathcal.)
  var JAX = (me && me.getAttribute("data-output")) || "chtml";
  if (opt.euler) {
    var load = Array.isArray(cfg.loader.load) ? cfg.loader.load : [];
    if (load.indexOf("[mathjax-euler-extension]/" + JAX) < 0) load.push("[mathjax-euler-extension]/" + JAX);
    cfg.loader.load = load;
  }

  /* ---- 3. text fonts -------------------------------------------------------- */
  var PKG = "wiTextFonts";
  if (opt.textFonts) {
    ["svg", "chtml"].forEach(function (jax) {
      var o = sub(cfg, jax);
      if (o.mtextInheritFont === undefined) o.mtextInheritFont = true;
    });
    var tex = sub(cfg, "tex");
    if (Array.isArray(tex.packages)) {
      if (tex.packages.indexOf(PKG) < 0) tex.packages.push(PKG);
    } else {
      var pk = tex.packages && typeof tex.packages === "object" ? tex.packages : {};
      var plus = Array.isArray(pk["[+]"]) ? pk["[+]"] : [];
      if (plus.indexOf(PKG) < 0) plus.push(PKG);
      pk["[+]"] = plus;
      tex.packages = pk;
    }
  }

  /* Words in Latin letters (no digits: \mathrm{2a} keeps an Euler 2). */
  var WORD = /^[A-Za-z\u00C0-\u024F'\u2019-]+$/;

  /* Font of the text around a formula; <body> for formulas made off-page. */
  function context(math) {
    var n = math && math.start && math.start.node;
    if (n && n.nodeType !== 1) n = n.parentNode;
    if (!n || !n.isConnected) n = document.body;
    var cs = getComputedStyle(n);
    var w = cs.fontWeight;
    return {
      family: cs.fontFamily,
      italic: /italic|oblique/.test(cs.fontStyle),
      bold: w === "bold" || w === "bolder" || parseInt(w, 10) >= 600
    };
  }

  /* TeX postprocessor: point the text-like tokens to the text font.  Tokens
     keep their kind (mi/mo), so TeX spacing and \max_i limits are unchanged. */
  function textFonts(arg) {
    var OP = MathJax._.core.MmlTree.MmlNode.TEXCLASS.OP;
    var ctx = null;
    arg.data.root.walkTree(function (node) {
      if (!node.isToken) return;
      var attr = node.attributes;
      var kind = node.kind;
      if (kind === "mtext") {
        // plain \text{..}: follow italic / bold surroundings, like amsmath
        if (!attr.hasExplicit("mathvariant")) {
          ctx = ctx || context(arg.math);
          if (ctx.italic || ctx.bold)
            attr.set("mathvariant", ctx.bold ? (ctx.italic ? "bold-italic" : "bold") : "italic");
        }
        return;
      }
      if (kind !== "mi" && kind !== "mo") return;
      var text = node.getText();
      if (!WORD.test(text)) return;
      var v = attr.getExplicit("mathvariant");
      var italic = false, bold = false;
      if (v === undefined) {
        // multi-letter, no variant: \mathrm{word} (mi, class ORD) or an operator
        // name (\log, \operatorname{..}: mi of class OP; \max, \lim: mo)
        if (text.length < 2) return;
        var isOp = node.texClass === OP;
        if (isOp ? !opt.operators : kind === "mo") return;
      } else if (v === "normal") {                       // \mathrm{d}
      } else if (v === "italic" || v === "-tex-mathit") { // \mathit{..}
        italic = true;
      } else if (opt.bold && (v === "bold" || v === "bold-italic")) {
        bold = true;
        italic = v === "bold-italic";
      } else {
        return;                                          // \mathbf, \mathsf, \mathbb, ...
      }
      ctx = ctx || context(arg.math);
      attr.unset("mathvariant");
      attr.set("fontfamily", ctx.family);
      attr.set("fontstyle", italic ? "italic" : "normal");
      attr.set("fontweight", bold ? "bold" : "normal");
    });
  }

  var defined = false;
  function defineTextFonts() {
    if (defined) return;
    defined = true;
    var Configuration = MathJax._.input.tex.Configuration.Configuration;
    Configuration.create(PKG, { postprocessors: [textFonts] });
    // fallback text font for formulas typeset off-page (tex2svg etc.)
    var fam = getComputedStyle(document.body).fontFamily;
    ["svg", "chtml"].forEach(function (jax) {
      var o = MathJax.config[jax] || (MathJax.config[jax] = {});
      if (!o.mtextFont) o.mtextFont = fam;
    });
  }

  /* ---- 4. wait for the text fonts, then start ------------------------------ */
  function fontsLoaded() {
    if (!opt.textFonts || !opt.fontWait || !(document.fonts && document.fonts.load))
      return Promise.resolve();
    var fam = getComputedStyle(document.body).fontFamily;
    var all = Promise.all(["", "italic ", "bold ", "italic bold "].map(function (s) {
      return document.fonts.load(s + "16px " + fam, "pairs").catch(function () {});
    }));
    return Promise.race([all, new Promise(function (r) { setTimeout(r, opt.fontWait); })]);
  }

  /* ---- wiTypeset: (re)typeset elements, usable before MathJax is ready ------ */
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });
  var queue = ready;
  /* wiTypeset(nodes) -- nodes: an element, an array/NodeList of them, or nothing
     (= the whole page).  Calls are queued and run once MathJax has started;
     math typeset earlier inside the nodes is cleared first.  Returns a promise. */
  window.wiTypeset = function (nodes) {
    var list = nodes == null ? null : nodes.nodeType ? [nodes] : Array.prototype.slice.call(nodes);
    queue = queue.then(function () {
      if (list) MathJax.typesetClear(list); else MathJax.typesetClear();
      return MathJax.typesetPromise(list || undefined);
    }).catch(function (e) { console.error("wiTypeset:", e); });
    return queue;
  };

  /* MathJax 4.1.3 bug workaround: the Euler extension's SVG ranges loaded on
     demand (\mathcal, \mathfrak, some Greek) call a "generic" SVG font class
     that the SVG component does not provide; the CHTML ones use
     CHTML.genericFont instead.  Point the former to the SVG equivalent. */
  function patchEulerSvg() {
    var out = MathJax._ && MathJax._.output;
    if (!out || !out.svg_ts || !out.fonts) return;
    var g = out.fonts.generic || (out.fonts.generic = {});
    if (!g.svg_ts) g.svg_ts = {
      get GenericFont() { return out.svg_ts.SVG.genericFont; }
    };
  }

  /* MathJax 4.1.3 issues with text-font words (\text, and \mathrm & co. above):
     (a) the width of a word is cached per font, but not per text/math size
         ratio, which differs between the page (measured) and off-page
         formulas (assumed ex = em/2): a word measured in one is mis-spaced in
         the other.  Fix: key the cache also by that ratio.
     (b) CHTML measures an upright word inside the surrounding element, so in
         italic text it measures the italic word.  Fix: measure with explicit
         font-style/weight.  (SVG measures in <body>, so it is unaffected.)
     (c) off-page formulas (tex2svg etc.) assume em = 16px, ex = 8px.  Fix:
         default to the metrics and font of <body>.                      */
  function patchTextMeasuring() {
    var out = MathJax._ && MathJax._.output;
    if (!out) return;
    [out.svg_ts && out.svg_ts.SVG, out.chtml_ts && out.chtml_ts.CHTML].forEach(function (C) {
      if (!C || C.prototype.wiPatched) return;
      C.prototype.wiPatched = true;
      var cached = C.prototype.measureTextNodeWithCache;
      C.prototype.measureTextNodeWithCache = function (text, chars, variant, font) {
        var m = this.math && this.math.metrics;
        return cached.call(this, text, m ? chars + "\u0000" + (m.ex / m.em).toFixed(4) : chars, variant, font);
      };
    });
    var CH = out.chtml_ts && out.chtml_ts.CHTML;
    if (CH && !CH.prototype.wiFontStyles) {
      var css = CH.prototype.wiFontStyles = CH.prototype.cssFontStyles;
      CH.prototype.cssFontStyles = function (font, styles) {
        styles = css.call(this, font, styles);
        if (!font[1]) styles["font-style"] = "normal";
        if (!font[2]) styles["font-weight"] = "normal";
        return styles;
      };
    }
  }
  function patchConvert() {
    var doc = MathJax.startup.document;
    if (!doc || doc.wiConvert) return;
    var convert = doc.wiConvert = doc.convert, metrics = {};
    doc.convert = function (math, options) {
      options = options || {};
      if (options.em == null && options.ex == null && document.body) {
        var d = options.display === false ? 0 : 1;   // MathJax's default is display
        var m = metrics[d] || (metrics[d] = doc.outputJax.getMetricsFor(document.body, !!d));
        var o = { em: m.em, ex: m.ex };
        if (m.family) o.family = m.family;
        for (var k in options) o[k] = options[k];
        options = o;
      }
      return convert.call(this, math, options);
    };
  }

  var startup = sub(cfg, "startup");
  var pageReady = startup.ready;
  startup.ready = function () {
    var self = this;
    patchEulerSvg();
    if (opt.textFonts) { defineTextFonts(); patchTextMeasuring(); }
    fontsLoaded().then(function () {
      var used = MathJax.startup.output && MathJax.startup.output.name.toLowerCase();
      if (opt.euler && used && used !== JAX)
        console.error('wi-mathjax.js: data-output="' + JAX + '" but the page loads ' + used +
                      ' output; Euler will not work. Make them agree.');
      if (pageReady) pageReady.call(self);
      else MathJax.startup.defaultReady();
      if (opt.textFonts) patchConvert();
      MathJax.startup.promise.then(resolveReady, resolveReady);
    }).catch(function (e) { console.error("wi-mathjax.js:", e); });
  };
})();
