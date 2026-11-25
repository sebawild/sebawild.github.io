/* cache.js -- the three cache tiers and the render scheduler.
 *
 *   A  decoded bitmaps at stage resolution, a window around the current page
 *      (memory budget); drawing one is a single drawImage.
 *   B  compressed images (WebP/PNG blobs) at stage resolution, every page
 *      rendered so far; decoding one takes a few milliseconds, off the main
 *      thread.  Only in the slides tab and present mode.
 *   C  small thumbnails (blobs, 320 px wide) for the scrub preview, the
 *      overview and search hits.  Made from the same render as A/B.
 *
 * Nothing here knows PDF.js or the DOM: pages are rendered by an injected
 * `renderPage(page, width, signal) -> canvas`, images handled by an injected
 * `codec`.  _tools/talks/test/cache.test.mjs drives it with fakes.
 * See _tools/talks/DEVNOTES-viewer.md.
 */
import { tierATargets, prefetchOrder, closeEnough, capacityFor } from './core.js';

export class SlideCache {
	/**
	 * @param {object} o
	 * @param {number} o.count            number of pages
	 * @param {(page:number, width:number, signal:AbortSignal)=>Promise<any>} o.renderPage
	 *        renders a page at exactly `width` device pixels, resolves to a canvas
	 * @param {object} o.codec            {toBitmap(canvas), encode(canvas), thumb(canvas), decode(blob)}
	 * @param {(page:number)=>number} o.widthFor  required pixel width of a page now
	 * @param {number} [o.aspect]         height/width of a typical page (for the memory budget)
	 * @param {()=>number} [o.now]
	 */
	constructor(o) {
		this.count = o.count;
		this.renderPage = o.renderPage;
		this.codec = o.codec;
		this.widthFor = o.widthFor;
		this.aspect = o.aspect || 0.5625;   // height / width of a typical page
		this.now = o.now || (() => performance.now());
		this.onChange = o.onChange || (() => {});
		this.A = new Map();      // page -> {bmp, w}
		this.B = new Map();      // page -> {blob, w}
		this.C = new Map();      // page -> blob (width independent)
		this.current = 1;
		this.dir = 1;
		this.tierB = false;
		this.thumbs = false;
		this.budget = 256e6;
		this.jumpTargets = [];
		this.busy = null;        // {page, ctrl, promise, fg}
		this.quietUntil = 0;     // background (tier B) waits until then
		this.paused = false;     // e.g. hidden tab
		this.stopped = false;
		this.waiters = new Map(); // page -> [resolve]
		this.pendingB = new Set(); // encodes in flight
		this.pendingC = new Set();
		this.encoding = 0;
		this.st = { renders: 0, canceled: 0, failed: 0, decodes: 0, renderMs: 0, encodeMs: 0, keyChanges: 0, bytesB: 0, bytesC: 0 };
		this._timer = null;
	}

	// ------------------------------------------------------------ settings --
	configure({ tierB, thumbs, budget, jumpTargets } = {}) {
		if (tierB != null) this.tierB = tierB;
		if (thumbs != null) this.thumbs = thumbs;
		if (budget != null) this.budget = budget;
		if (jumpTargets) this.jumpTargets = jumpTargets;
		this.pump();
	}

	/** The required widths changed (resize, full screen, dpr).  Old entries
	 *  stay usable as placeholders until replaced; nothing is thrown away up
	 *  front.  Rebuild order: current page first, then A, then B. */
	geometryChanged() {
		this.st.keyChanges++;
		if (this.busy && !this.busy.fg) this.cancelBusy();
		this.pump();
	}

	capacity() {
		const w = this.widthFor(this.current);
		return capacityFor(this.budget, w, Math.round(w * this.aspect));
	}

	// ------------------------------------------------------------- queries --
	isSharp(entry, page) { return entry && closeEnough(entry.w, this.widthFor(page)); }

	/** Best thing to show for `page` right now, without waiting:
	 *  {kind:'A', bmp, sharp} | {kind:'B', blob, sharp} | {kind:'C', blob} | null */
	peek(page) {
		const a = this.A.get(page);
		if (a && this.isSharp(a, page)) return { kind: 'A', bmp: a.bmp, sharp: true };
		const b = this.B.get(page);
		if (b && this.isSharp(b, page)) return { kind: 'B', blob: b.blob, sharp: true };
		if (a) return { kind: 'A', bmp: a.bmp, sharp: false };
		if (b) return { kind: 'B', blob: b.blob, sharp: false };
		const c = this.C.get(page);
		if (c) return { kind: 'C', blob: c };
		return null;
	}

