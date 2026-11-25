/* Transcript pages, draft (video_timelines: true in the config), for videos
 * with a timeline: a full-width page below the title --
 *   left: the outline ("In this video"; one line per slide, the full title
 *         on hover; current line highlighted and scrolled into view when it
 *         changes, unless the reader scrolled the outline in the last 8 s;
 *         click to play from there; collapsible; its width can be dragged),
 *   middle: the video, and below it the transcript in its own pane,
 *         following the video,
 *   right: the page of the lecture notes the video shows, turning along
 *         (click to enlarge), buttons to the previous / next step of the
 *         timeline (slide, animation, Slido) showing a preview of it, and
 *         "Try it yourself" while a web animation is on screen;
 *   the border between middle and right can be dragged, and the bottom
 *   border (height of the whole; the transcript never gets less than a few
 *   lines below the video; double-click: fit the window again).
 *
 * Data: <script id="tl-data"> {notes_url, entries: [{t, kind, page, title,
 * name, animation}]}, from _data/video-timelines/ (written by
 * _tools/videos.py). Time: "tp-time" events from transcript-player.js.
 * The notes PDF is drawn with pdf.js (draft: from cdnjs; to be vendored),
 * which fetches only the parts of the PDF it needs for the pages shown.
 */
(function () {
	'use strict';
	var root = document.querySelector('.tl-app'), data = document.getElementById('tl-data');
	if (!root || !data) return;
	var tl = JSON.parse(data.textContent), es = tl.entries || [];
	var $ = function (id) { return document.getElementById(id); };
	var canvas = $('tl-canvas'), cap = $('tl-caption'), open = $('tl-open');
	var prevB = $('tl-prev'), nextB = $('tl-next'), tryA = $('tl-try');
	var zoom = $('tl-zoom'), zoomC = zoom && zoom.querySelector('canvas');
	var toc = root.querySelector('.tl-toc');
	var items = Array.prototype.slice.call(root.querySelectorAll('.tl-list li[data-from]'));
	var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
	var loading = null, zoomOpen = false, now = 0;
	var fmt = function (s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); };
	var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
	              set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

	// ---- the page fills the window below the title
	// (or the height dragged at the bottom border, remembered); never so low
	// that the transcript below the video gets less than MIN_PANE px
	var MIN_PANE = 180, userH = +store.get('tl-h') || 0;
	var vid = root.querySelector('.tl-video'), pane = root.querySelector('.tl-pane');
	function fit() {
		if (window.innerWidth <= 760) { root.style.removeProperty('--tl-h'); return; }
		var top = root.getBoundingClientRect().top + window.scrollY;
		var h = userH || window.innerHeight - top - 8;
		if (!userH && h < 480) h = window.innerHeight - 16;
		if (vid && pane) {                       // room for the transcript under the video
			var need = vid.getBoundingClientRect().bottom - root.getBoundingClientRect().top + MIN_PANE + 40;
			h = Math.max(h, need);
		}
		root.style.setProperty('--tl-h', Math.round(h) + 'px');
	}
	fit();
	window.addEventListener('resize', fit);
	if (window.ResizeObserver && vid) new ResizeObserver(fit).observe(vid);
	var grip = root.querySelector('.tl-grip');
	if (grip) {
		var startY = 0, startH = 0;
		grip.addEventListener('pointerdown', function (e) {
			e.preventDefault();
			grip.setPointerCapture(e.pointerId);
			startY = e.clientY;
			startH = root.getBoundingClientRect().height;
			root.classList.add('tl-vdragging');
		});
		grip.addEventListener('pointermove', function (e) {
			if (!root.classList.contains('tl-vdragging')) return;
			userH = Math.max(480, startH + e.clientY - startY);
			fit();
		});
		grip.addEventListener('pointerup', function (e) {
			root.classList.remove('tl-vdragging');
			grip.releasePointerCapture(e.pointerId);
			store.set('tl-h', userH);
		});
		grip.addEventListener('dblclick', function () { userH = 0; store.set('tl-h', 0); fit(); });
		grip.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
			e.preventDefault();
			userH = Math.max(480, root.getBoundingClientRect().height + (e.key === 'ArrowDown' ? 40 : -40));
			store.set('tl-h', userH);
			fit();
		});
	}
	if (window.innerWidth <= 1100) {                 // the outline sits above: start collapsed
		var d = toc && toc.querySelector('details');
		if (d) d.open = false;
	}

	// ---- the border between video and notes: drag (or arrow keys); remembered
	var split = root.querySelector('.tl-main > .tl-split'), top = root.querySelector('.tl-main');
	function setSplit(pct) {
		pct = Math.max(35, Math.min(85, pct));
		root.style.setProperty('--tl-split', pct + '%');
		return pct;
	}
	var saved = +store.get('tl-split');
	if (saved) setSplit(saved);
	if (split && top) {
		split.addEventListener('pointerdown', function (e) {
			e.preventDefault();
			split.setPointerCapture(e.pointerId);
			root.classList.add('tl-dragging');
		});
		split.addEventListener('pointermove', function (e) {
			if (!root.classList.contains('tl-dragging')) return;
			var r = top.getBoundingClientRect();
			setSplit((e.clientX - r.left) / r.width * 100);
		});
		split.addEventListener('pointerup', function (e) {
			root.classList.remove('tl-dragging');
			split.releasePointerCapture(e.pointerId);
			store.set('tl-split', parseFloat(getComputedStyle(root).getPropertyValue('--tl-split')));
			redraw();
		});
		split.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			e.preventDefault();
			var cur = parseFloat(getComputedStyle(root).getPropertyValue('--tl-split')) || 64;
			store.set('tl-split', setSplit(cur + (e.key === 'ArrowRight' ? 2 : -2)));
			redraw();
		});
	}

	// ---- the border between outline and the rest: drag (or arrow keys); remembered
	var tsplit = root.querySelector('.tl-split-toc');
	function setToc(px) {
		px = Math.max(150, Math.min(560, px));
		root.style.setProperty('--tl-toc', px + 'px');
		return px;
	}
	var savedToc = +store.get('tl-toc');
	if (savedToc) setToc(savedToc);
	if (tsplit && toc) {
		tsplit.addEventListener('pointerdown', function (e) {
			e.preventDefault();
			tsplit.setPointerCapture(e.pointerId);
			root.classList.add('tl-dragging');
		});
		tsplit.addEventListener('pointermove', function (e) {
			if (!root.classList.contains('tl-dragging')) return;
			setToc(e.clientX - toc.getBoundingClientRect().left);
		});
		tsplit.addEventListener('pointerup', function (e) {
			root.classList.remove('tl-dragging');
			tsplit.releasePointerCapture(e.pointerId);
			store.set('tl-toc', parseFloat(getComputedStyle(root).getPropertyValue('--tl-toc')));
			redraw();
		});
		tsplit.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			e.preventDefault();
			var cur = parseFloat(getComputedStyle(root).getPropertyValue('--tl-toc')) || 270;
			store.set('tl-toc', setToc(cur + (e.key === 'ArrowRight' ? 20 : -20)));
			redraw();
		});
	}
	// the outline follows the video only when its line changes, and not
	// while the reader looks around in it (scrolled there in the last 8 s)
	var tocTouched = 0, lastCur = null, follow = root.querySelector('.tp-follow');
	if (toc) ['wheel', 'touchmove', 'pointerdown', 'keydown'].forEach(function (ev) {
		toc.addEventListener(ev, function () { tocTouched = Date.now(); }, { passive: true });
	});

	// ---- where we are
	function indexAt(t) {
		var k = -1;
		for (var i = 0; i < es.length && es[i].t <= t + 0.5; i++) k = i;
		return k;
	}
	function pageEntryAt(k) {            // during an animation etc.: the page before it
		for (var i = k; i >= 0; i--) if (es[i].page) return es[i];
		for (var j = 0; j < es.length; j++) if (es[j].page) return es[j];
		return null;
	}

	// ---- the notes page (pdf.js, loaded on demand)
	function loadPdf() {
		if (loading) return loading;
		loading = new Promise(function (resolve, reject) {
			var s = document.createElement('script');
			s.src = PDFJS + 'pdf.min.js';
			s.onload = function () {
				var lib = window.pdfjsLib;
				lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
				lib.getDocument({ url: tl.notes_url, disableAutoFetch: true, disableStream: true }).promise.then(resolve, reject);
			};
			s.onerror = reject;
			document.head.appendChild(s);
		});
		return loading;
	}
	function render(c, n, cssWidth) {
		return loadPdf().then(function (doc) { return doc.getPage(n); }).then(function (page) {
			var w = Math.max(100, cssWidth) * (window.devicePixelRatio || 1);
			var vp = page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width });
			c.width = Math.round(vp.width);
			c.height = Math.round(vp.height);
			return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
		});
	}
	// a canvas showing one page at a time; renders the latest wish only
	function view(c, onDone) {
		var shown = null, want = null, busy = false, self = {};
		self.show = function (n) {
			want = n;
			if (busy || !c || n === shown || !n) return;
			busy = true;
			render(c, n, c.clientWidth || c.parentNode.clientWidth).then(function () { shown = n; }, function (err) {
				shown = n;
				if (window.console) console.warn('notes page', err);
			}).then(function () {
				busy = false;
				if (want !== shown) self.show(want);
				else if (onDone) onDone(n);
			});
		};
		self.redraw = function () { var n = shown; shown = null; self.show(n || want); };
		self.page = function () { return shown; };
		return self;
	}
	var main = view(canvas, function () { if (zoomOpen) showZoom(); });
	var thumbs = [prevB, nextB].map(function (btn) { return btn ? view(btn.querySelector('canvas')) : null; });
	function redraw() { main.redraw(); thumbs.forEach(function (v) { if (v) v.redraw(); }); }
	window.addEventListener('resize', redraw);

	// click: the page larger, beside the notes column (over the video); it keeps
	// following the video; click it (or the small page again, or Esc) to close
	function showZoom() {
		if (!zoom || !main.page()) return;
		var r = canvas.getBoundingClientRect();
		var w = Math.min(1100, Math.max(r.width * 2.2, window.innerWidth * 0.5), window.innerWidth - 40);
		var h = w * 3 / 5;
		zoom.style.left = Math.max(20, r.right - w) + 'px';
		zoom.style.top = Math.max(10, Math.min(r.top, window.innerHeight - h - 10)) + 'px';
		zoomC.style.width = w + 'px';
		zoom.hidden = false;
		render(zoomC, main.page(), w);
	}
	function hideZoom() { zoomOpen = false; if (zoom) zoom.hidden = true; }
	if (canvas && zoom) {
		canvas.addEventListener('click', function () { if (zoomOpen) hideZoom(); else { zoomOpen = true; showZoom(); } });
		zoom.addEventListener('click', hideZoom);
		document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideZoom(); });
		window.addEventListener('resize', function () { if (zoomOpen) showZoom(); });
	}

	// ---- everything that follows the time
	function update(t) {
		now = t;
		var k = indexAt(t), e = k >= 0 ? es[k] : null, pe = pageEntryAt(k);
		if (pe && canvas && tl.notes_url) {
			main.show(pe.page);
			if (cap) cap.textContent = 'p. ' + pe.page + (pe.title ? ' · ' + pe.title : '');
			if (open) open.href = tl.notes_url + '#page=' + pe.page;
		}
		// previous / next step: the neighboring entries of the timeline -- slides,
		// animations, Slido, other stretches (a page shows as a preview of it,
		// the others as a labeled tile)
		var prev = k > 0 ? es[k - 1] : null, next = k + 1 < es.length ? es[k + 1] : null;
		if (k < 0 && es.length) next = es[0];
		[[prevB, prev, thumbs[0]], [nextB, next, thumbs[1]]].forEach(function (x) {
			var btn = x[0], en = x[1];
			if (!btn) return;
			btn.disabled = !en;
			var label = !en ? '' : en.page ? 'p. ' + en.page : en.kind === 'animation' ? 'animation'
				: en.kind === 'slido' ? 'Slido' : 'other';
			btn.querySelector('small').textContent = label;
			var ph = btn.querySelector('.tl-ph');
			btn.classList.toggle('tl-nopage', !!en && !en.page);
			if (!en) return;
			btn.setAttribute('data-t', Math.floor(en.t));
			btn.title = fmt(en.t) + ' · ' + (en.page ? 'p. ' + en.page + (en.title ? ': ' + en.title : '')
				: en.kind === 'animation' ? 'Animation: ' + (en.name || en.animation) : en.kind === 'slido' ? 'Slido poll' : 'not on the slides');
			if (en.page) { if (tl.notes_url) x[2].show(en.page); }       // a preview of that slide
			else if (ph) {
				ph.className = 'tl-ph tl-ph-' + en.kind;
				ph.innerHTML = en.kind === 'animation' ? '<i class="fas fa-flask"></i><span></span>'
					: en.kind === 'slido' ? '<span>Slido poll</span>' : '<span>not on the slides</span>';
				if (en.kind === 'animation') ph.querySelector('span').textContent = en.name || en.animation || 'animation';
			}
		});
		// a web animation on screen: offer to try it
		var curLi = null;
		items.forEach(function (li) {
			if (+li.getAttribute('data-from') <= t + 0.5 && t + 0.5 < +li.getAttribute('data-to')) curLi = li;
		});
		if (tryA) {
			var href = e && e.kind === 'animation' && (e.animation ? '/teaching/animations/' + e.animation
				: curLi && curLi.getAttribute('data-anim'));
			tryA.hidden = !href;
			if (href) {
				tryA.href = href;
				tryA.querySelector('small').textContent = e.name || (curLi && curLi.getAttribute('data-name')) || '';
			}
		}
		// the outline: highlight, and keep the current line in view
		var cur = null;
		items.forEach(function (li) {
			var on = +li.getAttribute('data-from') <= t + 0.5 && t + 0.5 < +li.getAttribute('data-to');
			li.classList.toggle('tl-now', on);
			if (on) cur = li;
		});
		if (cur !== lastCur) {
			lastCur = cur;
			if (cur && toc && toc.scrollHeight > toc.clientHeight && Date.now() - tocTouched > 8000
					&& (!follow || follow.checked)) {
				var tr = toc.getBoundingClientRect(), cr = cur.getBoundingClientRect();
				if (cr.top < tr.top || cr.bottom > tr.bottom) toc.scrollTop += cr.top - tr.top - tr.height / 3;
			}
		}
	}

	root.addEventListener('tp-time', function (ev) { update(ev.detail.t); });
	if (!/t=\d/.test(location.hash)) update(0);
})();
