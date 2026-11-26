/* deck-bridge.js -- lets an HTML deck run inside the slide viewer (/slides/)
 * and on its own.  See _tools/talks/DEVNOTES-html-decks.md.
 *
 * A deck includes this file (classic script, before its own script) and
 * attaches itself:
 *
 *     WiDeck.attach({
 *       info: () => WiDeck.fromDom('.slide'),   // or {slides: [{title, section, steps}], aspect: [16, 9], text: [...]}
 *       goto(slide, step, dir) { ... },         // show (slide, step), both 0-based, from any state
 *       next() { ... }, prev() { ... },         // optional: animated single steps
 *       keys: ['p', 'r'],                       // optional: keys the deck keeps inside the viewer
 *     });
 *     // and whenever the deck moves on its own (click, its own keys):
 *     WiDeck.changed(slide, step);
 *
 * Positions ("pages") are the steps of all slides in order, 1-based; the
 * standalone deck keeps `#page=N` in its address, like the viewer.
 *
 * Inside the viewer (framed by a page of the same site) the bridge
 *   - adds class `in-shell` to <html> (hide the deck's own hints and buttons),
 *   - sends `ready` (structure) and `state` (position) to the viewer,
 *   - forwards keys to the viewer, except `keys` (the viewer navigates; it
 *     sends the deck's `keys` back as `deckkey` when it has the focus itself),
 *   - obeys `goto` / `next` / `prev` from the viewer.
 * Messages: plain objects with ns: 'wi-deck'.
 * Standalone it counts the page view with Goatcounter (the deck's script tag
 * has no_onload, so the viewer's frame is not counted twice).
 */
