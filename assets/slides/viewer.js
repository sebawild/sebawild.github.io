/* viewer.js -- the slide viewer at /slides/ (three modes: embed, tab, present).
 *
 *   /slides/?t=<talk id>#page=12      slides-only tab
 *   /slides/?t=<talk id>&present      present mode
 *   /slides/?t=<talk id>&embed        inside the iframe on talk and paper pages
 *   /slides/?src=/path/on/site.pdf    any PDF of the site
 *
 * Pieces: core.js (pure logic), cache.js (tiers + scheduler), deck-pdf.js
 * (PDF.js).  This file: the page, input, drawing, panels.  See
 * _tools/talks/DEVNOTES-viewer.md; keys and URLs in _tools/talks/README.md.
 */
/** Bump with every delivered change: shown in the HUD and __slidesStats(), so a
 *  stale copy in a cache is easy to spot. */
const VERSION = '2026-11-25.4';

import * as C from './core.js';
import { SlideCache } from './cache.js';
import { PdfDeck } from './deck-pdf.js';
import * as Open from './open.js';
import { HtmlDeck } from './deck-html.js';

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') el.className = v;
		else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'html') el.innerHTML = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
	return el;
};
const ICON = {
	prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
	next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
	toc: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
	search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
	builds: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="13" height="10" rx="1"/><path d="M8 19h12V9"/></svg>',
	full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
	unfull: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
	tab: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>',
	download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
	present: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M12 16v4M8 20h8"/></svg>',
	help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7M12 17.5v.01"/></svg>',
	grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg>',
	close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
};
const icon = name => { const s = h('span', { class: 'sv-ic', 'aria-hidden': 'true' }); s.innerHTML = ICON[name]; return s; };

// ======================================================================== state
const S = {
	opts: C.parseLocation(location.search, location.hash),
	meta: null, deck: null, cache: null,
	count: 0, frames: [], toc: null, page: 1, dir: 1,
	builds: true, mode: 'tab',
	box: { w: 0, h: 0 }, dpr: 1, maxPx: 4096, phone: false,
	zoom: { z: 1, cx: 0.5, cy: 0.5, keep: false },
	shown: null,            // {page, kind, w}
	texts: null, textsLoading: null,
	hits: [], hitIdx: -1, query: '',
	stats: { nav: new C.Stats(400), last: null, served: { A: 0, B: 0, C: 0, cold: 0 } },
	loaded: 0, total: 0,
	ui: {},
	navSeq: 0,
	thumbURL: new Map(),
};
S.mode = S.opts.mode;
S.builds = S.opts.builds;
const el = {};   // DOM references

// ========================================================================= boot
boot().catch(err => fail(err));

async function boot() {
	S.phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
	S.maxPx = S.phone ? 2048 : 4096;
	document.documentElement.classList.add('sv-mode-' + S.mode);
	if (S.phone) document.documentElement.classList.add('sv-phone');
	if (!S.opts.t && !S.opts.src && !S.opts.url && !S.opts.local) {
		// /slides/ without parameters: open any PDF
		document.documentElement.classList.remove('sv-mode-' + S.mode);
		return Open.startScreen(document.getElementById('sv'), h);
	}
	buildShell();
	S.meta = await loadMeta();
	if (S.meta.kind === 'url' || S.meta.kind === 'local') Open.installDrop(el.root, () => S.mode);
	if (S.meta.kind === 'url') Open.rememberUrl(S.meta.source, S.meta.title);
	document.title = (S.meta.title || 'Slides') + (S.mode === 'present' ? ' — present' : ' — slides');
	fillShell();
	countView();
	const tocM = S.meta.toc;
	if (S.meta.thumb) showStartImage(S.meta.thumb, tocM && tocM.aspect);
	if (S.meta.slides.kind === 'html') return bootHtml();
	const deck = await PdfDeck.open(S.meta.slides.url, {
		data: S.meta.local ? new Uint8Array(await S.meta.local.blob.arrayBuffer()) : null,
		onProgress: (l, t) => { S.loaded = l; S.total = t || S.meta.slides.bytes || 0; updateLoad(); },
		sizes: tocM ? { aspect: tocM.aspect, odd: tocM.sizes } : null,
		rendererWorker: new URLSearchParams(location.search).get('worker') !== '0',
		load: new URLSearchParams(location.search).get('load') || 'range',
	});
	S.deck = deck;
	S.count = deck.count;
	if (S.meta.kind) {
		// not a talk: a real title from the PDF beats a file name like 1805.04154
		const info = await deck.doc.getMetadata().then(m => m && m.info, () => null);
		const t = info && typeof info.Title === 'string' ? info.Title.trim() : '';
		if (t.split(/\s+/).length >= 2 && t.length < 200) {
			S.meta.title = t;
			el.title.textContent = t;
			document.title = t + (S.mode === 'present' ? ' — present' : ' — slides');
			if (S.meta.kind === 'url') Open.rememberUrl(S.meta.source, t);
		}
	}
	if (tocM && tocM.pages === deck.count) {
		S.frames = tocM.frames.map(f => ({ ...f }));
		S.toc = C.buildToc(tocM.outline, S.frames);
	} else {
		S.frames = C.framesFromLabels(await deck.labels(), deck.count);
		const ol = (await deck.outline()).map(o => ({ ...o, title: C.cleanTitle(o.raw) }));
		S.toc = C.buildToc(ol, S.frames);
	}
	S.cache = new SlideCache({
		count: S.count,
		aspect: (deck.size(1).h / deck.size(1).w) || 0.5625,
		renderPage: (p, w, signal) => deck.renderPage(p, w, signal),
		widthFor: p => widthFor(p),
		codec: makeCodec(),
		onChange: (what, p) => onCacheChange(what, p),
	});
	measure();
	configureCache();
	buildProgress();
	buildToc();
	const start = C.snap(Math.max(1, Math.min(S.count, S.opts.page || 1)), S.frames, S.builds);
	S.page = start;
	history.replaceState({ page: start }, '', urlFor(start));
	await show(start, { first: true });
	document.documentElement.classList.add('sv-ready');
	installInput();
	installResize();
	if (S.mode === 'present') enterPresent(true);
	setInterval(tick, 500);
}

/** An HTML deck: it runs in an iframe on the stage (deck-html.js); the
 *  viewer keeps its bars, contents, overview, search and modes. */
async function bootHtml() {
	S.html = true;
	document.documentElement.classList.add('sv-html');
	el.frame = h('iframe', { class: 'sv-deckframe', title: S.meta.title || 'Slides', allow: 'fullscreen' });
	el.sheet.append(el.frame);
	measure();
	const deck = await HtmlDeck.open(S.meta.slides.url, el.frame, { page: S.opts.page || 1, mode: S.mode });
	S.deck = deck;
	S.count = deck.count;
	S.frames = deck.frames.map(f => ({ ...f }));
	S.toc = C.buildToc(deck.outline, S.frames);
	if (!S.meta.title && deck.title) { S.meta.title = deck.title; el.title.textContent = deck.title; document.title = deck.title + (S.mode === 'present' ? ' — present' : ' — slides'); }
	deck.keyHandler = m => handleKey({ key: m.key, code: m.code, shiftKey: m.shift, ctrlKey: m.ctrl, altKey: m.alt, metaKey: m.meta, repeat: m.repeat, target: null, preventDefault() {} });
	deck.onState(p => {
		// the deck moved by itself (a click inside it)
		S.page = p;
		history.replaceState({ page: p }, '', urlFor(p));
		updateChrome();
	});
	el.start.hidden = true;
	el.root.classList.add('sv-deck-ready');
	buildProgress();
	buildToc();
	S.page = deck.page;
	const start = C.snap(Math.max(1, Math.min(S.count, deck.page || 1)), S.frames, S.builds);
	await show(start, { first: true });
	history.replaceState({ page: S.page }, '', urlFor(S.page));
	document.documentElement.classList.add('sv-ready');
	installInput();
	installResize();
	if (S.mode === 'present') enterPresent(true);
	setInterval(tick, 500);
	if (S.mode !== 'embed' && S.meta.slides.download) setTimeout(loadHtmlThumbs, 1200);
}

/** Thumbnails of an HTML deck for the overview, search and the bar's preview:
 *  from its PDF (made by talks.py toc; one page per slide, final state). */
async function loadHtmlThumbs() {
	S.htmlThumbs = new Map();
	try {
		const pdf = await PdfDeck.open(S.meta.slides.download, { rendererWorker: true, load: 'range' });
		const n = Math.min(pdf.count, S.frames.length);
		for (let i = 0; i < n; i++) {
			const c = await pdf.renderPage(i + 1, 320);
			const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/webp', quality: 0.8 }) : await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
			S.htmlThumbs.set(i, URL.createObjectURL(blob));
			if (el.overview && !el.overview.hidden) refreshOverviewThumb(S.frames[i].last);
		}
	} catch (e) { /* no thumbnails: titles only */ }
}

