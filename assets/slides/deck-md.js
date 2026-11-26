/* deck-md.js -- the inside of deck-md.html: renders Markdown slides with
 * Marp Core (vendor/marp-core-4.4.0.js) and reports them to the viewer
 * through deck-bridge.js, like any HTML deck.
 *
 * The page runs in an iframe with sandbox="allow-scripts allow-popups
 * allow-popups-to-escape-sandbox": its origin is opaque, so whatever the
 * Markdown contains cannot touch the site, its storage or the viewer.  The
 * viewer (deck-html.js) fetches the Markdown and the themes and posts them:
 *
 *   deck -> viewer  {ns: 'wi-deck', type: 'want'}       (once loaded)
 *   viewer -> deck  {ns: 'wi-deck', type: 'source', markdown, themes: [css, …], base}
 *   deck -> viewer  {ns: 'wi-deck', type: 'error', message}
 *
 * then ready/state/key as usual (deck-bridge.js).  A new `source` (the note
 * was edited) re-renders and keeps the position; WiDeck.refresh() reports
 * the new structure.
 *
 * One <svg> per slide (Marp's inlineSVG mode scales the 1280×720 slide to
 * the frame); only the current one is visible.  Build steps: list items
 * marked as fragments (Marp: `*` bullets; md.js turns HackMD's fragment
 * markers into those).  Slides whose content is too tall are shrunk as far
 * as needed: the largest font size that fits (down to 20 %), then, for
 * content of fixed size, zoomed as well; only what does not fit even so is
 * reported as overfull.  `typographer` (HackMD notes): -- → –, "…" → “…”, ... → ….
 *
 *   viewer -> deck  source also carries {typographer}
 *   viewer -> deck  {ns: 'wi-deck', type: 'fonts', faces: [{family, style, weight,
 *                   unicodeRange, data}]}   before a source with a new theme
 *                   (the frame cannot load the site's fonts itself where the
 *                   server does not allow other sites: jekyll serve)
 */