(function () {
	'use strict';
	const NS = 'wi-deck';
	// Framed by a page of the same site -- or sandboxed by it (Markdown decks,
	// deck-md.html: iframe sandbox="allow-scripts", origin "null"; then the
	// parent's origin is unknown here and messages go to '*': they only carry
	// positions and the slides' text, which the parent shows anyway).
	const inFrame = window.parent !== window;
	const sandboxed = inFrame && self.origin === 'null';     // (location.origin is still the address's)
	let framed = sandboxed;
	try { framed = framed || (inFrame && window.parent.location.origin === location.origin); } catch (e) { /* another site's frame */ }
	const TARGET = sandboxed ? '*' : location.origin;

	let api = null, info = null, steps = [], starts = [], total = 0;
	let cur = { slide: 0, step: 0 }, lastSent = 0, replaying = false;

	function structure() {
		info = api.info() || {};
		info.slides = info.slides || [];
		steps = info.slides.map(s => Math.max(1, s.steps | 0 || 1));
		starts = [];
		total = 0;
		for (const n of steps) { starts.push(total + 1); total += n; }
	}
	/** (slide, step) -> page, 1-based */
	function pageOf(slide, step) {
		slide = Math.max(0, Math.min(steps.length - 1, slide | 0));
		return starts[slide] + Math.max(0, Math.min(steps[slide] - 1, step | 0));
	}
	/** page -> (slide, step) */
	function at(page) {
		page = Math.max(1, Math.min(total, page | 0));
		let s = 0;
		while (s + 1 < starts.length && starts[s + 1] <= page) s++;
		return { slide: s, step: page - starts[s] };
	}
	function hashPage() {
		const m = /^#(?:page=)?(\d+)$/.exec(location.hash);
		return m ? parseInt(m[1], 10) : 1;
	}
	function post(msg) {
		if (framed) window.parent.postMessage(Object.assign({ ns: NS }, msg), TARGET);
	}
	function sendReady() {
		post({
			type: 'ready', title: info.title || document.title, aspect: info.aspect || [16, 9],
			slides: info.slides.map((s, i) => ({ title: s.title || '', section: s.section || '', steps: steps[i], id: s.id || '', overflow: !!s.overflow })),
			text: info.text || info.slides.map(s => s.text || ''),
			keys: api.keys || [],
		});
	}
	function moved(slide, step, quiet) {
		cur = { slide, step };
		const p = pageOf(slide, step);
		if (framed) { if (p !== lastSent || !quiet) post({ type: 'state', page: p }); }
		else history.replaceState(history.state, '', location.pathname + location.search + '#page=' + p);
		lastSent = p;
	}
	function go(page, dir) {
		const t = at(page);
		const d = dir || (page >= pageOf(cur.slide, cur.step) ? 1 : -1);
		api.goto(t.slide, t.step, d);
		moved(t.slide, t.step, true);
	}

	window.WiDeck = {
		framed,
		attach(a) {
			api = a;
			structure();
			if (framed) document.documentElement.classList.add('in-shell');
			const start = at(hashPage());
			api.goto(start.slide, start.step, 1);
			cur = start;
			lastSent = pageOf(start.slide, start.step);
			if (framed) { sendReady(); post({ type: 'state', page: lastSent }); }
			else {
				history.replaceState(history.state, '', location.pathname + location.search + '#page=' + lastSent);
				count();
			}
		},
		/** The deck moved by itself (its own keys or clicks). */
		changed(slide, step) { if (api) moved(slide, step, true); },
		/** The structure changed (slides added, builds changed; a Markdown deck
		 *  re-rendered after its source changed): report it, stay at the same
		 *  position as far as it still exists. */
		refresh() {
			if (!api) return;
			const p = pageOf(cur.slide, cur.step);     // in the old structure
			structure();
			const t = at(Math.min(p, total));
			api.goto(t.slide, t.step, 1);
			cur = t;
			lastSent = pageOf(t.slide, t.step);
			sendReady();
			post({ type: 'state', page: lastSent });
		},
		pageOf, at,
		get page() { return pageOf(cur.slide, cur.step); },
		/** Structure from the DOM: <section class="slide" data-title data-section data-builds>. */
		fromDom(sel) {
			const els = [...document.querySelectorAll(sel || '.slide')];
			let sec = '';
			return {
				title: document.title,
				aspect: [16, 9],
				slides: els.map(e => {
					if (e.dataset.section != null) sec = e.dataset.section;
					const h = e.querySelector('h1, h2');
					return { id: e.id, title: e.dataset.title || (h ? h.textContent.replace(/\s+/g, ' ').trim() : ''), section: sec,
						steps: (+e.dataset.builds || 0) + 1, text: e.textContent.replace(/\s+/g, ' ').trim() };
				}),
			};
		},
	};

	// for _tools/talks/talks.py toc (manifest, thumbnail, PDF)
	window.__wiDeckInfo = () => api && {
		title: info.title || document.title, aspect: info.aspect || [16, 9],
		slides: info.slides.map((s, i) => ({ title: s.title || '', section: s.section || '', steps: steps[i] })),
		steps: steps.slice(), starts: starts.slice(),
	};

	// standalone: #page=N typed into the address bar
	window.addEventListener('hashchange', () => { if (api && !framed) go(hashPage()); });

	if (framed) {
		// keys go to the viewer, which navigates through goto/next/prev
		window.addEventListener('keydown', e => {
			if (!api || replaying) return;
			const t = e.target;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			const mod = e.ctrlKey || e.metaKey || e.altKey;
			if (!mod && (api.keys || []).includes(e.key.toLowerCase())) return;
			if (!mod || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) e.preventDefault();
			e.stopImmediatePropagation();
			post({ type: 'key', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat });
		}, true);
		window.addEventListener('message', e => {
			const m = e.data;
			if (!api || e.source !== window.parent || (!sandboxed && e.origin !== location.origin) || !m || m.ns !== NS) return;
			const p = pageOf(cur.slide, cur.step);
			if (m.type === 'goto') { if (m.page !== p) go(m.page, m.dir); }
			else if (m.type === 'next') { if (api.next) api.next(); else if (p < total) go(p + 1, 1); }
			else if (m.type === 'prev') { if (api.prev) api.prev(); else if (p > 1) go(p - 1, -1); }
			else if (m.type === 'shell') document.documentElement.dataset.shellMode = m.mode || '';
			else if (m.type === 'deckkey') {
				// one of the deck's own keys, pressed while the viewer had the focus
				replaying = true;
				try { window.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true, cancelable: true })); } finally { replaying = false; }
			}
		});
	}

	function count() {
		const send = () => {
			if (!window.goatcounter || !window.goatcounter.count) return false;
			window.goatcounter.count({ path: location.pathname, title: document.title });
			return true;
		};
		if (!send()) window.addEventListener('load', () => setTimeout(send, 300), { once: true });
	}
})();