async function loadMeta() {
	const o = S.opts;
	if (o.t) {
		if (!/^[a-z][a-z0-9-]*$/.test(o.t)) throw new Error('bad talk id');
		const r = await fetch('/talks/' + o.t + '.json', { cache: 'no-cache' });
		if (!r.ok) throw Object.assign(new Error('unknown talk'), { kind: 'talk' });
		const m = await r.json();
		if (!m.slides || !['pdf', 'html'].includes(m.slides.kind) || !m.slides.url) throw new Error('these slides are neither a PDF nor an HTML deck (not supported yet)');
		m.thumb = '/talks/' + m.id + '.thumb.webp';
		return m;
	}
	if (o.url || o.local) return Open.externalMeta(o);
	if (o.src && /\.html?$/i.test(o.src.split(/[?#]/)[0])) {
		// an HTML deck of this site (with deck-bridge.js)
		let u;
		try { u = new URL(o.src, location.origin); } catch (e) { u = null; }
		if (!u || u.origin !== location.origin) throw Object.assign(new Error('only decks on this site'), { kind: 'talk' });
		return { id: null, title: '', page: null, publications: [], slides: { kind: 'html', url: u.pathname, download: null } };
	}
	const src = C.safeSrc(o.src, location.origin);
	if (!src) throw Object.assign(new Error('no slides given'), { kind: 'talk' });
	const name = decodeURIComponent(src.split('/').pop().replace(/\.pdf$/i, ''));
	return { id: null, title: name, page: null, publications: [], slides: { kind: 'pdf', url: src, download: src } };
}

function fail(err) {
	console.error(err);
	const box = el.msg || document.body;
	if (err && (err.kind === 'cors' || err.kind === 'local' || err.kind === 'url')) {
		const m = h('div', { class: 'sv-error' },
			err.kind === 'cors' ? Open.corsHelp(h, err.url, S.mode) : h('p', {}, String(err.message)),
			err.kind !== 'cors' ? h('p', {}, ...Open.filePicker(h, S.mode, 'Choose a PDF…')) : null,
			h('p', {}, h('a', { href: '/slides/' }, 'Open another PDF'), ' · ', h('a', { href: '/talks/' }, 'All talks')));
		if (el.root) Open.installDrop(el.root, () => S.mode);
		if (el.root) el.root.classList.add('sv-failed');
		if (el.back) { el.back.href = '/slides/'; el.back.hidden = false; el.back.lastChild.textContent = 'Open…'; }
		box.replaceChildren(m);
		box.hidden = false;
		return;
	}
	const m = h('div', { class: 'sv-error' },
		h('p', {}, err && err.kind === 'talk' ? 'These slides could not be found.' : 'The slides could not be loaded.'),
		h('p', { class: 'sv-small' }, String(err && err.message || err)),
		S.meta && S.meta.slides ? h('p', {}, h('a', { href: S.meta.slides.download || S.meta.slides.url }, 'Open the PDF directly')) : null,
		h('p', {}, h('a', { href: '/talks/' }, 'All talks')));
	box.replaceChildren(m);
	box.hidden = false;
}

// ======================================================================== shell
function buildShell() {
	const root = document.getElementById('sv');
	el.root = root;
	const btn = (name, label, action, extra = {}) => {
		const b = h('button', { type: 'button', class: 'sv-btn sv-btn-' + name, title: label, 'aria-label': label, onclick: () => act(action), ...extra }, icon(name), h('span', { class: 'sv-lbl' }, label.replace(/ \(.*\)$/, '')));
		el['b_' + action] = b;
		return b;
	};
	el.back = h('a', { class: 'sv-back', href: '/talks/' }, icon('back'), h('span', { class: 'sv-lbl' }, 'Talk page'));
	el.title = h('div', { class: 'sv-title' });
	el.top = h('header', { class: 'sv-bar sv-top' },
		el.back, el.title, h('div', { class: 'sv-spacer' }),
		btn('toc', 'Contents (T)', 'toc'),
		btn('grid', 'Overview (O)', 'overview'),
		btn('search', 'Search (/)', 'search'),
		btn('builds', 'Hide build steps (U)', 'builds', { 'aria-pressed': 'false' }),
		el.dl = h('a', { class: 'sv-btn sv-btn-download', title: 'Download the PDF', 'aria-label': 'Download the PDF', download: '' }, icon('download'), h('span', { class: 'sv-lbl' }, 'PDF')),
		btn('present', 'Present (M)', 'mode'),
		btn('full', 'Full screen (F)', 'fullscreen'),
		btn('help', 'Keys (?)', 'help'));
	el.canvas = h('canvas', { class: 'sv-canvas', 'aria-hidden': 'true' });
	el.zoomCanvas = h('canvas', { class: 'sv-zoomcanvas', 'aria-hidden': 'true', hidden: true });
	el.start = h('img', { class: 'sv-startimg', alt: '', hidden: true });
	el.text = h('div', { class: 'textLayer sv-text' });
	el.links = h('div', { class: 'sv-links' });
	el.marks = h('div', { class: 'sv-marks' });
	el.sheet = h('div', { class: 'sv-sheet' }, el.start, el.canvas, el.text, el.links, el.marks);
	el.prevZone = h('button', { type: 'button', class: 'sv-zone sv-zone-prev', 'aria-label': 'Previous page', onclick: () => act('prev') }, icon('prev'));
	el.nextZone = h('button', { type: 'button', class: 'sv-zone sv-zone-next', 'aria-label': 'Next page', onclick: () => act('next') }, icon('next'));
	el.msg = h('div', { class: 'sv-msg', hidden: true });
	el.loadbar = h('div', { class: 'sv-loadbar' }, h('div'));
	el.stage = h('main', { class: 'sv-stage', tabindex: '-1' }, el.sheet, el.zoomCanvas, el.prevZone, el.nextZone, el.msg, el.loadbar);
	el.counter = h('button', { type: 'button', class: 'sv-counter', title: 'Go to page (G)', 'aria-label': 'Go to page', onclick: () => act('goto') });
	el.progress = h('div', { class: 'sv-progress', role: 'slider', tabindex: '0', 'aria-label': 'Position in the slides', 'aria-valuemin': '1' });
	el.bottom = h('footer', { class: 'sv-bar sv-bottom' },
		h('button', { type: 'button', class: 'sv-btn sv-btn-prev', title: 'Previous page (←)', 'aria-label': 'Previous page', onclick: () => act('prev') }, icon('prev')),
		el.counter,
		h('button', { type: 'button', class: 'sv-btn sv-btn-next', title: 'Next page (→)', 'aria-label': 'Next page', onclick: () => act('next') }, icon('next')),
		el.progress,
		h('div', { class: 'sv-embedbtns' },
			btn('toc', 'Contents', 'toc'),
			btn('builds', 'Hide build steps', 'builds', { 'aria-pressed': 'false' }),
			el.newtab = h('a', { class: 'sv-btn sv-btn-tab', title: 'Open in a new tab', 'aria-label': 'Open in a new tab', target: '_blank', rel: 'noopener' }, icon('tab'), h('span', { class: 'sv-lbl' }, 'New tab')),
			el.dl2 = h('a', { class: 'sv-btn sv-btn-download', title: 'Download the PDF', 'aria-label': 'Download the PDF', download: '' }, icon('download'), h('span', { class: 'sv-lbl' }, 'PDF')),
			btn('full', 'Full screen', 'fullscreen')));
	el.tocPanel = h('aside', { class: 'sv-panel sv-tocpanel', hidden: true, 'aria-label': 'Contents' });
	el.searchPanel = h('aside', { class: 'sv-panel sv-searchpanel', hidden: true, 'aria-label': 'Search' });
	el.overview = h('div', { class: 'sv-overview', hidden: true, role: 'dialog', 'aria-label': 'Overview of all slides' });
	el.help = h('div', { class: 'sv-help', hidden: true, role: 'dialog', 'aria-label': 'Keys' });
	el.hud = h('pre', { class: 'sv-hud', hidden: true });
	el.hint = h('div', { class: 'sv-hint', hidden: true, title: 'Click to hide (I shows it again)', onclick: () => hideHint() });
	el.warmline = h('div', { class: 'sv-warmline', 'aria-hidden': 'true' });
	el.blank = h('div', { class: 'sv-blank', hidden: true });
	el.clock = h('div', { class: 'sv-clock', hidden: true });
	el.laser = h('div', { class: 'sv-laser', hidden: true });
	el.goto = h('div', { class: 'sv-goto', hidden: true });
	el.live = h('div', { class: 'sv-live', 'aria-live': 'polite' });
	el.preview = h('div', { class: 'sv-preview', hidden: true }, h('img', { alt: '' }), h('div', { class: 'sv-preview-t' }));
	root.replaceChildren(el.top, el.stage, el.bottom, el.tocPanel, el.searchPanel, el.overview, el.help, el.hud, el.hint, el.warmline, el.blank, el.clock, el.laser, el.goto, el.live, el.preview);
}

function fillShell() {
	const m = S.meta;
	el.title.textContent = m.title || '';
	el.title.title = [m.title, m.venue, m.date].filter(Boolean).join(' · ');
	if (m.kind === 'url' || m.kind === 'local') {
		// not a talk of this site: "back" leads to the start screen
		el.back.href = '/slides/';
		el.back.title = 'Open another PDF';
		el.back.lastChild.textContent = 'Open…';
		el.title.title = m.kind === 'url' ? m.source : m.local.name + ' (on this computer)';
	} else if (m.page) { el.back.href = m.page; el.back.title = 'Back to the talk page'; }
	else if (m.publications && m.publications.length === 1) { el.back.href = m.publications[0].url; }
	else el.back.hidden = !document.referrer;
	if (!m.page && !m.kind && document.referrer) el.back.href = document.referrer;
	const dl = m.slides.kind === 'html' ? m.slides.download : m.slides.download || m.slides.url;
	for (const a of [el.dl, el.dl2]) {
		a.hidden = !dl;
		if (!dl) continue;
		a.href = dl;
		if (m.slides.downloadName) a.download = m.slides.downloadName;
		a.title = 'Download the PDF' + (m.slides.bytes ? ' (' + C.formatBytes(m.slides.bytes) + ')' : '');
	}
	el.newtab.href = urlFor(1, 'tab');
	if (m.publications && m.publications.length === 1 && m.page) {
		el.paper = h('a', { class: 'sv-paperlink', href: m.publications[0].url, title: m.publications[0].title }, 'Paper');
		el.title.after(el.paper);
	}
}

function showStartImage(src, aspect) {
	el.start.src = src;
	el.start.hidden = false;
	el.start.onerror = () => { el.start.hidden = true; };
	if (aspect) placeSheet(aspect[0], aspect[1]);
}

function updateLoad() {
	const f = S.total ? S.loaded / S.total : 0;
	el.loadbar.firstChild.style.width = (100 * Math.min(1, f)) + '%';
	el.loadbar.classList.toggle('sv-done', f >= 1);
}

// ===================================================================== geometry
function measure() {
	const r = el.stage.getBoundingClientRect();
	const pad = stagePad();
	let w = r.width - 2 * pad, hgt = r.height - 2 * pad;
	S.cssBox = { w, h: hgt };
	if (S.mode === 'present' && !document.fullscreenElement) {
		// render for the screen from the start: pressing F changes nothing
		w = Math.max(w, screen.width); hgt = Math.max(hgt, screen.height);
	}
	S.box = { w: Math.max(1, w), h: Math.max(1, hgt) };
	const cap = S.opts.scale || 2;
	S.dpr = Math.min(window.devicePixelRatio || 1, cap);
}

/** Room around the slide (CSS px); slides-lite.js assumes 6 px for the embed. */
function stagePad() { return S.mode === 'present' ? 0 : S.mode === 'embed' ? 6 : S.phone ? 4 : 12; }

function widthFor(p) {
	const s = S.deck.size(p);
	const f = C.fit(S.box.w, S.box.h, s.w, s.h);
	return C.renderWidth(f.w, f.h, S.dpr, S.maxPx);
}

function configureCache() {
	if (!S.cache) return;
	const w = widthFor(S.page || 1), s = S.deck.size(1);
	const bytes = w * Math.round(w * s.h / s.w) * 4;
	let budget = S.mode === 'present' ? 512e6 : S.phone ? 96e6 : 256e6;
	if (S.mode === 'embed') budget = Math.max(5 * bytes, 30e6);
	S.cache.configure({
		budget,
		tierB: S.mode !== 'embed' && !S.phone,
		thumbs: S.mode !== 'embed',
		jumpTargets: jumpTargets(),
	});
}

function jumpTargets() {
	const fi = C.frameIndex(S.frames, S.page);
	const t = [];
	if (S.frames[fi + 1]) t.push(S.builds ? S.frames[fi + 1].first : S.frames[fi + 1].last);
	if (S.frames[fi - 1]) t.push(S.frames[fi - 1].last);
	if (S.toc) for (const sec of S.toc.sections) t.push(S.frames[sec.first].first);
	t.push(1, S.count);
	return [...new Set(t)];
}

/** Size and center the sheet (canvas + layers) for a page of w×h PDF units. */
function placeSheet(pw, ph) {
	const box = S.cssBox || { w: el.stage.clientWidth, h: el.stage.clientHeight };
	const f = C.fit(box.w, box.h, pw, ph);
	el.sheet.style.width = f.w + 'px';
	el.sheet.style.height = f.h + 'px';
	S.sheet = { w: f.w, h: f.h, pw, ph };
	return f;
}

// ====================================================================== drawing
function makeCodec() {
	let type = 'image/webp', quality = 0.9;
	const thumbW = 320;
	return {
		toBitmap: c => createImageBitmap(c),
		async encode(c) {
			// Large pages (present mode on a 4K screen) as JPEG: encoding WebP
			// at 3840 px takes ~0.5 s a page, JPEG ~0.05 s (2-3x the bytes, and
			// faster to decode); the warm-up is mostly encoding time there.
			const big = c.width * c.height > 4e6;
			const t = big ? 'image/jpeg' : type, q = big ? 0.92 : quality;
			const blob = c.convertToBlob ? await c.convertToBlob({ type: t, quality: q }) : await new Promise(r => c.toBlob(r, t, q));
			if (blob.type !== t && t === 'image/webp') { type = 'image/jpeg'; quality = 0.92; }   // Safari cannot encode WebP
			S.codecType = blob.type;
			return blob;
		},
		async thumb(c) {
			const w = thumbW, hh = Math.max(1, Math.round(c.height * thumbW / c.width));
			const t = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, hh) : Object.assign(document.createElement('canvas'), { width: w, height: hh });
			const ctx = t.getContext('2d');
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(c, 0, 0, w, hh);
			return t.convertToBlob ? t.convertToBlob({ type: 'image/webp', quality: 0.8 }) : new Promise(r => t.toBlob(r, 'image/webp', 0.8));
		},
		decode: blob => createImageBitmap(blob),
	};
}

function draw(bmp) {
	const c = el.canvas;
	if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
	c.getContext('2d').drawImage(bmp, 0, 0);
	el.start.hidden = true;
}

/** Show page p: from tier A within the frame; else a placeholder at once and
 *  the sharp page when it is ready.  `opts.jump`: push a history entry. */
async function show(p, opts = {}) {
	if (S.html) {
		const dir = p >= S.page ? 1 : -1;
		const s = S.deck.size(p);
		placeSheet(s.w, s.h);
		S.page = p;
		S.deck.show(p, dir);
		updateChrome(opts);
		S.stats.last = { served: 'html', ms: 0, page: p };
		return;
	}
	const t0 = performance.now();
	const seq = ++S.navSeq;
	S.waiting = false;
	const dir = p >= S.page ? 1 : -1;
	S.dir = p === S.page ? S.dir : dir;
	S.page = p;
	if (!S.zoom.keep) resetZoom(false);
	const s = S.deck.size(p);
	placeSheet(s.w, s.h);
	S.cache.configure({ jumpTargets: jumpTargets() });
	S.cache.focus(p, S.dir);
	updateChrome(opts);
	clearOverlays();
	const pk = S.cache.peek(p);
	let served = 'cold';
	if (pk && pk.kind === 'A') { draw(pk.bmp); served = pk.sharp ? 'A' : 'stale'; }
	else if (pk && pk.kind === 'B') {
		const bmp = await createImageBitmap(pk.blob);
		if (seq !== S.navSeq) { bmp.close(); return; }
		draw(bmp); bmp.close(); served = pk.sharp ? 'B' : 'stale';
	} else if (pk && pk.kind === 'C') {
		const bmp = await createImageBitmap(pk.blob);
		if (seq !== S.navSeq) { bmp.close(); return; }
		draw(bmp); bmp.close(); served = 'C';
	}
	await nextPaint();
	if (seq === S.navSeq) record(served, performance.now() - t0, p);
	if (served !== 'A' && served !== 'B') {
		S.waiting = true;
		const e = await S.cache.ensure(p);
		if (seq === S.navSeq) S.waiting = false;
		if (seq !== S.navSeq || !e) return;
		draw(e.bmp);
		await nextPaint();
		if (seq === S.navSeq) S.stats.lastSharp = performance.now() - t0;
	}
	if (S.zoom.z > 1) renderZoom();
	scheduleOverlays(p, seq);
}

function nextPaint() { return new Promise(r => requestAnimationFrame(() => r())); }

function record(served, ms, p) {
	S.stats.last = { served, ms: Math.round(ms), page: p };
	if (served === 'A' || served === 'B') S.stats.nav.add(ms);
	S.stats.served[served === 'stale' ? 'C' : served] = (S.stats.served[served === 'stale' ? 'C' : served] || 0) + 1;
}

function go(p, opts = {}) {
	p = Math.max(1, Math.min(S.count, p));
	if (!opts.force && p === S.page && !opts.first) return;
	if (opts.jump) history.pushState({ page: p }, '', urlFor(p));
	else history.replaceState({ page: p }, '', urlFor(p));
	show(p, opts);
}

function urlFor(p, mode = S.mode) {
	const q = new URLSearchParams();
	if (S.opts.t) q.set('t', S.opts.t);
	else if (S.opts.src) q.set('src', S.opts.src);
	else if (S.opts.url) q.set('url', S.meta && S.meta.source || S.opts.url);
	else if (S.opts.local) q.set('local', S.opts.local);
	if (mode === 'present') q.set('present', '');
	if (mode === 'embed') q.set('embed', '');
	if (!S.builds) q.set('builds', '0');
	if (S.opts.scale) q.set('scale', S.opts.scale);
	return location.pathname + '?' + q.toString().replace(/=(?=&|$)/g, '') + C.pageHash(p);
}

function onCacheChange(what, p) {
	if (what === 'page' && el.overview && !el.overview.hidden) refreshOverviewThumb(p);
	drawBuffered();
}

// =================================================================== the chrome
function updateChrome() {
	const p = S.page, fi = C.frameIndex(S.frames, p), f = S.frames[fi];
	const nf = S.frames.length;
	const pagePart = p + ' / ' + S.count;
	const framePart = nf < S.count ? (fi + 1) + ' / ' + nf : '';
	el.counter.replaceChildren(...[
		S.builds ? h('span', { class: 'sv-c-page' }, pagePart) : null,
		framePart ? h('span', { class: 'sv-c-frame', title: 'slide ' + framePart }, (S.builds ? 'slide ' : '') + framePart) : (S.builds ? null : h('span', {}, pagePart)),
	].filter(Boolean));
	el.progress.setAttribute('aria-valuemax', String(S.count));
	el.progress.setAttribute('aria-valuenow', String(p));
	const title = S.toc.frameTitle[fi];
	el.progress.setAttribute('aria-valuetext', 'page ' + p + ' of ' + S.count + (title ? ', ' + title : ''));
	if (el.fill) el.fill.style.width = (100 * (p - 0.5) / S.count) + '%';
	el.live.textContent = 'Page ' + p + ' of ' + S.count + (title ? ', ' + title : '');
	el.prevZone.disabled = p <= 1;
	el.nextZone.disabled = p >= S.count;
	markToc(fi);
	for (const b of document.querySelectorAll('.sv-btn-builds')) {
		b.setAttribute('aria-pressed', String(!S.builds));
		b.classList.toggle('sv-on', !S.builds);
	}
	el.newtab.href = urlFor(p, 'tab');
	if (f && f.last > f.first && S.builds) el.counter.dataset.builds = (p - f.first + 1) + '/' + (f.last - f.first + 1);
	else delete el.counter.dataset.builds;
}

function buildProgress() {
	const bar = el.progress;
	bar.replaceChildren();
	const track = h('div', { class: 'sv-track' });
	for (const sec of S.toc.sections) {
		const a = S.frames[sec.first].first;
		const lastF = sec.frames[sec.frames.length - 1];
		const b = S.frames[lastF].last;
		const seg = h('div', { class: 'sv-seg', title: sec.title || '' });
		seg.style.left = (100 * (a - 1) / S.count) + '%';
		seg.style.width = (100 * (b - a + 1) / S.count) + '%';
		track.append(seg);
	}
	if (S.frames.length <= 120) for (const f of S.frames) {
		if (f.first === 1) continue;
		const t = h('div', { class: 'sv-tick' });
		t.style.left = (100 * (f.first - 1) / S.count) + '%';
		track.append(t);
	}
	el.buffered = h('canvas', { class: 'sv-buffered', 'aria-hidden': 'true' });
	el.fill = h('div', { class: 'sv-fill' });
	track.append(el.buffered, el.fill);
	bar.append(track);
	const pageAt = x => {
		const r = track.getBoundingClientRect();
		return Math.max(1, Math.min(S.count, Math.floor((x - r.left) / r.width * S.count) + 1));
	};
	let dragging = false;
	bar.addEventListener('pointerdown', e => {
		dragging = true; bar.setPointerCapture(e.pointerId);
		go(C.snap(pageAt(e.clientX), S.frames, S.builds), { jump: true });
		preview(e.clientX, pageAt(e.clientX));
	});
	bar.addEventListener('pointermove', e => {
		const p = pageAt(e.clientX);
		preview(e.clientX, p);
		if (dragging) go(C.snap(p, S.frames, S.builds));
	});
	const end = () => { dragging = false; };
	bar.addEventListener('pointerup', end);
	bar.addEventListener('pointercancel', end);
	bar.addEventListener('pointerleave', () => { if (!dragging) el.preview.hidden = true; });
	bar.addEventListener('keydown', e => {
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') return;     // global handler
	});
}

/** The strip under the position bar: which pages are prepared (like a video
 *  player's "buffered" ranges).  Dark: ready at screen resolution (tier A/B);
 *  light: only an outdated or thumbnail version. */
let bufferedPending = false;
function drawBuffered() {
	if (bufferedPending || !el.buffered || !S.cache) return;
	bufferedPending = true;
	requestAnimationFrame(() => {
		bufferedPending = false;
		const c = el.buffered, w = Math.max(1, Math.round(c.clientWidth)), n = S.count;
		if (c.width !== w) { c.width = w; c.height = 1; }
		const ctx = c.getContext('2d');
		ctx.clearRect(0, 0, w, 1);
		for (let p = 1; p <= n; p++) {
			const pk = S.cache.peek(p);
			if (!pk) continue;
			ctx.fillStyle = pk.sharp ? 'rgba(70, 67, 58, .55)' : 'rgba(70, 67, 58, .22)';
			const x0 = Math.floor((p - 1) / n * w), x1 = Math.max(x0 + 1, Math.floor(p / n * w));
			ctx.fillRect(x0, 0, x1 - x0, 1);
		}
	});
}

function thumbURL(p) {
	if (S.html) return S.htmlThumbs ? S.htmlThumbs.get(C.frameIndex(S.frames, p)) || null : null;
	const blob = S.cache && S.cache.thumb(p);
	if (!blob) return null;
	let u = S.thumbURL.get(p);
	if (!u) { u = URL.createObjectURL(blob); S.thumbURL.set(p, u); }
	return u;
}

function preview(x, p) {
	if (S.phone) return;
	const fi = C.frameIndex(S.frames, p);
	const img = el.preview.firstChild, t = el.preview.lastChild;
	const u = thumbURL(C.snap(p, S.frames, false)) || thumbURL(p);
	img.hidden = !u;
	if (u) img.src = u;
	t.textContent = (fi + 1) + ' \u2009·\u2009 ' + frameLabel(fi) + '  (page ' + p + ')';
	el.preview.hidden = false;
	const r = el.progress.getBoundingClientRect();
	const w = el.preview.offsetWidth || 200;
	el.preview.style.left = Math.max(4, Math.min(innerWidth - w - 4, x - w / 2)) + 'px';
	el.preview.style.bottom = (innerHeight - r.top + 8) + 'px';
}

// ========================================================================== TOC
function frameLabel(fi) {
	return S.toc.frameTitle[fi] || (fi === 0 ? 'Title' : 'Slide ' + (fi + 1));
}

function buildToc() {
	const list = h('ol', { class: 'sv-toc' });
	for (const sec of S.toc.sections) {
		const items = h('ol', {});
		for (const fi of sec.frames) {
			const f = S.frames[fi];
			items.append(h('li', {}, h('a', { href: urlFor(f.first), 'data-frame': fi, onclick: e => { e.preventDefault(); go(S.builds ? f.first : f.last, { jump: true }); if (S.phone || S.mode === 'embed') closePanels(); } },
				h('span', { class: 'sv-toc-n' }, String(fi + 1)), ' ', frameLabel(fi))));
		}
		const showTitle = sec.title && !(sec.frames.length === 1 && frameLabel(sec.frames[0]) === sec.title);
		list.append(h('li', { class: 'sv-toc-sec' }, showTitle ? h('div', { class: 'sv-toc-st' }, sec.title) : null, items));
	}
	el.tocPanel.replaceChildren(
		h('div', { class: 'sv-panel-head' }, h('h2', {}, 'Contents'), h('button', { type: 'button', class: 'sv-btn', 'aria-label': 'Close', onclick: () => closePanels() }, icon('close'))),
		list);
	el.tocLinks = [...list.querySelectorAll('a[data-frame]')];
}

function markToc(fi) {
	if (!el.tocLinks) return;
	for (const a of el.tocLinks) {
		const on = +a.dataset.frame === fi;
		a.classList.toggle('sv-cur', on);
		if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
		if (on && !el.tocPanel.hidden) a.scrollIntoView({ block: 'nearest' });
	}
}

function togglePanel(panel) {
	const open = panel.hidden;
	closePanels();
	if (open) {
		panel.hidden = false;
		el.root.classList.add('sv-panel-open');
		if (panel === el.tocPanel) markToc(C.frameIndex(S.frames, S.page));
		relayout();
	}
	return open;
}

function closePanels() {
	let any = false;
	for (const p of [el.tocPanel, el.searchPanel, el.overview, el.help]) { if (!p.hidden) any = true; p.hidden = true; }
	el.root.classList.remove('sv-panel-open');
	if (any) relayout();
	return any;
}

// ===================================================================== overview
function openOverview() {
	if (!el.overview.hidden) { closePanels(); return; }
	closePanels();
	const grid = h('div', { class: 'sv-grid' });
	// sections are marked on their first card (one-slide sections are common)
	for (const sec of S.toc.sections) {
		sec.frames.forEach((fi, k) => {
			const f = S.frames[fi];
			const u = thumbURL(f.last);
			const card = h('button', { type: 'button', class: 'sv-card' + (k === 0 && sec.title ? ' sv-card-sec' : ''), 'data-page': f.last, 'data-frame': fi,
				onclick: () => { closePanels(); go(f.last, { jump: true }); } },
				h('span', { class: 'sv-card-st' }, k === 0 && sec.title ? sec.title : '\u00a0'),
				u ? h('img', { src: u, alt: '', loading: 'lazy' }) : h('div', { class: 'sv-card-ph' }),
				h('span', {}, (fi + 1) + ' \u2009·\u2009 ' + frameLabel(fi)));
			grid.append(card);
		});
	}
	el.overview.replaceChildren(h('div', { class: 'sv-panel-head' }, h('h2', {}, 'Overview'),
		h('button', { type: 'button', class: 'sv-btn', 'aria-label': 'Close', onclick: () => closePanels() }, icon('close'))), grid);
	el.overview.hidden = false;
	const cur = grid.querySelector(`[data-frame="${C.frameIndex(S.frames, S.page)}"]`);
	if (cur) { cur.focus(); cur.scrollIntoView({ block: 'center' }); }
}

function refreshOverviewThumb(p) {
	const card = el.overview.querySelector(`.sv-card[data-page="${p}"]`);
	if (!card || card.querySelector('img')) return;
	const u = thumbURL(p);
	if (u) card.querySelector('.sv-card-ph').replaceWith(h('img', { src: u, alt: '' }));
}

function overviewKey(e) {
	const cards = [...el.overview.querySelectorAll('.sv-card')];
	const i = cards.indexOf(document.activeElement);
	if (i < 0) return false;
	const cols = Math.max(1, Math.round(el.overview.querySelector('.sv-grid').clientWidth / cards[0].offsetWidth));
	const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
	if (d) { const j = Math.max(0, Math.min(cards.length - 1, i + d)); cards[j].focus(); cards[j].scrollIntoView({ block: 'nearest' }); return true; }
	return false;
}

// ======================================================================= search
async function loadTexts() {
	if (S.texts) return S.texts;
	if (S.textsLoading) return S.textsLoading;
	S.texts = null;
	const texts = new Array(S.count).fill(null);
	S.textsLoading = (async () => {
		for (let p = 1; p <= S.count; p++) {
			try { texts[p - 1] = C.normalize(await S.deck.text(p)); } catch (e) { texts[p - 1] = ''; }
			if (p % 10 === 0) { S.textsProgress = p / S.count; if (!el.searchPanel.hidden) runSearch(); }
		}
		S.texts = texts;
		S.textsProgress = 1;
		return texts;
	})();
	S.partialTexts = texts;
	return S.textsLoading;
}

function openSearch() {
	if (!el.searchPanel.hidden) { el.searchInput.focus(); el.searchInput.select(); return; }
	closePanels();
	if (!el.searchInput) {
		el.searchInput = h('input', { type: 'search', class: 'sv-search-in', placeholder: 'Search the slides', 'aria-label': 'Search the slides', autocomplete: 'off', spellcheck: 'false' });
		el.searchInput.addEventListener('input', () => runSearch());
		el.searchInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
			else if (e.key === 'Escape') { e.preventDefault(); closePanels(); el.stage.focus(); }
			e.stopPropagation();
		});
		el.searchInfo = h('div', { class: 'sv-search-info' });
		el.searchList = h('ol', { class: 'sv-hits' });
		el.searchPanel.append(
			h('div', { class: 'sv-panel-head' }, el.searchInput, h('button', { type: 'button', class: 'sv-btn', 'aria-label': 'Close', onclick: () => closePanels() }, icon('close'))),
			el.searchInfo, el.searchList);
	}
	el.searchPanel.hidden = false;
	el.root.classList.add('sv-panel-open');
	relayout();
	el.searchInput.focus();
	el.searchInput.select();
	loadTexts().then(() => runSearch());
	runSearch();
}

