/* open.js -- slides that are not talks of this site: any PDF by URL, or a
 * PDF from this computer.  Used by viewer.js.
 *
 *   /slides/                          start screen: drop a PDF, choose one, paste a link, recent ones
 *   /slides/?url=https://…/x.pdf      a PDF on another site
 *   /slides/?local=KEY                a PDF from this computer, kept in this browser (IndexedDB)
 *
 * Other sites' PDFs: the browser may only read them if that site allows it
 * (CORS; arXiv and GitHub do, many university pages do not).  If not, the
 * viewer offers to download the PDF and drop it in.
 *
 * Local PDFs never leave the computer: they are kept in IndexedDB (the three
 * most recent), so a reload or the present-mode URL keeps working.
 */
import * as C from './core.js';

const DB = 'wi-slides', STORE = 'files', KEEP = 3;
const RECENT_KEY = 'wi-slides-recent', RECENT_MAX = 8;

// ------------------------------------------------------------ local files ----
function db() {
	return new Promise((res, rej) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
}
function tx(mode, fn) {
	return db().then(d => new Promise((res, rej) => {
		const t = d.transaction(STORE, mode);
		const out = fn(t.objectStore(STORE));
		t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
		t.onerror = () => rej(t.error);
	}));
}

/** Keep a dropped/chosen PDF; returns its key.  The same file (name, size,
 *  date) gets the same key, so opening it again does not store it twice. */
export async function storeLocal(file) {
	const key = (file.name + '-' + file.size + '-' + (file.lastModified || 0)).replace(/[^\w.-]+/g, '_').slice(-120);
	const rec = { key, name: file.name, size: file.size, opened: Date.now(), blob: file };
	await tx('readwrite', s => s.put(rec));
	const all = await listLocal();
	for (const old of all.slice(KEEP)) await tx('readwrite', s => s.delete(old.key));
	return key;
}

export async function getLocal(key) {
	const rec = await tx('readonly', s => s.get(key));
	if (rec) tx('readwrite', s => s.put({ ...rec, opened: Date.now() })).catch(() => {});
	return rec || null;
}

export async function listLocal() {
	try {
		const all = await tx('readonly', s => s.getAll());
		return (all || []).sort((a, b) => b.opened - a.opened);
	} catch (e) { return []; }
}

export async function forgetLocal(key) { await tx('readwrite', s => s.delete(key)); }

// ------------------------------------------------------------ recent URLs ----
export function recentUrls() {
	try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
}
export function rememberUrl(url, title) {
	try {
		const list = recentUrls().filter(r => r.url !== url);
		list.unshift({ url, title, at: Date.now() });
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
	} catch (e) { /* storage unavailable: fine */ }
}
export function forgetUrl(url) {
	try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentUrls().filter(r => r.url !== url))); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------- other sites ---
/** Can this page read the PDF at `url`?  'ok', 'blocked' (CORS or network),
 *  'notpdf', or 'http NNN'. */
export async function probe(url) {
	let r;
	try {
		r = await fetch(url, { headers: { Range: 'bytes=0-1023' }, mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(20000) });
	} catch (e) { return e && e.name === 'TimeoutError' ? 'timeout' : 'blocked'; }
	if (!r.ok) return 'http ' + r.status;
	const b = new Uint8Array(await r.arrayBuffer());
	const head = String.fromCharCode(...b.slice(0, 1024));
	return head.includes('%PDF-') ? 'ok' : 'notpdf';
}

/** Meta for the viewer (the shape of /talks/ID.json) for ?url= / ?local=. */
export async function externalMeta(o) {
	if (o.local) {
		const rec = await getLocal(o.local);
		if (!rec) throw Object.assign(new Error('This PDF is no longer kept in this browser (only the last ' + KEEP + ' are).'), { kind: 'local' });
		const u = URL.createObjectURL(rec.blob);
		return { id: null, kind: 'local', title: C.pdfName(rec.name), page: null, publications: [], local: rec,
			slides: { kind: 'pdf', url: u, download: u, downloadName: rec.name, bytes: rec.size } };
	}
	const url = C.safeExternal(o.url);
	if (!url) throw Object.assign(new Error('Not a web address: ' + o.url), { kind: 'url' });
	if (new URL(url).origin === location.origin) {
		const path = new URL(url).pathname;
		return { id: null, kind: 'site', title: C.pdfName(url), page: null, publications: [], slides: { kind: 'pdf', url: path, download: path } };
	}
	const meta = { id: null, kind: 'url', title: C.pdfName(url), page: null, publications: [], source: url,
		slides: { kind: 'pdf', url, download: url } };
	const direct = await probe(url);
	if (direct === 'ok') return meta;
	if (direct === 'blocked') throw Object.assign(new Error('The site that hosts this PDF does not let other pages read it.'), { kind: 'cors', url });
	throw Object.assign(new Error(direct === 'notpdf' ? 'That address does not lead to a PDF.' : direct === 'timeout' ? 'The site did not answer in time.' : 'The PDF could not be fetched (' + direct + ').'), { kind: 'url', url });
}

// --------------------------------------------------------- opening things ----
export async function openFile(file, mode) {
	if (!file) return;
	if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { alertBox('Not a PDF: ' + file.name); return; }
	const key = await storeLocal(file);
	location.href = '/slides/?local=' + encodeURIComponent(key) + (mode === 'present' ? '&present' : '');
}