(function () {
	'use strict';
	const NS = 'wi-deck';
	const deckEl = document.getElementById('deck');
	const msgEl = document.getElementById('msg');
	const { Marp, browser } = window.WiMarp;

	// Marp's HTML allowlist, plus <img style="width: …"> (HackMD notes use it
	// to size images): only sizes survive.
	const SIZE = /^\s*(width|height|max-width|max-height|min-width|min-height)\s*:\s*[\d.]+\s*(px|%|em|rem|vw|vh)?\s*$/i;
	const html = Object.assign({}, Marp.html, {
		img: Object.assign({}, Marp.html.img, { style: v => String(v).split(';').filter(d => SIZE.test(d)).join(';') }),
	});

	let marp = null, themeCss = null, slides = [], cur = { slide: 0, step: 0 }, attached = false, polyfill = null;

	function say(text, detail) {
		msgEl.replaceChildren(document.createTextNode(text));
		if (detail) { const c = document.createElement('code'); c.textContent = detail; msgEl.append(c); }
		msgEl.hidden = false;
	}

	function render(markdown, themes, typographer) {
		const key = themes.join('\n') + '|' + !!typographer;
		if (!marp || key !== themeCss) {
			// (typographer: a constructor option; markdown.set() later does not take)
			marp = new Marp({ html, math: 'mathjax', inlineSVG: true, script: false, minifyCSS: false, markdown: { typographer: !!typographer } });
			for (const css of themes) if (css) marp.themeSet.add(css);
			themeCss = key;
		}
		const out = marp.render(markdown);
		let style = document.getElementById('marp-css');
		if (!style) { style = document.createElement('style'); style.id = 'marp-css'; document.head.append(style); }
		style.textContent = out.css;
		deckEl.innerHTML = out.html;
		// links leave the frame (new tab)
		for (const a of deckEl.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
		if (polyfill) polyfill.update(); else polyfill = browser(deckEl);
		const titles = headingTexts(markdown);
		const hs = [...deckEl.querySelectorAll('section[id] :is(h1, h2, h3, h4, h5, h6)')];
		const raw = new Map(hs.length === titles.length ? hs.map((h, i) => [h, titles[i]]) : []);
		slides = [...deckEl.querySelectorAll('svg[data-marpit-svg]')].map(svg => {
			const sec = svg.querySelector('section[id]') || svg.querySelector('section');
			const h = sec.querySelector('h1, h2, h3');
			return {
				svg, sec,
				frags: [...sec.querySelectorAll('[data-marpit-fragment]')],
				steps: (+sec.dataset.marpitFragments || 0) + 1,
				title: h ? (raw.get(h) || h.textContent).replace(/\s+/g, ' ').trim() : '',
				text: sec.textContent.replace(/\s+/g, ' ').trim(),
			};
		});
		for (const s of slides) {
			const cs = getComputedStyle(s.sec);
			if (clash(cs.backgroundColor, cs.color)) s.sec.classList.add('invert');
		}
		fitAll();
		// pictures change the measures once they are there
		for (const s of slides) for (const img of s.sec.querySelectorAll('img')) {
			if (!img.complete) img.addEventListener('load', () => fit(s), { once: true });
		}
		msgEl.hidden = slides.length > 0;
		if (!slides.length) say('This Markdown has no slides.');
	}

	/** A slide's own background (e.g. HackMD's data-background) against the
	 *  theme's text color: too little contrast (WCAG ratio < 2.5) -> the
	 *  theme's `invert` class swaps the text to the other side. */
	function clash(bg, fg) {
		const b = lum(bg), f = lum(fg);
		if (b == null || f == null) return false;
		return (Math.max(b, f) + 0.05) / (Math.min(b, f) + 0.05) < 2.5;
	}
	function lum(c) {
		const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
		if (!m || (m[4] != null && +m[4] < 0.5)) return null;
		const l = [m[1], m[2], m[3]].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
		return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
	}

	/** The headings' Markdown text (math as TeX), in order: MathJax's SVG
	 *  has no text, so "The $2^k$ conjecture" would come out as "The  conjecture". */
	function headingTexts(md) {
		const out = [];
		let fence = null;
		for (const line of md.split('\n')) {
			const f = /^[ \t]*(```+|~~~+)/.exec(line);
			if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
			if (f) { fence = f[1]; continue; }
			const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
			if (m) out.push(plain(m[1]));
		}
		return out;
	}
	function plain(s) {
		return s.replace(/\$\$?([^$]+)\$\$?/g, (_, t) => t
			.replace(/\\(?:l|c)?dots\b/g, '…').replace(/\s*\\(?:leq|le)\b\s*/g, ' ≤ ').replace(/\s*\\(?:geq|ge)\b\s*/g, ' ≥ ')
			.replace(/\\cdot\b/g, '·').replace(/\\times\b/g, '×').replace(/\\infty\b/g, '∞')
			.replace(/\\(?:mathcal|mathrm|mathit|mathbf|text|operatorname)\s*\{([^}]*)\}/g, '$1')
			.replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '').replace(/\\[,;: !]/g, ' '))
			.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
	}

	/** Shrink slides whose content does not fit (all slides are laid out,
	 *  only hidden, so this can measure them all). */
	function fitAll() {
		for (const s of slides) fit(s);
	}
	const MIN_FONT = 0.2, MIN_ZOOM = 0.05;
	function fit(s) {
		const sec = s.sec, kids = [...sec.children];
		sec.style.fontSize = '';
		for (const c of kids) c.style.zoom = '';
		s.overflow = false;
		if (!tooTall(sec)) return;
		const base = parseFloat(getComputedStyle(sec).fontSize) || 34;
		const font = f => { sec.style.fontSize = (base * f).toFixed(2) + 'px'; };
		const zoom = z => { for (const c of kids) c.style.zoom = z.toFixed(3); };
		// the largest scale that fits (bisection, to within 1 %)
		const largest = (set, lo) => {
			let hi = 1;
			while (hi - lo > 0.01) {
				const mid = (lo + hi) / 2;
				set(mid);
				if (tooTall(sec)) hi = mid; else lo = mid;
			}
			set(lo);
		};
		font(MIN_FONT);
		if (!tooTall(sec)) { largest(font, MIN_FONT); return; }
		// fixed sizes (pictures with a width in px, …): zoom the content too
		font(1);
		zoom(MIN_ZOOM);
		if (tooTall(sec)) { zoom(1); s.overflow = true; return; }
		largest(zoom, MIN_ZOOM);
	}
	function tooTall(sec) {
		const r = sec.getBoundingClientRect();
		if (!r.height) return false;
		const scale = r.height / 720, cs = getComputedStyle(sec);
		const avail = 720 - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
		let top = Infinity, bottom = -Infinity;
		for (const c of sec.children) {
			const ccs = getComputedStyle(c);
			if (ccs.position === 'absolute' || ccs.position === 'fixed') continue;
			const cr = c.getBoundingClientRect();
			top = Math.min(top, cr.top - parseFloat(ccs.marginTop) * scale);
			bottom = Math.max(bottom, cr.bottom + parseFloat(ccs.marginBottom) * scale);
			if (cr.right - r.left > r.width + 2 && c.tagName !== 'PRE') return true;
		}
		return bottom > top && (bottom - top) / scale > avail + 1;
	}

	function show(slide, step) {
		cur = { slide, step };
		slides.forEach((s, i) => s.svg.classList.toggle('wi-cur', i === slide));
		const s = slides[slide];
		if (!s) return;
		for (const li of s.frags) li.classList.toggle('wi-shown', +li.dataset.marpitFragment <= step);
	}

	const api = {
		info: () => ({
			title: document.title,
			aspect: [16, 9],
			slides: slides.map((s, i) => ({ id: 's' + (i + 1), title: s.title, steps: s.steps, text: s.text, overflow: s.overflow })),
		}),
		goto(slide, step) { show(slide, step); },
	};

	function post(m) { if (window.parent !== window) window.parent.postMessage(Object.assign({ ns: NS }, m), '*'); }

	window.addEventListener('message', e => {
		const m = e.data;
		if (e.source !== window.parent || !m || m.ns !== NS) return;
		if (m.type === 'fonts') { addFonts(m.faces || []); return; }
		if (m.type !== 'source') return;
		try {
			if (m.title) document.title = m.title;
			setBase(m.base);
			render(String(m.markdown || ''), Array.isArray(m.themes) ? m.themes : [m.theme || ''], m.typographer);
		} catch (err) {
			say('The Markdown could not be turned into slides.', String(err && err.message || err));
			post({ type: 'error', message: String(err && err.message || err) });
			return;
		}
		if (!slides.length) { post({ type: 'error', message: 'no slides' }); return; }
		if (!attached) { attached = true; WiDeck.attach(api); }
		else WiDeck.refresh();
		// fonts change the measures: fit again once they are there
		if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(() => { fitAll(); });
	});

	/** Fonts posted by the viewer; once loaded, the slides are measured again. */
	const fontsAdded = new Set();
	function addFonts(faces) {
		const loads = [];
		for (const f of faces) {
			const key = [f.family, f.style, f.weight, f.unicodeRange].join('|');
			if (fontsAdded.has(key) || !(f.data instanceof ArrayBuffer)) continue;
			fontsAdded.add(key);
			try {
				const face = new FontFace(f.family, f.data, { style: f.style, weight: f.weight, unicodeRange: f.unicodeRange || 'U+0-10FFFF' });
				document.fonts.add(face);
				loads.push(face.load());
			} catch (err) { /* a broken face: the fallbacks stay */ }
		}
		if (loads.length) Promise.allSettled(loads).then(() => { if (slides.length) fitAll(); });
	}

	/** Relative image paths in the Markdown are relative to where it came from. */
	function setBase(href) {
		let b = document.querySelector('base');
		if (!href || !/^https?:\/\//.test(href)) { if (b) b.remove(); return; }
		if (!b) { b = document.createElement('base'); document.head.prepend(b); }
		b.href = href;
	}

	if (window.parent !== window) post({ type: 'want' });
	else say('These slides open in the slide viewer: /slides/?md=…');
})();