function runSearch() {
	const q = el.searchInput ? el.searchInput.value : '';
	S.query = q;
	const texts = S.texts || S.partialTexts || [];
	S.hits = C.search(texts, q, S.frames);
	S.hitIdx = -1;
	const done = S.texts != null;
	el.searchInfo.textContent = !q.trim() ? (done ? '' : 'Reading the slides… ' + Math.round(100 * (S.textsProgress || 0)) + '%')
		: S.hits.length + ' slide' + (S.hits.length === 1 ? '' : 's') + (done ? '' : ' so far (' + Math.round(100 * (S.textsProgress || 0)) + '% read)');
	el.searchList.replaceChildren(...S.hits.slice(0, 100).map((hit, i) => {
		const u = thumbURL(hit.page);
		const snip = h('span', { class: 'sv-snip' });
		snip.append(hit.snippet.slice(0, hit.at), h('mark', {}, hit.snippet.slice(hit.at, hit.at + hit.len)), hit.snippet.slice(hit.at + hit.len));
		return h('li', {}, h('a', { href: urlFor(hit.page), onclick: e => { e.preventDefault(); S.hitIdx = i; gotoHit(); } },
			u ? h('img', { src: u, alt: '' }) : null,
			h('span', { class: 'sv-hit-t' }, (hit.frame + 1) + ' \u2009·\u2009 ' + frameLabel(hit.frame)), snip));
	}));
	if (!q.trim()) clearMarks();
}

