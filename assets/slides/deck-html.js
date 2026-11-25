/* deck-html.js -- an HTML deck as a deck for the viewer: the deck runs in an
 * iframe on the stage; deck-bridge.js inside it reports its structure and
 * position.  reveal.js decks need no bridge: the adapter below drives
 * Reveal directly (same origin), flattening vertical slides.
 *
 * Interface used by viewer.js (a subset of PdfDeck's, plus navigation):
 *   count, frames, outline, title, size(p), text(p), show(p, dir), onState(cb), reload()
 * See _tools/talks/DEVNOTES-html-decks.md.
 */
const NS = 'wi-deck';

export class HtmlDeck {
	/** Load `url` into `iframe`; resolves once the deck reported its structure. */
	static open(url, iframe, { page = 1, mode = 'tab', timeout = 15000 } = {}) {
		const d = new HtmlDeck(iframe, url);
		return d._load(page, mode, timeout).then(() => d);
	}

	constructor(iframe, url) {
		this.iframe = iframe;
		this.url = url;
		this.page = 1;
		this.cbs = [];
		this.rendererWorker = false;
		this.keyHandler = null;
	}

	_load(page, mode, timeout) {
		this._start = page;
		return new Promise((resolve, reject) => {
			let done = false;
			const finish = (err) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				if (err) reject(err); else resolve();
			};
			const timer = setTimeout(() => {
				// no bridge spoke up: maybe reveal.js
				if (this._tryReveal()) finish(); else finish(new Error('the deck did not report its slides (deck-bridge.js missing?)'));
			}, timeout);
			this._onMessage = e => {
				const m = e.data;
				if (e.source !== this.iframe.contentWindow || e.origin !== location.origin || !m || m.ns !== NS) return;
				if (m.type === 'ready') { this._structure(m); this.post({ type: 'shell', mode }); finish(); }
				else if (m.type === 'state') this._state(m.page);
				else if (m.type === 'key' && this.keyHandler) this.keyHandler(m);
			};
			window.addEventListener('message', this._onMessage);
			this.iframe.addEventListener('load', () => {
				// reveal.js decks have no bridge; give them a moment to initialize
				setTimeout(() => { if (!done && this._tryReveal()) finish(); }, 600);
			}, { once: true });
			this.iframe.src = this.url + '#page=' + page;
		});
	}

	_structure(m) {
		this.title = m.title || '';
		this.aspect = m.aspect && m.aspect[0] ? m.aspect : [16, 9];
		this.slides = m.slides || [];
		this.texts = m.text || [];
		this.keys = m.keys || [];
		this.frames = [];
		this.outline = [];
		let p = 1, sec = null;
		this.slides.forEach((s, i) => {
			const n = Math.max(1, s.steps | 0);
			this.frames.push({ label: String(i + 1), first: p, last: p + n - 1, title: s.title || null });
			if (s.section && s.section !== sec) this.outline.push({ level: 0, page: p, title: s.section, raw: s.section });
			sec = s.section || sec;
			p += n;
		});
		this.count = p - 1;
	}

	_state(page) {
		if (page === this.page) return;
		this.page = page;
		for (const cb of this.cbs) cb(page);
	}

	post(msg) {
		const w = this.iframe.contentWindow;
		if (this.reveal) return this._revealMsg(msg);
		if (w) w.postMessage(Object.assign({ ns: NS }, msg), location.origin);
	}

	/** The deck moved by itself (click inside it, its own keys). */
	onState(cb) { this.cbs.push(cb); }

	/** Go to page p; a single step forward/back is sent as next/prev so the
	 *  deck can animate it. */
	show(p, dir) {
		if (p === this.page) return;
		const step = p - this.page;
		this.page = p;
		if (step === 1) this.post({ type: 'next' });
		else if (step === -1) this.post({ type: 'prev' });
		else this.post({ type: 'goto', page: p, dir });
	}

	size() { return { w: this.aspect[0], h: this.aspect[1] }; }

	async text(p) {
		const fi = this.frames.findIndex(f => f.first <= p && p <= f.last);
		return fi >= 0 ? this.texts[fi] || '' : '';
	}

	reload() { this.iframe.src = this.url + '#page=' + this.page; }

	// ------------------------------------------------------------ reveal.js ---
	_tryReveal() {
		let w, R;
		try { w = this.iframe.contentWindow; R = w && w.Reveal; } catch (e) { return false; }
		if (!R || !R.getSlides || !(R.isReady ? R.isReady() : true)) return false;
		this.reveal = R;
		R.configure({ keyboard: false, hash: false, history: false, controls: false, progress: false, embedded: true });
		const slides = R.getSlides();
		const frag = el => {
			const idx = new Set([...el.querySelectorAll('.fragment')].map((f, i) => f.dataset.fragmentIndex != null ? f.dataset.fragmentIndex : 'n' + i));
			return idx.size;
		};
		this._rv = slides.map(el => ({ el, idx: R.getIndices(el), frags: frag(el) }));
		const cfg = R.getConfig ? R.getConfig() : {};
		this._structure({
			title: w.document.title,
			aspect: [cfg.width || 960, cfg.height || 700],
			slides: this._rv.map((s, i) => {
				const hd = s.el.querySelector('h1, h2, h3');
				return { title: s.el.dataset.title || (hd ? hd.textContent.trim() : ''), steps: s.frags + 1, id: 'r' + i };
			}),
			text: this._rv.map(s => s.el.textContent.replace(/\s+/g, ' ').trim()),
		});
		// vertical stacks become sections titled by their first slide
		let p = 1;
		this.outline = [];
		this._rv.forEach((s, i) => {
			if (s.idx.v === 0 && this._rv[i + 1] && this._rv[i + 1].idx.h === s.idx.h) this.outline.push({ level: 0, page: p, title: this.frames[i].title, raw: this.frames[i].title });
			p += s.frags + 1;
		});
		const report = () => {
			const ix = R.getIndices();
			const i = this._rv.findIndex(s => s.idx.h === ix.h && (s.idx.v || 0) === (ix.v || 0));
			if (i < 0) return;
			// step = number of fragment groups shown
			const shown = new Set([...this._rv[i].el.querySelectorAll('.fragment.visible')].map((x, k) => x.dataset.fragmentIndex != null ? x.dataset.fragmentIndex : 'n' + k)).size;
			this._state(this.frames[i].first + Math.min(shown, this.frames[i].last - this.frames[i].first));
		};
		for (const ev of ['slidechanged', 'fragmentshown', 'fragmenthidden', 'ready']) R.on(ev, report);
		// keys inside the deck go to the viewer
		w.addEventListener('keydown', e => {
			if (!this.keyHandler) return;
			e.preventDefault(); e.stopImmediatePropagation();
			this.keyHandler({ key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat });
		}, true);
		this.page = 0;
		if (this._start > 1) this._revealMsg({ type: 'goto', page: Math.min(this.count, this._start) });
		report();
		return true;
	}

	_revealMsg(msg) {
		const R = this.reveal;
		if (msg.type === 'next') return R.next();
		if (msg.type === 'prev') return R.prev();
		if (msg.type === 'goto') {
			const p = msg.page;
			const i = this.frames.findIndex(f => f.first <= p && p <= f.last);
			if (i < 0) return;
			const s = this._rv[i];
			R.slide(s.idx.h, s.idx.v || 0, p - this.frames[i].first - 1);
		}
	}
}
