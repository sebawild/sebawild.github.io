/* slides-lite.js -- click-to-load slides on talk and paper pages.
 *
 * Markup from _includes/talk-slides.html:
 *   <div class="slides-lite" data-talk="powersort" data-page="1">
 *     <a href="/talks/powersort.pdf"><img ...><span class="slides-lite-cta">…</span></a>
 *   </div>
 * A plain click swaps in an iframe of the viewer (/slides/?t=…&embed#page=N);
 * Ctrl/Cmd/middle click keep the link (the PDF).  Nothing of the viewer or
 * PDF.js loads before the click.  If the page URL has #page=N (on load or
 * later, e.g. from the talk page's contents), the first facade opens at that
 * page, or the open viewer moves there.
 */
(function () {
	'use strict';
	var EMBED_BAR = 56;      // bottom bar (44 px) + stage padding (2 × 6 px) of the viewer in embed mode
	function open(box, page, focus) {
		var id = box.getAttribute('data-talk');
		var f = document.createElement('iframe');
		f.src = '/slides/?t=' + encodeURIComponent(id) + '&embed#page=' + (page || box.getAttribute('data-page') || 1);
		f.title = box.getAttribute('data-title') || 'Slides';
		f.setAttribute('allow', 'fullscreen; screen-wake-lock');
		f.setAttribute('allowfullscreen', '');
		box.textContent = '';
		box.appendChild(f);
		box.classList.add('is-open');
		// the open viewer has a bar under the slide: grow the box by that much,
		// so the slide keeps the size it had as a thumbnail
		var ar = (box.getAttribute('data-aspect') || '16/9').split('/').map(Number);
		var grow = function () {
			var w = box.clientWidth - 10;                    // minus the frame padding
			box.style.aspectRatio = 'auto';
			box.style.height = Math.round(w * ar[1] / ar[0] + EMBED_BAR) + 'px';
		};
		grow();
		if (window.ResizeObserver) new ResizeObserver(grow).observe(box);
		if (focus) f.addEventListener('load', function () { try { f.contentWindow.focus(); } catch (e) { /* ignore */ } }, { once: true });
	}
	document.addEventListener('click', function (e) {
		if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
		var a = e.target.closest && e.target.closest('.slides-lite > a');
		if (!a) return;
		e.preventDefault();
		open(a.parentNode, null, true);
	});
	// #page=N in the page's URL (the talk page's contents links, shared links):
	// open the slides there, or move the open viewer there
	function fromHash(e) {
		var m = /^#page=(\d+)$/.exec(location.hash);
		if (!m) return;
		var box = document.querySelector('.slides-lite');
		if (!box) return;
		var f = box.querySelector('iframe');
		if (f) {
			try { f.contentWindow.location.hash = 'page=' + m[1]; }
			catch (err) { f.src = f.src.replace(/#.*$/, '') + '#page=' + m[1]; }
		} else {
			open(box, m[1], !!e);
		}
		box.scrollIntoView({ block: 'center', behavior: e ? 'smooth' : 'auto' });
	}
	window.addEventListener('hashchange', fromHash);
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { fromHash(); }); else fromHash();
})();