function stepHit(d) {
	if (!S.hits.length) return;
	S.hitIdx = (S.hitIdx + d + S.hits.length) % S.hits.length;
	gotoHit();
}

function gotoHit() {
	const hit = S.hits[S.hitIdx];
	if (!hit) return;
	[...el.searchList.children].forEach((li, i) => li.classList.toggle('sv-cur', i === S.hitIdx));
	go(hit.page, { jump: true, force: true });
	if (S.phone) closePanels();
}

// ===================================================== text layer, links, marks
let overlayTimer = null;
function clearOverlays() {
	clearTimeout(overlayTimer);
	el.text.replaceChildren();
	el.links.replaceChildren();
	clearMarks();
}
function clearMarks() { el.marks.replaceChildren(); }

function scheduleOverlays(p, seq) {
	clearTimeout(overlayTimer);
	overlayTimer = setTimeout(async () => {
		if (seq !== S.navSeq || S.zoom.z > 1) return;
		const scale = S.sheet.w / S.deck.size(p).w;
		try {
			const { links, view } = await S.deck.links(p);
			if (seq !== S.navSeq) return;
			el.links.replaceChildren(...links.map(l => {
				const [x0, y0, x1, y1] = l.rect;
				const a = h('a', { class: 'sv-link', href: l.url || urlFor(l.page) });
				if (l.url) { a.target = '_blank'; a.rel = 'noopener'; a.title = l.url; }
				else a.addEventListener('click', e => { e.preventDefault(); go(l.page, { jump: true }); });
				Object.assign(a.style, { left: (x0 - view[0]) * scale + 'px', top: (view[3] - y1) * scale + 'px', width: (x1 - x0) * scale + 'px', height: (y1 - y0) * scale + 'px' });
				return a;
			}));
			if (S.mode === 'present') return;
			await S.deck.textLayer(p, el.text, scale);
			if (seq !== S.navSeq) return;
			markMatches();
		} catch (e) { /* overlays are a bonus */ }
	}, S.mode === 'present' ? 150 : 300);
}

