/* core.js -- the pure parts of the slide viewer: no DOM, no PDF.js.
 *
 * Everything here is tested in Node (_tools/talks/test/core.test.mjs).
 * See _tools/talks/DEVNOTES-viewer.md for how the pieces fit together.
 */

// ---------------------------------------------------------------- URL --------

/** Parse location.search + location.hash into the viewer's options.
 *  Positions are 1-based.  Accepts `#page=N`, `#N`, Chrome's `#page=N&zoom=..`. */
export function parseLocation(search, hash) {
	const q = new URLSearchParams(search || '');
	const o = {
		t: q.get('t') || null,
		src: q.get('src') || null,
		url: q.get('url') || null,          // a PDF anywhere on the web
		local: q.get('local') || null,      // a PDF from this computer, kept in IndexedDB (open.js)
		md: q.get('md') || null,
		gslides: q.get('gslides') || null,
		theme: q.get('theme') || null,      // Markdown slides: wi | black | white (md.js)
		live: q.has('live') ? Math.max(3, parseFloat(q.get('live')) || 10) : null,   // Markdown slides: re-read every N s
		mode: q.has('present') ? 'present' : q.has('embed') ? 'embed' : 'tab',
		builds: q.get('builds') === '0' ? false : true,
		scale: q.has('scale') ? Math.max(0.5, Math.min(4, parseFloat(q.get('scale')) || 1)) : null,
		page: parsePageHash(hash),
	};
	return o;
}

