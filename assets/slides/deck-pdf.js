/* deck-pdf.js -- a PDF as a deck: the only file that knows PDF.js.
 *
 * PDF.js is the vendored copy in /assets/pdfjs/v6 (_tools/vendor-pdfjs.py).
 * Pages are drawn by PDF.js's renderer worker where the browser can (PDF.js 6:
 * OffscreenCanvas + Worker), so rendering does not block the main thread;
 * otherwise PDF.js renders on the main thread in small chunks.  `?worker=0`
 * forces the main-thread path (for comparisons, see TESTING.md).
 *
 * Interface used by viewer.js (a future render-pdfium.js would provide the same):
 *   PdfDeck.open(url, {onProgress}) -> deck
 *   deck.count, deck.size(p) -> {w, h} in PDF units
 *   deck.renderPage(p, widthPx, signal) -> OffscreenCanvas   (also used by cache.js)
 *   deck.renderRegion(p, scale, offX, offY, w, h, signal) -> canvas  (zoom)
 *   deck.labels(), deck.outline(), deck.text(p), deck.links(p), deck.textLayer(p, el, scale)
 */

export const PDFJS_BASE = '/assets/pdfjs/v6/';
let libPromise = null;

export function loadPdfjs(opts = {}) {
	if (!libPromise) {
		libPromise = import(PDFJS_BASE + 'build/pdf.min.mjs').then(lib => {
			lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.mjs';
			if (opts.rendererWorker !== false && typeof OffscreenCanvas !== 'undefined') {
				lib.GlobalWorkerOptions.rendererSrc = PDFJS_BASE + 'build/pdf.renderer.min.mjs';
			}
			return lib;
		});
	}
	return libPromise;
}

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
function makeCanvas(w, h) {
	if (hasOffscreen) return new OffscreenCanvas(w, h);
	const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export class PdfDeck {
	static async open(url, { onProgress, sizes, rendererWorker, load = 'range', data = null } = {}) {
		const lib = await loadPdfjs({ rendererWorker });
		// load = 'range': only range requests, in the order pages are needed
		//   (the background warm-up then pulls the rest page by page);
		// load = 'stream': PDF.js default, one full download alongside ranges.
		// data: the bytes of a local PDF (open.js); no network then.
		const task = lib.getDocument({
			...(data ? { data } : { url }),
			rangeChunkSize: load === 'range' ? 393216 : 262144,
			disableStream: load === 'range',
			disableAutoFetch: load === 'range',
			enableScripting: false,
			isEvalSupported: false,
			cMapUrl: PDFJS_BASE + 'cmaps/',
			cMapPacked: true,
			standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
			wasmUrl: PDFJS_BASE + 'wasm/',
			iccUrl: PDFJS_BASE + 'iccs/',
		});
		if (onProgress) task.onProgress = p => onProgress(p.loaded, p.total);
		const doc = await task.promise;
		return new PdfDeck(lib, doc, task, sizes);
	}

	constructor(lib, doc, task, sizes) {
		this.lib = lib;
		this.doc = doc;
		this.task = task;
		this.count = doc.numPages;
		this.pages = new Map();           // page number -> PDFPageProxy (kept: cheap)
		this._sizes = new Map();
		if (sizes && sizes.aspect) {
			this.defaultSize = { w: sizes.aspect[0], h: sizes.aspect[1] };
			for (const [p, w, h] of sizes.odd || []) this._sizes.set(p, { w, h });
		}
		this.scratch = null;
		this.rendererWorker = !!lib.GlobalWorkerOptions.rendererSrc;
	}

	async page(p) {
		let pg = this.pages.get(p);
		if (!pg) {
			pg = await this.doc.getPage(p);
			this.pages.set(p, pg);
			const v = pg.getViewport({ scale: 1 });
			this._sizes.set(p, { w: v.width, h: v.height });
			if (!this.defaultSize) this.defaultSize = { w: v.width, h: v.height };
		}
		return pg;
	}

	/** Page size in PDF units; before a page was opened, the deck's usual size. */
	size(p) { return this._sizes.get(p) || this.defaultSize || { w: 4, h: 3 }; }

	/** Render page `p` exactly `width` device pixels wide into a scratch
	 *  canvas, which the caller must be done with before the next render
	 *  (cache.js awaits its encoders first). */
	async renderPage(p, width, signal) {
		const pg = await this.page(p);
		if (signal && signal.aborted) throw abort();
		const v1 = pg.getViewport({ scale: 1 });
		const vp = pg.getViewport({ scale: width / v1.width });
		const w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
		const c = this.scratch && hasOffscreen ? this.scratch : makeCanvas(w, h);
		if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
		this.scratch = c;
		await this._render(pg, c, vp, signal);
		return c;
	}

	/** For zoom: render the region of page `p` at `scale` (device pixels per
	 *  PDF unit) whose top-left is at offX/offY (device px), into a w×h canvas. */
	async renderRegion(p, scale, offX, offY, w, h, signal) {
		const pg = await this.page(p);
		const vp = pg.getViewport({ scale, offsetX: offX, offsetY: offY });
		const c = makeCanvas(w, h);
		await this._render(pg, c, vp, signal);
		return c;
	}

	async _render(pg, canvas, viewport, signal) {
		const task = pg.render({ canvas, viewport });
		const onAbort = () => task.cancel();
		if (signal) signal.addEventListener('abort', onAbort, { once: true });
		try {
			await task.promise;
		} catch (e) {
			if (e && (e.name === 'RenderingCancelledException' || (signal && signal.aborted))) throw abort();
			throw e;
		} finally {
			if (signal) signal.removeEventListener('abort', onAbort);
		}
	}

	async labels() {
		try { return await this.doc.getPageLabels(); } catch (e) { return null; }
	}

	/** Bookmarks, flattened: [{level, raw, page}] (titles cleaned by the caller). */
	async outline() {
		const out = [];
		let items;
		try { items = await this.doc.getOutline(); } catch (e) { return out; }
		const walk = async (list, level) => {
			for (const it of list || []) {
				const page = await this.destPage(it.dest);
				if (page) out.push({ level, raw: it.title, page });
				if (it.items && it.items.length) await walk(it.items, level + 1);
			}
		};
		await walk(items, 0);
		return out;
	}

	async destPage(dest) {
		try {
			if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
			if (!Array.isArray(dest) || !dest.length) return null;
			const ref = dest[0];
			if (typeof ref === 'number') return ref + 1;
			return (await this.doc.getPageIndex(ref)) + 1;
		} catch (e) { return null; }
	}

	async text(p) {
		const pg = await this.page(p);
		const tc = await pg.getTextContent();
		return tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join(' ');
	}

	/** A title read off page p (largest text near the top), or null. */
	async titleGuess(p, guess) {
		const pg = await this.page(p);
		const tc = await pg.getTextContent();
		return guess(tc.items, pg.getViewport({ scale: 1 }).height);
	}

	/** Link annotations: [{rect:[x0,y0,x1,y1] in PDF units, url|page}]. */
	async links(p) {
		const pg = await this.page(p);
		const anns = await pg.getAnnotations({ intent: 'display' });
		const out = [];
		for (const a of anns) {
			if (a.subtype !== 'Link') continue;
			if (a.url || a.unsafeUrl) out.push({ rect: a.rect, url: a.url || a.unsafeUrl });
			else if (a.dest) { const page = await this.destPage(a.dest); if (page) out.push({ rect: a.rect, page }); }
		}
		return { links: out, view: pg.view };
	}

	/** PDF.js text layer for page p into `el`, at `scale` CSS px per PDF unit. */
	async textLayer(p, el, scale) {
		const pg = await this.page(p);
		const vp = pg.getViewport({ scale });
		el.textContent = '';
		el.style.setProperty('--total-scale-factor', String(scale));
		el.style.setProperty('--scale-round-x', '1px');
		el.style.setProperty('--scale-round-y', '1px');
		const tl = new this.lib.TextLayer({ textContentSource: pg.streamTextContent(), container: el, viewport: vp });
		await tl.render();
		return tl;
	}

	destroy() { try { this.task.destroy(); } catch (e) { /* ignore */ } }
}

function abort() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