/** Highlight the current query on the shown page (text layer spans). */
function markMatches() {
	clearMarks();
	const q = C.normalize(S.query || '');
	if (!q || el.searchPanel.hidden) return;
	const words = q.split(' ').filter(Boolean);
	const sheetR = el.sheet.getBoundingClientRect();
	for (const span of el.text.querySelectorAll('span')) {
		const node = span.firstChild;
		if (!node || node.nodeType !== 3) continue;
		const raw = node.textContent;
		const low = raw.toLowerCase();
		for (const w of words) {
			let i = low.indexOf(w);
			while (i >= 0) {
				const r = document.createRange();
				r.setStart(node, i); r.setEnd(node, Math.min(raw.length, i + w.length));
				for (const rc of r.getClientRects()) {
					const m = h('div', { class: 'sv-mark' });
					Object.assign(m.style, { left: rc.left - sheetR.left + 'px', top: rc.top - sheetR.top + 'px', width: rc.width + 'px', height: rc.height + 'px' });
					el.marks.append(m);
				}
				i = low.indexOf(w, i + w.length);
			}
		}
	}
}

// ========================================================================= zoom
function resetZoom(render = true) {
	if (S.zoom.z === 1 && !el.root.classList.contains('sv-zoomed')) return;
	S.zoom.z = 1; S.zoom.cx = 0.5; S.zoom.cy = 0.5;
	el.sheet.style.transform = '';
	el.zoomCanvas.hidden = true;
	el.root.classList.remove('sv-zoomed');
	if (render) scheduleOverlays(S.page, S.navSeq);
}