	thumb(page) { return this.C.get(page) || null; }

	// ------------------------------------------------------------- moving ---
	/** The user moved to `page`.  Re-targets the prefetch window. */
	focus(page, dir) {
		if (dir) this.dir = dir > 0 ? 1 : -1;
		this.current = page;
		this.quietUntil = this.now() + 150;
		// a background render far away from where we are now is not useful
		if (this.busy && !this.busy.fg && !this.targets().has(this.busy.page)) this.cancelBusy();
		this.evict();
		this.pump();
	}

	/** Wait until `page` is in tier A at the required width (renders it with
	 *  top priority if needed).  Resolves to the bitmap entry. */
	async ensure(page) {
		const a = this.A.get(page);
		if (a && this.isSharp(a, page)) return a;
		const b = this.B.get(page);
		if (b && this.isSharp(b, page)) {
			const w = b.w;
			const bmp = await this.codec.decode(b.blob);
			this.st.decodes++;
			this.putA(page, bmp, w);
			return this.A.get(page);
		}
		if (this.busy && this.busy.page !== page) this.cancelBusy();
		return new Promise(resolve => {
			const list = this.waiters.get(page) || [];
			list.push(resolve);
			this.waiters.set(page, list);
			this.pump();
		});
	}

	// --------------------------------------------------------- scheduling ---
	targets() {
		return tierATargets(this.current, this.count, this.dir, this.capacity(), this.jumpTargets);
	}

	/** Next job: {page, why} or null. */
	nextJob() {
		// 1. somebody is waiting for a page
		for (const p of this.waiters.keys()) return { page: p, why: 'fg' };
		// 2. tier A: exactly the pages eviction keeps (near pages first, then
		//    jump targets), so a page is never fetched only to be evicted again
		for (const p of this.targets()) {
			if (!this.isSharp(this.A.get(p), p)) {
				return { page: p, why: this.isSharp(this.B.get(p), p) ? 'decode' : 'A' };
			}
		}
		// 3. tier B (and C) for the whole deck, after a quiet moment
		if (this.tierB || this.thumbs) {
			if (this.now() < this.quietUntil) return { wait: this.quietUntil - this.now() };
			for (const p of prefetchOrder(this.current, this.count, this.dir, 3, 1)) {
				if (this.tierB && !this.isSharp(this.B.get(p), p) && !this.pendingB.has(p)) return { page: p, why: 'B' };
				if (!this.tierB && this.thumbs && !this.C.has(p) && !this.pendingC.has(p)) return { page: p, why: 'C' };
			}
		}
		return null;
	}

	pump() {
		if (this.stopped || this.busy || this._pumping) return;
		this._pumping = true;
		Promise.resolve().then(() => { this._pumping = false; this._run(); });
	}

	_run() {
		if (this.stopped || this.busy) return;
		if (this.paused && !this.waiters.size) return;
		const job = this.nextJob();
		if (!job) { this.onChange('idle'); return; }
		// background renders wait for the encoder to catch up (bounded memory)
		if (job.why === 'B' || job.why === 'C') { if (this.encoding >= 3) return; }
		if (job.wait != null) {
			clearTimeout(this._timer);
			this._timer = setTimeout(() => this.pump(), Math.max(10, job.wait));
			return;
		}
		const ctrl = new AbortController();
		const busy = { page: job.page, ctrl, fg: job.why === 'fg', why: job.why };
		this.busy = busy;
		busy.promise = this._do(job, ctrl.signal).catch(err => {
			if (err && err.name === 'AbortError' || ctrl.signal.aborted) this.st.canceled++;
			else { this.st.failed++; console.warn('slides: page', job.page, err); this._fail(job.page); }
		}).finally(() => {
			if (this.busy === busy) this.busy = null;
			this.pump();
		});
	}