export function openUrl(raw, mode) {
	const url = C.safeExternal(raw);
	if (!url) { alertBox('Please paste a web address (https://…).'); return; }
	location.href = '/slides/?url=' + encodeURIComponent(url) + (mode === 'present' ? '&present' : '');
}

function alertBox(text) {
	const n = document.querySelector('.sv-open-msg');
	if (n) { n.textContent = text; n.hidden = false; } else window.alert(text);
}

/** Drop a PDF anywhere on the page to open it. */
export function installDrop(root, getMode) {
	let depth = 0;
	const hasFile = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	window.addEventListener('dragenter', e => { if (!hasFile(e)) return; depth++; root.classList.add('sv-dragging'); e.preventDefault(); });
	window.addEventListener('dragover', e => { if (hasFile(e)) e.preventDefault(); });
	window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; root.classList.remove('sv-dragging'); } });
	window.addEventListener('drop', e => {
		if (!hasFile(e)) return;
		e.preventDefault();
		depth = 0; root.classList.remove('sv-dragging');
		const f = [...e.dataTransfer.files].find(x => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
		if (f) openFile(f, getMode()); else alertBox('Only PDFs can be opened here.');
	});
}

/** A file input + button, for the start screen and error messages. */
export function filePicker(h, mode, label = 'Choose a PDF…') {
	const inp = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
	inp.addEventListener('change', () => openFile(inp.files[0], typeof mode === 'function' ? mode() : mode));
	const b = h('button', { type: 'button', class: 'sv-open-btn sv-open-pri', onclick: () => inp.click() }, label);
	return [b, inp];
}

// ------------------------------------------------------------ start screen ---
export async function startScreen(root, h) {
	document.title = 'Slide viewer';
	const present = h('input', { type: 'checkbox', id: 'sv-open-present' });
	const mode = () => (present.checked ? 'present' : 'tab');
	const urlIn = h('input', { type: 'url', class: 'sv-open-url', placeholder: 'https://…/slides.pdf', 'aria-label': 'Address of a PDF', autocomplete: 'off', spellcheck: 'false' });
	const go = e => { e.preventDefault(); openUrl(urlIn.value, mode()); };
	const [pick, inp] = filePicker(h, mode);
	const recent = h('div', { class: 'sv-open-recent' });
	const card = h('div', { class: 'sv-open' },
		h('h1', {}, 'Slide viewer'),
		h('p', { class: 'sv-open-lead' }, 'Any PDF of slides, with fast page turns, contents, overview, search and a present mode.'),
		h('div', { class: 'sv-open-drop' },
			h('p', {}, 'Drop a PDF here'), h('p', { class: 'sv-small' }, 'or'), pick, inp,
			h('p', { class: 'sv-small' }, 'Files from your computer stay in your browser; nothing is uploaded.')),
		h('form', { class: 'sv-open-form', onsubmit: go },
			h('label', { for: 'sv-open-url' }, 'or open a PDF from the web'),
			h('div', { class: 'sv-open-row' }, Object.assign(urlIn, { id: 'sv-open-url' }), h('button', { type: 'submit', class: 'sv-open-btn' }, 'Open'))),
		h('label', { class: 'sv-open-check', for: 'sv-open-present' }, present, ' open in present mode'),
		h('p', { class: 'sv-open-msg', hidden: true, role: 'alert' }),
		recent,
		h('p', { class: 'sv-small sv-open-foot' }, h('a', { href: '/talks/' }, 'Talks with slides'), ' · keys: press ? inside the viewer'));
	root.replaceChildren(card);
	document.documentElement.classList.add('sv-mode-open');
	installDrop(root, mode);
	const locals = await listLocal(), urls = recentUrls();
	if (locals.length || urls.length) {
		const ul = h('ul', {});
		const row = (label, href, info, forget) => {
			const li = h('li', {}, h('a', { href }, label), ' ', h('span', { class: 'sv-small' }, info), ' ',
				h('button', { type: 'button', class: 'sv-open-x', title: 'Forget', 'aria-label': 'Forget ' + label, onclick: async () => { await forget(); li.remove(); } }, '×'));
			ul.append(li);
		};
		for (const r of locals) row(C.pdfName(r.name), '/slides/?local=' + encodeURIComponent(r.key), 'this computer · ' + C.formatBytes(r.size), () => forgetLocal(r.key));
		for (const r of urls) {
			let host = ''; try { host = new URL(r.url).hostname; } catch (e) { /* ignore */ }
			row(r.title || C.pdfName(r.url), '/slides/?url=' + encodeURIComponent(r.url), host, () => forgetUrl(r.url));
		}
		recent.append(h('h2', {}, 'Recent'), ul);
	}
	urlIn.focus();
	const count = () => window.goatcounter && window.goatcounter.count && (window.goatcounter.count({ path: '/slides/', title: 'Slide viewer' }), true);
	if (!count()) window.addEventListener('load', () => setTimeout(count, 500), { once: true });
}

/** For the error message when another site does not allow reading its PDF. */
export function corsHelp(h, url, mode) {
	const [pick, inp] = filePicker(h, mode, 'Choose the downloaded PDF…');
	return h('div', { class: 'sv-cors' },
		h('p', {}, 'The site that hosts this PDF does not let other pages read it. To view it here:'),
		h('ol', {},
			h('li', {}, h('a', { href: url, download: '', target: '_blank', rel: 'noopener' }, 'download the PDF'), ','),
			h('li', {}, 'drop it on this page, or ', pick, inp)),
		h('p', { class: 'sv-small' }, 'It stays in your browser; nothing is uploaded.'));
}