function setZoom(z, cx, cy) {
	z = Math.max(1, Math.min(8, z));
	if (z <= 1.001) { resetZoom(); return; }
	S.zoom.z = z;
	if (cx != null) S.zoom.cx = cx;
	if (cy != null) S.zoom.cy = cy;
	clampZoom();
	applyZoomTransform();
	el.root.classList.add('sv-zoomed');
	clearOverlays();
	clearTimeout(S.zoomTimer);
	el.zoomCanvas.hidden = true;
	S.zoomTimer = setTimeout(renderZoom, 120);
}

function clampZoom() {
	const z = S.zoom, sw = S.cssBox.w, sh = S.cssBox.h, W = S.sheet.w * z.z, H = S.sheet.h * z.z;
	const cl = (c, size, view) => size <= view ? 0.5 : Math.max(view / (2 * size), Math.min(1 - view / (2 * size), c));
	z.cx = cl(z.cx, W, sw); z.cy = cl(z.cy, H, sh);
}

function applyZoomTransform() {
	const z = S.zoom;
	// the sheet is centered; move the point (cx, cy) of the page to the center
	const dx = (0.5 - z.cx) * S.sheet.w * z.z, dy = (0.5 - z.cy) * S.sheet.h * z.z;
	el.sheet.style.transform = `translate(${dx}px, ${dy}px) scale(${z.z})`;
}

async function renderZoom() {
	if (S.zoom.z <= 1) return;
	const p = S.page, seq = S.navSeq, z = S.zoom;
	const s = S.deck.size(p);
	const sw = S.cssBox.w, sh = S.cssBox.h;
	const dpr = S.dpr;
	const W = S.sheet.w * z.z, H = S.sheet.h * z.z;
	const vw = Math.min(sw, W), vh = Math.min(sh, H);           // visible part of the page (CSS px)
	let cw = Math.round(vw * dpr), ch = Math.round(vh * dpr);
	const k = Math.min(1, 4096 / Math.max(cw, ch)); cw = Math.round(cw * k); ch = Math.round(ch * k);
	const scale = (W / s.w) * dpr * k;
	const left = (z.cx * W - vw / 2) * dpr * k, top = (z.cy * H - vh / 2) * dpr * k;
	const ctrl = new AbortController();
	if (S.zoomCtrl) S.zoomCtrl.abort();
	S.zoomCtrl = ctrl;
	const key = [p, z.z, z.cx, z.cy, sw, sh].join();
	try {
		const c = await S.deck.renderRegion(p, scale, -left, -top, cw, ch, ctrl.signal);
		if (seq !== S.navSeq || key !== [S.page, S.zoom.z, S.zoom.cx, S.zoom.cy, S.cssBox.w, S.cssBox.h].join()) return;
		const zc = el.zoomCanvas;
		zc.width = cw; zc.height = ch;
		zc.getContext('2d').drawImage(c, 0, 0);
		zc.style.width = vw + 'px'; zc.style.height = vh + 'px';
		zc.hidden = false;
		S.stats.zoomRenders = (S.stats.zoomRenders || 0) + 1;
	} catch (e) { /* canceled */ }
}

function zoomBy(f, clientX, clientY) {
	const z = S.zoom;
	let cx = z.cx, cy = z.cy;
	if (clientX != null) {
		// keep the point under the pointer where it is
		const r = el.stage.getBoundingClientRect();
		const W = S.sheet.w * z.z, H = S.sheet.h * z.z;
		const px = clientX - (r.left + r.width / 2), py = clientY - (r.top + r.height / 2);
		const ux = z.cx + px / W, uy = z.cy + py / H;          // page point under the pointer
		const nz = Math.max(1, Math.min(8, z.z * f));
		cx = ux - px / (S.sheet.w * nz); cy = uy - py / (S.sheet.h * nz);
		setZoom(nz, cx, cy);
	} else setZoom(z.z * f);
}

// ======================================================================= modes
function act(a) {
	switch (a) {
		case 'next': case 'prev': case 'nextFrame': case 'prevFrame': case 'frameEnd': case 'frameStart': case 'first': case 'last': {
			const p = C.navigate(S.page, a, S.frames, S.count, S.builds);
			const jump = a === 'first' || a === 'last';
			if (p !== S.page) go(p, { jump });
			return;
		}
		case 'goto': return openGoto('');
		case 'fullscreen': return toggleFullscreen();
		case 'overview': return S.mode === 'embed' ? null : openOverview();
		case 'toc': togglePanel(el.tocPanel); return;
		case 'search': return S.mode === 'embed' ? null : openSearch();
		case 'builds': {
			S.builds = !S.builds;
			buildToc();
			const p = C.snap(S.page, S.frames, S.builds);
			if (S.cache) S.cache.configure({ jumpTargets: jumpTargets() });
			if (p !== S.page) go(p); else { history.replaceState({ page: p }, '', urlFor(p)); updateChrome(); }
			flash(S.builds ? 'Showing build steps' : 'Build steps hidden: one stop per slide');
			return;
		}
		case 'zoomIn': return S.html ? null : zoomBy(1.5);
		case 'zoomOut': return S.html ? null : zoomBy(1 / 1.5);
		case 'zoomFit': return S.html ? null : resetZoom();
		case 'zoomKeep': S.zoom.keep = !S.zoom.keep; flash(S.zoom.keep ? 'Zoom kept when changing pages' : 'Zoom resets on page change'); return;
		case 'mode': return S.mode === 'present' ? leavePresent() : enterPresent();
		case 'black': return toggleBlank('black');
		case 'white': return toggleBlank('white');
		case 'clock': el.clock.hidden = !el.clock.hidden; tick(); return;
		case 'laser': S.laser = !S.laser; el.laser.hidden = true; el.root.classList.toggle('sv-laser-on', S.laser); return;
		case 'info':
			if (el.hint.hidden) { S.hintDismissed = false; S.hintPinned = true; el.hint.hidden = false; tick(); }
			else hideHint();
			return;
		case 'hud': el.hud.hidden = !el.hud.hidden; tick(); return;
		case 'rerender': if (S.html) { S.deck.reload(); flash('Deck reloaded'); return; } S.cache.clear(); for (const u of S.thumbURL.values()) URL.revokeObjectURL(u); S.thumbURL.clear(); show(S.page); flash('Cache cleared'); return;
		case 'help': return toggleHelp();
		case 'escape': return escape();
	}
}

function escape() {
	if (!el.goto.hidden) { closeGoto(); return; }
	if (!el.blank.hidden) { el.blank.hidden = true; return; }
	if (closePanels()) { el.stage.focus(); return; }
	if (S.zoom.z > 1) { resetZoom(); return; }
	if (document.fullscreenElement) { document.exitFullscreen(); return; }
	if (S.mode === 'present') leavePresent();
}

function toggleFullscreen() {
	if (document.fullscreenElement) document.exitFullscreen();
	else if (document.documentElement.requestFullscreen) {
		document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
			if (S.mode === 'present' && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
		}).catch(() => {
			if (S.mode === 'embed') window.open(urlFor(S.page, 'tab'), '_blank', 'noopener');
		});
	}
}

function enterPresent(initial = false) {
	S.mode = 'present';
	document.documentElement.classList.remove('sv-mode-tab', 'sv-mode-embed');
	document.documentElement.classList.add('sv-mode-present');
	closePanels();
	history.replaceState({ page: S.page }, '', urlFor(S.page));
	document.title = (S.meta.title || 'Slides') + ' — present';
	el.hint.hidden = false;
	S.hintUntil = performance.now() + (initial ? 6000 : 3000);
	relayout(true);
	if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { S.wake = l; }).catch(() => {});
	if (!initial) countView();
	S.presentStart = S.presentStart || Date.now();
}

