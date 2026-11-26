/* talk-media.js -- the "Talk video / Talk slides" tabs on talk pages (and
 * of each talk on the stage of paper pages).
 *
 * Markup: _includes/talk-media.html (section.talk-media.has-tabs), on talk
 * pages, publication pages and posts; any number per page.  Without this
 * script both panes simply show one below the other.
 *
 *  - The video tab is the default; the slides tab opens the slide viewer at
 *    once (choosing the tab is the click on the thumbnail).
 *  - Only the box with data-hash (the talk page): #page=N in the URL (the
 *    contents links, shared links) selects the slides tab; slides-lite.js
 *    then moves the viewer.  #slides / #video select a tab.
 *  - Leaving the video tab pauses a playing video (yt-lite.js embeds with
 *    enablejsapi=1).
 *  - Arrow keys move between the tabs (WAI-ARIA tabs pattern).
 * Load it *before* slides-lite.js (both deferred, in document order) so the
 * tab is switched before the viewer is told about #page=N.
 */
(function () {
	'use strict';
	// Opening the slides is a click on the facade, which slides-lite.js handles;
	// on a talk page opened with #slides this script runs before slides-lite.js
	// (both deferred), and the click would follow the link to the PDF. So the
	// click waits until all deferred scripts have run (DOMContentLoaded).
	var ready = document.readyState === 'complete';
	document.addEventListener('DOMContentLoaded', function () { ready = true; });
	function whenReady(fn) {
		if (ready) fn();
		else document.addEventListener('DOMContentLoaded', fn, { once: true });
	}
	Array.prototype.forEach.call(document.querySelectorAll('.talk-media.has-tabs'), setup);

	function setup(box) {
	var useHash = box.hasAttribute('data-hash');
	var tabs = Array.prototype.slice.call(box.querySelectorAll('.talk-tab'));
	var panes = Array.prototype.slice.call(box.querySelectorAll('.talk-pane'));
	box.classList.add('tabs-ready');

	function pauseVideo() {
		var f = box.querySelector('.yt-lite iframe');
		if (!f) return;
		try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch (e) { /* ignore */ }
	}

	function select(name, opts) {
		opts = opts || {};
		var prev = box.getAttribute('data-current');
		if (prev === name && !opts.force) return;
		box.setAttribute('data-current', name);
		tabs.forEach(function (t) {
			var on = t.getAttribute('data-pane') === name;
			t.setAttribute('aria-selected', on ? 'true' : 'false');
			t.tabIndex = on ? 0 : -1;
			t.classList.toggle('is-active', on);
		});
		panes.forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
		if (name !== 'video') pauseVideo();
		if (name === 'slides' && opts.open) whenReady(function () {
			var lite = box.querySelector('.slides-lite:not(.is-open) > a');
			if (lite) lite.click();
		});
		if (useHash && opts.hash !== false && !/^#page=/.test(location.hash)) {
			history.replaceState(history.state, '', location.pathname + location.search + (name === box.getAttribute('data-default') ? '' : '#' + name));
		}
		box.classList.add('was-switched');
	}

	tabs.forEach(function (t, i) {
		t.addEventListener('click', function () { select(t.getAttribute('data-pane'), { open: true }); });
		t.addEventListener('keydown', function (e) {
			var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
			if (!d) return;
			e.preventDefault();
			var n = tabs[(i + d + tabs.length) % tabs.length];
			n.focus();
			select(n.getAttribute('data-pane'), { open: false });
		});
	});
	box.addEventListener('click', function (e) {
		var b = e.target.closest && e.target.closest('[data-goto-pane]');
		if (b) { e.preventDefault(); select(b.getAttribute('data-goto-pane'), { open: true }); }
		// starting the video: the "rather see the slides" chip has done its job
		if (e.target.closest && e.target.closest('.yt-lite > a')) box.classList.add('video-started');
	});

	function fromHash() {
		var h = location.hash;
		if (/^#page=\d+$/.test(h) || h === '#slides') select('slides', { hash: false, open: h === '#slides' });
		else if (h === '#video') select('video', { hash: false });
	}
	select(box.getAttribute('data-default'), { hash: false, force: true });
	box.classList.remove('was-switched');
	if (useHash) {
		window.addEventListener('hashchange', fromHash);
		fromHash();
	}
	}
})();