	async _do(job, signal) {
		const p = job.page;
		if (job.why === 'decode') {
			const b = this.B.get(p);
			const bmp = await this.codec.decode(b.blob);
			this.st.decodes++;
			if (signal.aborted) { bmp.close && bmp.close(); throw abortError(); }
			this.putA(p, bmp, b.w);
			return;
		}
		const w = this.widthFor(p);
		const t0 = this.now();
		const canvas = await this.renderPage(p, w, signal);
		if (signal.aborted) throw abortError();
		this.st.renders++;
		this.st.renderMs += this.now() - t0;
		// what to keep from this render
		const wantA = job.why === 'fg' || job.why === 'A' || this.waiters.has(p) || this.targets().has(p);
		const wantB = this.tierB && !this.isSharp(this.B.get(p), p) && !this.pendingB.has(p);
		const wantC = (this.thumbs || this.tierB) && !this.C.has(p) && !this.pendingC.has(p);
		// Every codec call takes its copy of the pixels when it is called
		// (createImageBitmap, convertToBlob, drawImage), so the canvas is free
		// for the next render right away.  Encoding (the slow part) runs on
		// while the next page renders; only the bitmap for tier A is awaited.
		const t1 = this.now();
		const pA = wantA ? this.codec.toBitmap(canvas) : null;
		const bg = [];
		if (wantB) {
			this.pendingB.add(p);
			bg.push(this.codec.encode(canvas).then(blob => {
				const old = this.B.get(p);
				if (old) this.st.bytesB -= old.blob.size;
				this.B.set(p, { blob, w }); this.st.bytesB += blob.size;
			}).finally(() => this.pendingB.delete(p)));
		}
		if (wantC) {
			this.pendingC.add(p);
			bg.push(this.codec.thumb(canvas).then(blob => { this.C.set(p, blob); this.st.bytesC += blob.size; })
				.finally(() => this.pendingC.delete(p)));
		}
		if (this.codec.release) this.codec.release(canvas);
		if (bg.length) {
			this.encoding++;
			Promise.all(bg).catch(err => console.warn('slides: encode', p, err)).finally(() => {
				this.encoding--;
				this.st.encodeMs += this.now() - t1;
				this.onChange('page', p);
				this.pump();
			});
		}
		if (pA) this.putA(p, await pA, w);
		this.onChange('page', p);
	}

	_fail(page) {
		const list = this.waiters.get(page);
		if (list) { this.waiters.delete(page); for (const r of list) r(null); }
	}

	putA(page, bmp, w) {
		const old = this.A.get(page);
		if (old && old.bmp !== bmp && old.bmp.close) old.bmp.close();
		this.A.set(page, { bmp, w });
		const list = this.waiters.get(page);
		if (list && closeEnough(w, this.widthFor(page))) {
			this.waiters.delete(page);
			for (const r of list) r(this.A.get(page));
		}
		this.evict();
	}

	/** Keep tier A within capacity: drop stale entries first, then those
	 *  farthest from the current page that are not targets. */
	evict() {
		const cap = this.capacity();
		if (this.A.size <= cap) return;
		const keep = this.targets();
		const cand = [...this.A.keys()].filter(p => !keep.has(p) && !this.waiters.has(p));
		cand.sort((x, y) => {
			const sx = this.isSharp(this.A.get(x), x) ? 1 : 0, sy = this.isSharp(this.A.get(y), y) ? 1 : 0;
			if (sx !== sy) return sx - sy;                     // stale first
			return Math.abs(y - this.current) - Math.abs(x - this.current);   // far first
		});
		while (this.A.size > cap && cand.length) {
			const p = cand.shift();
			const e = this.A.get(p);
			if (e.bmp.close) e.bmp.close();
			this.A.delete(p);
		}
	}

	cancelBusy() {
		if (!this.busy || this.busy.fg) return;
		this.busy.ctrl.abort();
	}

	/** Drop everything (key `r`, or a new document). */
	clear() {
		this.cancelBusy();
		for (const e of this.A.values()) if (e.bmp.close) e.bmp.close();
		this.A.clear(); this.B.clear(); this.C.clear();
		this.st.bytesB = this.st.bytesC = 0;
		this.pump();
	}

	stop() { this.stopped = true; this.cancelBusy(); clearTimeout(this._timer); }

	// ------------------------------------------------------------- stats ----
	stats() {
		let sharpB = 0;
		for (const [p, b] of this.B) if (this.isSharp(b, p)) sharpB++;
		let sharpA = 0, bytesA = 0;
		for (const [p, a] of this.A) { if (this.isSharp(a, p)) sharpA++; bytesA += (a.bmp.width || 0) * (a.bmp.height || 0) * 4; }
		return {
			...this.st, count: this.count, A: this.A.size, sharpA, bytesA, capacityA: this.capacity(),
			B: sharpB, C: this.C.size, busy: this.busy ? this.busy.page + ':' + this.busy.why : null,
			warm: this.tierB ? sharpB / this.count : (this.thumbs ? this.C.size / this.count : sharpA / Math.min(this.count, this.capacity())),
		};
	}
}

function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