function leavePresent() {
	S.mode = 'tab';
	document.documentElement.classList.remove('sv-mode-present');
	document.documentElement.classList.add('sv-mode-tab');
	el.hint.hidden = true; el.blank.hidden = true; el.clock.hidden = true;
	S.laser = false; el.root.classList.remove('sv-laser-on');
	if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
	if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
	history.replaceState({ page: S.page }, '', urlFor(S.page));
	document.title = (S.meta.title || 'Slides') + ' — slides';
	relayout(true);
}

function toggleBlank(color) {
	if (!el.blank.hidden && el.blank.dataset.color === color) { el.blank.hidden = true; return; }
	el.blank.dataset.color = color;
	el.blank.hidden = false;
}

function toggleHelp() {
	if (!el.help.hidden) { closePanels(); return; }
	closePanels();
	const m = S.mode === 'embed' ? 'e' : S.mode === 'present' ? 'p' : 't';
	const fmt = k => ({ ' ': 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', 'Shift+ArrowRight': 'Shift+→', 'Shift+ArrowLeft': 'Shift+←', Escape: 'Esc', PageDown: 'PgDn', PageUp: 'PgUp' }[k] || (k.length === 1 ? k.toUpperCase() : k));
	const rows = C.KEYS.filter(r => r.modes.includes(m)).map(r => h('tr', {}, h('td', {}, ...r.keys.map((k, i) => [i ? ' ' : '', h('kbd', {}, fmt(k))])), h('td', {}, r.help)));
	const extra = S.mode === 'present'
		? [h('p', {}, 'Mouse: left click next, right click previous. Digits then Enter jump to a page.')]
		: [h('p', {}, 'Ctrl+wheel or pinch zooms; drag to move around when zoomed. Click the bar at the bottom to jump.')];
	el.help.replaceChildren(h('div', { class: 'sv-panel-head' }, h('h2', {}, 'Keys'),
		h('button', { type: 'button', class: 'sv-btn', 'aria-label': 'Close', onclick: () => closePanels() }, icon('close'))),
		h('table', {}, h('tbody', {}, rows)), ...extra,
		...(S.mode !== 'present' ? [h('p', { class: 'sv-small' }, 'Present mode: ', h('a', { href: urlFor(S.page, 'present') }, 'this URL'), ' or M.')] : []));
	el.help.hidden = false;
}

// ---- go to page (digits + Enter, or G)
function openGoto(initial) {
	el.goto.hidden = false;
	el.goto.textContent = 'Go to page: ' + initial + '▏';
	el.goto.dataset.v = initial;
}
function closeGoto() { el.goto.hidden = true; el.goto.dataset.v = ''; }
function gotoKey(e) {
	if (el.goto.hidden) {
		if (/^[0-9]$/.test(e.key) && S.mode !== 'embed' && !(e.key === '0')) { openGoto(e.key); return true; }
		return false;
	}
	let v = el.goto.dataset.v || '';
	if (/^[0-9]$/.test(e.key)) v += e.key;
	else if (e.key === 'Backspace') v = v.slice(0, -1);
	else if (e.key === 'Enter') { closeGoto(); if (v) go(Math.max(1, Math.min(S.count, parseInt(v, 10))), { jump: true }); return true; }
	else if (e.key === 'Escape') { closeGoto(); return true; }
	else return false;
	el.goto.dataset.v = v;
	el.goto.textContent = 'Go to page: ' + v + '▏';
	return true;
}

function hideHint() {
	S.hintDismissed = true;
	S.hintPinned = false;
	el.hint.hidden = true;
}

let flashTimer;
function flash(text) {
	el.hint.textContent = text;
	el.hint.hidden = false;
	el.hint.classList.add('sv-flash');
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => { el.hint.classList.remove('sv-flash'); if (S.mode !== 'present' || S.hintDismissed || performance.now() > S.hintUntil) el.hint.hidden = true; }, 1600);
}

// ======================================================================== input
function installInput() {
	window.addEventListener('keydown', handleKey);
	installPointer();
}

/** Keys of the viewer window, and those an HTML deck forwards (deck-bridge.js). */
function handleKey(e) {
	if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
	if (gotoKey(e)) { e.preventDefault(); return; }
	if (!el.overview.hidden && (e.key.startsWith('Arrow') || e.key === 'Enter')) {
		if (e.key === 'Enter') return;            // the focused card handles it
		if (overviewKey(e)) { e.preventDefault(); return; }
	}
	const name = C.keyName(e);
	if (name === '0' && !el.goto.hidden) return;
	if (S.html && S.deck.keys && S.deck.keys.includes(name) && !e.ctrlKey && !e.metaKey && !e.altKey) {
		// a key the HTML deck keeps for itself (e.g. pause an animation)
		e.preventDefault();
		S.deck.post({ type: 'deckkey', key: e.key });
		return;
	}
	const a = C.actionFor(name, S.mode);
	if (!a) return;
	if ((e.ctrlKey || e.metaKey || e.altKey) && a !== 'search') return;   // leave browser shortcuts alone
	if (a === 'next' && e.target && e.target.tagName === 'BUTTON' && e.key === 'Enter') return;
	if (a === 'next' && e.target && e.target.tagName === 'A' && e.key === 'Enter') return;
	e.preventDefault();
	// a held key must not run ahead of the screen: while the page on screen
	// is still a placeholder, auto-repeats are dropped (single presses count)
	if (e.repeat && S.waiting && ['next', 'prev', 'nextFrame', 'prevFrame'].includes(a)) { S.stats.dropped = (S.stats.dropped || 0) + 1; return; }
	if (S.mode === 'present' && !el.hint.hidden && !S.hintPinned && ['next', 'prev', 'nextFrame', 'prevFrame', 'goto', 'first', 'last'].includes(a)) hideHint();
	act(a);
}

function installPointer() {
	window.addEventListener('popstate', () => {
		const p = C.parsePageHash(location.hash);
		if (p && p !== S.page) show(Math.min(S.count, p), {});
	});
	window.addEventListener('hashchange', () => {
		const p = C.parsePageHash(location.hash);
		if (p && p !== S.page) show(Math.min(S.count, p), {});
	});
	// wheel: Ctrl zooms; in tab/present a plain wheel turns pages
	let acc = 0, accT = 0;
	el.stage.addEventListener('wheel', e => {
		if (e.ctrlKey || e.metaKey) { e.preventDefault(); if (!S.html) zoomBy(Math.exp(-e.deltaY / 300), e.clientX, e.clientY); return; }
		if (S.zoom.z > 1) { e.preventDefault(); panBy(e.deltaX, e.deltaY); return; }
		if (S.mode === 'embed') return;
		e.preventDefault();
		const now = performance.now();
		if (now - accT > 300) acc = 0;
		accT = now;
		acc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
		if (Math.abs(acc) > 80) { act(acc > 0 ? 'next' : 'prev'); acc = 0; }
	}, { passive: false });
	// pointer: drag to pan when zoomed, swipe on touch, double click to zoom
	const pts = new Map();
	let start = null, pinch = null;
	el.stage.addEventListener('pointerdown', e => {
		if (e.target.closest('a, button')) return;
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 1) start = { x: e.clientX, y: e.clientY, t: performance.now(), cx: S.zoom.cx, cy: S.zoom.cy, moved: false };
		if (pts.size === 2) {
			const [a, b] = [...pts.values()];
			pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
		}
		el.stage.setPointerCapture(e.pointerId);
	});
	el.stage.addEventListener('pointermove', e => {
		if (S.laser && S.mode === 'present') moveLaser(e);
		if (!pts.has(e.pointerId)) return;
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && pts.size === 2) {
			const [a, b] = [...pts.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			const nz = Math.max(1, Math.min(8, pinch.z * d / pinch.d));
			if (!S.html) zoomBy(nz / S.zoom.z, pinch.mx, pinch.my);
			return;
		}
		if (!start) return;
		const dx = e.clientX - start.x, dy = e.clientY - start.y;
		if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
		if (S.zoom.z > 1 && start.moved) {
			S.zoom.cx = start.cx - dx / (S.sheet.w * S.zoom.z);
			S.zoom.cy = start.cy - dy / (S.sheet.h * S.zoom.z);
			clampZoom(); applyZoomTransform();
			el.zoomCanvas.hidden = true;
			clearTimeout(S.zoomTimer); S.zoomTimer = setTimeout(renderZoom, 120);
		}
	});
	const up = e => {
		const had = pts.has(e.pointerId);
		pts.delete(e.pointerId);
		if (pts.size < 2) pinch = null;
		if (!had || !start || pts.size) { if (!pts.size) start = null; return; }
		const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = performance.now() - start.t;
		if (S.zoom.z === 1 && e.pointerType !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 600) act(dx < 0 ? 'next' : 'prev');
		else if (!start.moved && S.mode === 'present' && e.button === 0 && e.pointerType === 'mouse') act('next');
		start = null;
	};
	el.stage.addEventListener('pointerup', up);
	el.stage.addEventListener('pointercancel', e => { pts.delete(e.pointerId); start = null; pinch = null; });
	el.stage.addEventListener('dblclick', e => {
		if (S.mode === 'present' || S.html) return;
		// fast clicking on the page-turn zones (or any button) is not a zoom request
		if (e.target.closest('.sv-zone, button, a')) return;
		if (S.zoom.z > 1) resetZoom(); else zoomBy(2, e.clientX, e.clientY);
	});
	el.stage.addEventListener('contextmenu', e => { if (S.mode === 'present') { e.preventDefault(); act('prev'); } });
	// pointer hiding in full screen / present mode
	let idleT;
	window.addEventListener('pointermove', () => {
		el.root.classList.remove('sv-idle');
		clearTimeout(idleT);
		idleT = setTimeout(() => el.root.classList.add('sv-idle'), S.mode === 'present' ? 2000 : 2500);
	});
	// The warm-up goes on while the tab is in the background (it needs no
	// timers or animation frames: renders run in PDF.js's workers, and the
	// scheduler is driven by promises, which browsers do not throttle).
	document.addEventListener('visibilitychange', () => { if (S.cache && !document.hidden) S.cache.pump(); });
	document.addEventListener('fullscreenchange', () => {
		const fs = !!document.fullscreenElement;
		document.documentElement.classList.toggle('sv-fs', fs);
		for (const b of document.querySelectorAll('.sv-btn-full')) b.querySelector('.sv-ic').innerHTML = ICON[fs ? 'unfull' : 'full'];
		if (!fs && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
	});
	// in the iframe: take focus on the first click so arrow keys work
	if (S.mode === 'embed') el.root.addEventListener('pointerdown', () => { if (document.activeElement === document.body) el.stage.focus({ preventScroll: true }); });
	el.stage.focus({ preventScroll: true });
}

function panBy(dx, dy) {
	S.zoom.cx += dx / (S.sheet.w * S.zoom.z);
	S.zoom.cy += dy / (S.sheet.h * S.zoom.z);
	clampZoom(); applyZoomTransform();
	el.zoomCanvas.hidden = true;
	clearTimeout(S.zoomTimer); S.zoomTimer = setTimeout(renderZoom, 120);
}

function moveLaser(e) {
	el.laser.hidden = false;
	el.laser.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
}

// ======================================================================= resize
function installResize() {
	let t = null, lastKey = keyNow();
	const settle = () => {
		clearTimeout(t);
		t = setTimeout(() => {
			measure();
			const s = S.deck.size(S.page);
			placeSheet(s.w, s.h);
			if (S.zoom.z > 1) { clampZoom(); applyZoomTransform(); renderZoom(); }
			const k = keyNow();
			if (S.html) return;
			if (k !== lastKey) {
				lastKey = k;
				configureCache();
				S.cache.geometryChanged();
				show(S.page, { force: true });
				drawBuffered();
			} else {
				scheduleOverlays(S.page, S.navSeq);
			}
		}, 250);
	};
	S.relayout = settle;
	// while resizing, CSS scales the old canvas; nothing renders
	new ResizeObserver(() => { const s = S.deck.size(S.page); const box = el.stage.getBoundingClientRect(); S.cssBox = { w: box.width - 2 * stagePad(), h: box.height - 2 * stagePad() }; placeSheet(s.w, s.h); clearOverlays(); settle(); }).observe(el.stage);
	const watchDpr = () => {
		const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		mq.addEventListener('change', () => { settle(); watchDpr(); }, { once: true });
	};
	watchDpr();
}

function keyNow() {
	measure();
	const s = S.deck.size(S.page);
	return widthFor(S.page) + 'x' + s.w + 'x' + s.h;
}

function relayout(modeChanged) {
	if (modeChanged && S.cache) configureCache();
	if (S.relayout) S.relayout();
}

// ===================================================================== periodic
function tick() {
	if (!S.cache && !S.html) return;
	const st = S.cache ? S.cache.stats() : { warm: 1 };
	// present-mode warm-up hint
	if (S.mode === 'present' && !el.hint.classList.contains('sv-flash')) {
		const warm = Math.round(100 * st.warm);
		const ready = S.total ? S.loaded >= S.total : true;
		el.root.style.setProperty('--sv-warm', warm + '%');
		if (S.hintDismissed) el.hint.hidden = true;
		else if (S.hintPinned || performance.now() < S.hintUntil || warm < 100) {
			el.hint.hidden = false;
			el.hint.textContent = (warm < 100 ? 'warm-up ' + warm + '%' + (ready ? '' : ' · loading ' + Math.round(100 * S.loaded / (S.total || 1)) + '%') + ' · ' : 'ready · ') + 'F: full screen · ?: keys · I or click: hide';
		} else el.hint.hidden = true;
		el.root.classList.toggle('sv-warm', warm >= 100);
	}
	if (!el.clock.hidden) {
		const d = new Date(), el2 = Math.floor((Date.now() - (S.presentStart || Date.now())) / 1000);
		el.clock.textContent = d.toTimeString().slice(0, 5) + '  ·  ' + Math.floor(el2 / 60) + ':' + String(el2 % 60).padStart(2, '0');
	}
	if (!el.hud.hidden) el.hud.textContent = hudText(st);
}

function hudText(st) {
	if (S.html) return `HTML deck ${S.meta.slides.url}\nposition ${S.page} / ${S.count}  (${S.frames.length} slides)`;
	const n = S.stats.nav, l = S.stats.last || {};
	const mb = x => (x / 1e6).toFixed(1) + ' MB';
	return [
		`last: page ${l.page} from ${l.served} in ${l.ms} ms` + (S.stats.lastSharp ? `  (sharp after ${Math.round(S.stats.lastSharp)} ms)` : ''),
		`input→paint (cached): median ${fmt(n.median)}  p95 ${fmt(n.p95)}  n=${n.count}`,
		`served: A ${S.stats.served.A}  B ${S.stats.served.B}  placeholder ${S.stats.served.C}  cold ${S.stats.served.cold}`,
		`tier A ${st.sharpA}/${st.A} (cap ${st.capacityA}, ${mb(st.bytesA)})   B ${st.B}/${st.count} (${mb(st.bytesB)}, ${S.codecType || '-'})   C ${st.C}/${st.count}`,
		`renders ${st.renders} (avg ${st.renders ? Math.round(st.renderMs / st.renders) : 0} ms)  canceled ${st.canceled}  failed ${st.failed}  decodes ${st.decodes}  busy ${st.busy || '-'}  repeats held back ${S.stats.dropped || 0}`,
		`resolution ${widthFor(S.page)} px  dpr ${S.dpr}  box ${Math.round(S.box.w)}x${Math.round(S.box.h)}  key changes ${st.keyChanges}  zoom renders ${S.stats.zoomRenders || 0}`,
		`pdf ${C.formatBytes(S.loaded)} / ${C.formatBytes(S.total)}   renderer ${S.deck.rendererWorker ? 'worker' : 'main thread'}   viewer ${VERSION}`,
	].join('\n');
}
function fmt(x) { return x == null ? '-' : x.toFixed(1) + ' ms'; }

window.__slidesStats = () => {
	const st = S.cache ? S.cache.stats() : {};
	return { version: VERSION, ...st, nav: { median: S.stats.nav.median, p95: S.stats.nav.p95, n: S.stats.nav.count }, served: { ...S.stats.served },
		last: S.stats.last, lastSharp: S.stats.lastSharp, width: S.cache ? widthFor(S.page) : null, dpr: S.dpr, mode: S.mode,
		renderer: S.deck ? (S.deck.rendererWorker ? 'worker' : 'main') : null, loaded: S.loaded, total: S.total, codec: S.codecType, page: S.page, count: S.count };
};
window.__slides = { go: p => go(p, { jump: true }), act, state: S };

// ================================================================== analytics
function countView() {
	// Goatcounter: the tab and present mode count as page views of
	// /slides/<id>; the embed counts an event (the host page already counted).
	// Other sites' PDFs and local files count as external / local: no
	// addresses or file names are sent.
	const id = S.meta && (S.meta.id || (S.meta.kind === 'url' ? 'external' : S.meta.kind === 'local' ? 'local' : S.opts.src)) || 'unknown';
	const send = () => {
		if (!window.goatcounter || !window.goatcounter.count) return false;
		const title = S.meta.id ? S.meta.title : 'Slide viewer: ' + id;
		if (S.mode === 'embed') window.goatcounter.count({ path: 'slides-open/' + id, title, event: true });
		else window.goatcounter.count({ path: '/slides/' + id + (S.mode === 'present' ? '/present' : ''), title });
		return true;
	};
	if (!send()) window.addEventListener('load', () => setTimeout(send, 500), { once: true });
}