export function parsePageHash(hash) {
	if (!hash) return null;
	const h = hash.replace(/^#/, '');
	if (/^\d+$/.test(h)) return Math.max(1, parseInt(h, 10));
	const p = new URLSearchParams(h).get('page');
	if (p && /^\d+$/.test(p)) return Math.max(1, parseInt(p, 10));
	return null;
}

export function pageHash(page) { return '#page=' + page; }

/** Same-origin check for ?src= (only paths on this site are allowed). */
export function safeSrc(src, origin) {
	if (!src) return null;
	try {
		const u = new URL(src, origin);
		if (u.origin !== origin) return null;
		if (!/\.pdf$/i.test(u.pathname)) return null;
		return u.pathname + u.search;
	} catch (e) { return null; }
}

/** An external PDF URL: http(s) only, normalized; null otherwise. */
export function safeExternal(url) {
	if (!url) return null;
	try {
		const u = new URL(url.trim());
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		u.hash = '';
		return u.href;
	} catch (e) { return null; }
}

/** Google Slides: the presentation id from an id or any docs.google.com
 *  presentation URL (/edit, /view, /present, ?usp=sharing ...); null if none.
 *  "Published to the web" links (/d/e/2PACX-...) have no export: null. */
export function gslidesId(s) {
	if (!s) return null;
	s = String(s).trim();
	if (/^[\w-]{25,}$/.test(s)) return s;
	const m = /^https?:\/\/docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/([\w-]{25,})(?:[/?#]|$)/.exec(s);
	return m ? m[1] : null;
}

/** The live PDF export of a Google Slides presentation (needs sharing set to
 *  "anyone with the link"); Google allows other pages to read it (CORS). */
export function gslidesPdf(id) { return 'https://docs.google.com/presentation/d/' + id + '/export/pdf'; }

/** A slide title from a page's text items (PDF.js getTextContent items, PDF
 *  units, y upwards): the largest text in the top 35% of the page, joined
 *  along its line.  For PDFs without bookmarks (Google Slides exports). */
export function guessTitle(items, pageHeight) {
	const top = pageHeight * 0.65;
	let best = 0;
	for (const it of items) {
		const size = Math.abs(it.transform ? it.transform[3] : 0);
		if (it.str && it.str.trim() && it.transform[5] >= top && size > best) best = size;
	}
	if (!best) return null;
	const line = items.filter(it => it.str && Math.abs(Math.abs(it.transform[3]) - best) < 0.5 && it.transform[5] >= top);
	if (!line.length) return null;
	const y0 = Math.max(...line.map(it => it.transform[5]));
	const t = line.filter(it => Math.abs(it.transform[5] - y0) < best * 1.6)
		.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
		.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
	return /[^\W\d_]{2}/u.test(t) ? t.slice(0, 90) : null;
}

/** A readable name for a PDF from its URL or file name. */
export function pdfName(s) {
	try { s = decodeURIComponent(new URL(s).pathname.split('/').pop() || new URL(s).hostname); } catch (e) { s = String(s || ''); }
	return s.replace(/\.pdf$/i, '').replace(/[_+]+/g, ' ').trim() || 'Slides';
}

// ------------------------------------------------------------- frames --------

/** Group pages into frames: maximal runs of consecutive pages with the same
 *  page label.  Without labels every page is its own frame. */
export function framesFromLabels(labels, count) {
	const frames = [];
	for (let p = 1; p <= count; p++) {
		const lab = labels && labels[p - 1] != null ? String(labels[p - 1]) : null;
		const last = frames[frames.length - 1];
		if (last && lab !== null && last.label === lab) last.last = p;
		else frames.push({ label: lab !== null ? lab : String(p), first: p, last: p });
	}
	return frames;
}

/** Index of the frame containing `page` (binary search). */
export function frameIndex(frames, page) {
	let lo = 0, hi = frames.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (frames[mid].first <= page) lo = mid; else hi = mid - 1;
	}
	return lo;
}

/** Strip the numbering Sebastian's Beamer theme puts into bookmark titles:
 *  "§1 - Introduction", "12 - Polyamory", "(2) Multiway Merging". */
export function cleanTitle(raw) {
	if (raw == null) return '';
	let t = String(raw).replace(/\s+/g, ' ').trim();
	t = t.replace(/^§\s*\d+\s*[-–—:.]\s*/, '');
	t = t.replace(/^\d+\s*[-–—:](\s+|$)/, '');
	t = t.replace(/^\(\d+\)\s*/, '');
	// Beamer \alt<2>{conjecture}{Conjecture} in a frame title puts both
	// variants into the bookmark: "conjectureConjecture" -> "Conjecture"
	t = t.replace(/\b([a-z][\w-]{2,})([A-Z][\w-]{2,})\b/g, (m, a, b) => a.toLowerCase() === b.toLowerCase() ? b : m);
	return t.trim();
}

/** Build the table of contents from a flattened outline [{level, title, page}]
 *  and the frames.  Returns {sections: [{title, page, frames: [frameIdx]}],
 *  frameTitle: [title|null per frame]}.  Level-0 entries are sections; deeper
 *  entries name frames.  Without an outline: one pseudo-section. */
export function buildToc(outline, frames) {
	const frameTitle = frames.map(f => f.title || null);
	const items = (outline || []).filter(o => o.page >= 1).map(o => ({
		level: o.level || 0, page: o.page, title: o.title != null ? o.title : cleanTitle(o.raw),
	}));
	const minLevel = items.length ? Math.min(...items.map(o => o.level)) : 0;
	const hasDeeper = items.some(o => o.level > minLevel);
	const sections = [];
	for (const o of items) {
		const fi = frameIndex(frames, o.page);
		if (o.level === minLevel && hasDeeper) {
			sections.push({ title: o.title, page: o.page, first: fi, frames: [] });
		} else if (frameTitle[fi] == null) {
			frameTitle[fi] = o.title;
		}
		if (!hasDeeper) {
			// flat outline (older decks): entries are sections *and* name their first frame
			sections.push({ title: o.title, page: o.page, first: fi, frames: [] });
		}
	}
	if (!sections.length) sections.push({ title: null, page: 1, first: 0, frames: [] });
	if (sections[0].first > 0) sections.unshift({ title: null, page: 1, first: 0, frames: [] });
	for (let i = 0; i < sections.length; i++) {
		const end = i + 1 < sections.length ? sections[i + 1].first : frames.length;
		for (let f = sections[i].first; f < end; f++) sections[i].frames.push(f);
		// several sections starting on one page (papers: §2 and §3 on page 5):
		// each still has that frame, so every section is reachable and non-empty
		if (!sections[i].frames.length && sections[i].first < frames.length) sections[i].frames.push(sections[i].first);
	}
	return { sections: sections.filter(s => s.frames.length || s.title), frameTitle };
}

export function sectionIndex(toc, frameIdx) {
	let s = 0;
	for (let i = 0; i < toc.sections.length; i++) if (toc.sections[i].first <= frameIdx) s = i;
	return s;
}

// --------------------------------------------------------- navigation --------

/** The positions one can stop at: every page, or only the last page of each
 *  frame ("hide build steps"). */
export function stops(frames, count, builds) {
	if (builds) return null;           // every page
	return frames.map(f => f.last);
}

/** Move from `page` by `action`.  Returns the new page (1..count). */
export function navigate(page, action, frames, count, builds) {
	const clamp = p => Math.max(1, Math.min(count, p));
	const fi = frameIndex(frames, page);
	const f = frames[fi];
	switch (action) {
		case 'next':
			if (builds) return clamp(page + 1);
			return fi + 1 < frames.length ? frames[fi + 1].last : f.last;
		case 'prev':
			if (builds) return clamp(page - 1);
			if (page !== f.last) return f.last;              // landed mid-frame: snap
			return fi > 0 ? frames[fi - 1].last : f.last;
		case 'nextFrame':
			return fi + 1 < frames.length ? (builds ? frames[fi + 1].first : frames[fi + 1].last) : count;
		case 'prevFrame':
			if (builds && page !== f.first) return fi > 0 ? frames[fi - 1].last : 1;
			return fi > 0 ? frames[fi - 1].last : 1;
		case 'frameEnd': return f.last;
		case 'frameStart': return f.first;
		case 'first': return builds ? 1 : frames[0].last;
		case 'last': return count;
		default: return page;
	}
}

/** Snap a page to a stop when build steps are hidden. */
export function snap(page, frames, builds) {
	if (builds) return page;
	return frames[frameIndex(frames, page)].last;
}

// ----------------------------------------------------------- geometry --------

/** Largest rectangle of the page's aspect ratio inside the box (CSS px). */
export function fit(boxW, boxH, pageW, pageH) {
	if (boxW <= 0 || boxH <= 0) return { w: 0, h: 0 };
	const s = Math.min(boxW / pageW, boxH / pageH);
	return { w: pageW * s, h: pageH * s };
}

/** Pixel width to render a page at: fitted width × device pixel ratio
 *  (capped), rounded, at most maxPx on the longer side. */
export function renderWidth(fitW, fitH, dpr, maxPx) {
	let w = Math.round(fitW * dpr), h = Math.round(fitH * dpr);
	const m = Math.max(w, h);
	if (m > maxPx) { w = Math.round(w * maxPx / m); h = Math.round(h * maxPx / m); }
	return Math.max(1, w);
}

/** A cached bitmap of width `have` still serves a required width `want` when
 *  they differ by at most `tol` (relative).  Keeps small window drags and
 *  browser-bar changes from throwing the cache away. */
export function closeEnough(have, want, tol = 0.015) {
	return have > 0 && Math.abs(have - want) <= tol * want;
}

// -------------------------------------------------------- scheduling ---------

/** Order in which to make pages ready around `current`, moving in `dir`
 *  (+1 / -1): `ahead` pages in the direction of travel, `behind` against it,
 *  then alternating outwards with a 3:1 bias in the direction of travel. */
export function prefetchOrder(current, count, dir, ahead = 3, behind = 1, limit = Infinity) {
	const out = [];
	const add = p => { if (p >= 1 && p <= count && !out.includes(p) && out.length < limit) out.push(p); };
	add(current);
	for (let i = 1; i <= ahead; i++) add(current + dir * i);
	for (let i = 1; i <= behind; i++) add(current - dir * i);
	let a = ahead + 1, b = behind + 1;
	while (out.length < Math.min(count, limit)) {
		const before = out.length;
		for (let k = 0; k < 3; k++) add(current + dir * a++);
		add(current - dir * b++);
		if (out.length === before && (current + dir * a > count + 3 || current + dir * a < -3)
			&& (current - dir * b > count + 3 || current - dir * b < -3)) break;
	}
	return out;
}

/** Which pages tier A (decoded bitmaps) should hold: the pages around the
 *  current one in prefetch order, plus jump targets (first page of the next
 *  and previous slide or section), which get up to a quarter of the room. */
export function tierATargets(current, count, dir, capacity, jumpTargets = []) {
	const jumps = jumpTargets.filter(p => p >= 1 && p <= count);
	const reserve = Math.min(jumps.length, Math.floor(capacity / 4));
	const set = new Set(prefetchOrder(current, count, dir, 3, 1, capacity - reserve));
	for (const p of jumps) { if (set.size >= capacity) break; set.add(p); }
	for (const p of prefetchOrder(current, count, dir, 3, 1, capacity)) { if (set.size >= capacity) break; set.add(p); }
	return set;
}

/** Number of bitmaps that fit a memory budget (bytes) at w×h. */
export function capacityFor(budget, w, h, min = 3) {
	return Math.max(min, Math.floor(budget / Math.max(1, w * h * 4)));
}

// ------------------------------------------------------------ search ---------

/** Normalize text for matching: lower case, accents and ligatures folded,
 *  whitespace collapsed, soft hyphens removed. */
export function normalize(s) {
	return String(s || '')
		.normalize('NFKD').replace(/[̀-ͯ­]/g, '')
		.toLowerCase().replace(/[‐-―−]/g, '-')
		.replace(/\s+/g, ' ').trim();
}

/** Search all page texts; one hit per frame (overlay pages repeat their
 *  text): the first page of the frame where the query occurs.  Every word of
 *  the query must occur on the page.  Returns [{frame, page, snippet}]. */
export function search(texts, query, frames, max = 200) {
	const q = normalize(query);
	if (!q) return [];
	const words = q.split(' ');
	const hits = [];
	for (let fi = 0; fi < frames.length && hits.length < max; fi++) {
		const f = frames[fi];
		for (let p = f.first; p <= f.last; p++) {
			const t = texts[p - 1];
			if (t == null) continue;
			if (words.every(w => t.includes(w))) {
				const i = t.indexOf(words[0]);
				const a = Math.max(0, i - 40), b = Math.min(t.length, i + words[0].length + 60);
				hits.push({ frame: fi, page: p, snippet: (a ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : ''), at: i - a + (a ? 1 : 0), len: words[0].length });
				break;
			}
		}
	}
	return hits;
}

// -------------------------------------------------------------- keys ---------

/** The key map, one table for handling and for the help sheet.  `modes`:
 *  e = embed, t = slides-only tab, p = present.  Keys reveal.js defines keep
 *  reveal's meaning (H/L as left/right; J/K as next/previous for vim habits). */
export const KEYS = [
	{ keys: ['ArrowRight', ' ', 'PageDown', 'n', 'Enter', 'j', 'l'], action: 'next', help: 'next page', modes: 'etp' },
	{ keys: ['ArrowLeft', 'PageUp', 'p', 'Backspace', 'k', 'h'], action: 'prev', help: 'previous page', modes: 'etp' },
	{ keys: ['ArrowDown'], action: 'nextFrame', help: 'next slide (skip build steps)', modes: 'etp' },
	{ keys: ['ArrowUp'], action: 'prevFrame', help: 'previous slide', modes: 'etp' },
	{ keys: ['Shift+ArrowRight'], action: 'frameEnd', help: 'last build step of this slide', modes: 'etp' },
	{ keys: ['Shift+ArrowLeft'], action: 'frameStart', help: 'first build step of this slide', modes: 'etp' },
	{ keys: ['Home'], action: 'first', help: 'first page', modes: 'etp' },
	{ keys: ['End'], action: 'last', help: 'last page', modes: 'etp' },
	{ keys: ['g'], action: 'goto', help: 'go to page (or type the number, then Enter)', modes: 'tp' },
	{ keys: ['f'], action: 'fullscreen', help: 'full screen', modes: 'etp' },
	{ keys: ['o'], action: 'overview', help: 'overview of all slides', modes: 'tp' },
	{ keys: ['t'], action: 'toc', help: 'contents', modes: 'etp' },
	{ keys: ['/', 'Ctrl+f'], action: 'search', help: 'search the slides', modes: 'tp' },
	{ keys: ['u'], action: 'builds', help: 'hide / show build steps', modes: 'etp' },
	{ keys: ['s'], action: 'theme', help: 'Markdown slides: next look (the site’s, white on black, black on white)', modes: 'tp' },
	{ keys: ['+', '='], action: 'zoomIn', help: 'zoom in', modes: 'etp' },
	{ keys: ['-'], action: 'zoomOut', help: 'zoom out', modes: 'etp' },
	{ keys: ['0'], action: 'zoomFit', help: 'fit (when no number is being typed)', modes: 'etp' },
	{ keys: ['z'], action: 'zoomKeep', help: 'keep zoom when changing pages', modes: 'etp' },
	{ keys: ['m'], action: 'mode', help: 'switch between slides tab and present mode', modes: 'tp' },
	{ keys: ['b', '.'], action: 'black', help: 'black screen', modes: 'p' },
	{ keys: ['w'], action: 'white', help: 'white screen', modes: 'p' },
	{ keys: ['c'], action: 'clock', help: 'clock and elapsed time', modes: 'p' },
	{ keys: ['x'], action: 'laser', help: 'pointer as a red dot', modes: 'p' },
	{ keys: ['i'], action: 'info', help: 'show / hide the warm-up note', modes: 'p' },
	{ keys: ['d'], action: 'hud', help: 'performance display', modes: 'tp' },
	{ keys: ['r'], action: 'rerender', help: 'drop the cache and render again', modes: 'tp' },
	{ keys: ['?'], action: 'help', help: 'this help', modes: 'etp' },
	{ keys: ['Escape'], action: 'escape', help: 'close panel / leave full screen', modes: 'etp' },
];

/** Canonical name of a keyboard event: "Shift+ArrowRight", "Ctrl+f", "?". */
export function keyName(e) {
	let k = e.key;
	if (k === 'Spacebar') k = ' ';
	if (k.length === 1 && k !== ' ') k = k.toLowerCase();
	if (k === '?' || k === '+' || k === '/') return k;          // shifted characters: no prefix
	const mods = [];
	if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
	if (e.altKey) mods.push('Alt');
	if (e.shiftKey && k.length > 1) mods.push('Shift');
	return (mods.length ? mods.join('+') + '+' : '') + k;
}

export function actionFor(name, mode) {
	const m = mode === 'embed' ? 'e' : mode === 'present' ? 'p' : 't';
	for (const row of KEYS) if (row.keys.includes(name) && row.modes.includes(m)) return row.action;
	return null;
}

// ------------------------------------------------------------- misc ----------

export function formatBytes(n) {
	if (n == null) return '';
	if (n < 1e6) return Math.round(n / 1e3) + ' kB';
	return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB';
}

/** Running statistics for the HUD: median and p95 of the last n samples. */
export class Stats {
	constructor(n = 200) { this.n = n; this.a = []; }
	add(x) { this.a.push(x); if (this.a.length > this.n) this.a.shift(); }
	q(p) {
		if (!this.a.length) return null;
		const s = [...this.a].sort((x, y) => x - y);
		return s[Math.min(s.length - 1, Math.floor(p * s.length))];
	}
	get median() { return this.q(0.5); }
	get p95() { return this.q(0.95); }
	get count() { return this.a.length; }
}
