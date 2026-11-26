/* paper-page.js -- behavior of the paper pages (/publications/SLUG).
 *
 * Without JavaScript every link still works; this script only adds:
 *
 *  - The sticky bar: on narrow screens (no rail), once the cover and links
 *    (.paper-glance) have scrolled out of view, a bar at the bottom offers the
 *    title, Read and PDF. Without the script it stays hidden. The CSS decides
 *    whether the bar may show at all (the rail's breakpoint, _sass/_papers.scss);
 *    this script only says when.
 *  - The demo facade (_includes/demo-lite.html): a click loads the demo in an
 *    iframe in place. Below 600 px the link is followed instead (the demo's
 *    own page): a demo in a phone-sized frame is no fun.
 *  - The stage's row of picks (demo, talks; _includes/paper-stage.html):
 *    shows one panel at a time, pauses a video it hides; arrow keys move
 *    between the picks. Picking the demo starts it (not below 600 px).
 *  - Copy BibTeX in the reference block (hidden without the clipboard API).
 *  - Links with data-jump="stage" (Demo, Talks, Video in the links): scroll
 *    to the stage (#stage); Demo picks and starts the demo, Video picks the
 *    talk with the recording (data-talk) and its video tab. Their href is the
 *    fallback: the demo itself, or #talks.
 *
 * Layout: _layouts/publication.html; stage: _includes/talk-media.html.
 */
(function () {
	'use strict';

	// ---- sticky bar
	var bar = document.querySelector('.paper-stickybar');
	var glance = document.querySelector('.paper-glance');
	if (bar && glance && 'IntersectionObserver' in window) {
		bar.hidden = false;
		document.documentElement.classList.add('has-paper-stickybar');
		new IntersectionObserver(function (entries) {
			var e = entries[0];
			// shown only once the links are above the viewport (not before they come into view)
			var gone = !e.isIntersecting && e.boundingClientRect.top < 0;
			// .is-shown also switches visibility, so the hidden bar's links are not focusable
			bar.classList.toggle('is-shown', gone);
		}).observe(glance);
	}

	// ---- demo facade
	document.addEventListener('click', function (e) {
		var a = e.target.closest && e.target.closest('.demo-lite:not(.is-open) > a');
		if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
		if (window.innerWidth < 600) return;   // follow the link
		e.preventDefault();
		var box = a.parentNode;
		var f = document.createElement('iframe');
		f.src = box.getAttribute('data-src');
		f.title = box.getAttribute('data-title') || 'Demo';
		f.setAttribute('allow', 'fullscreen');
		box.replaceChild(f, a);
		box.classList.add('is-open');
		f.focus();
	});

	// ---- Copy BibTeX (the reference block): exactly the text of the entry
	Array.prototype.forEach.call(document.querySelectorAll('.ref-copy'), function (b) {
		var src = document.getElementById(b.getAttribute('data-copy'));
		if (!src || !navigator.clipboard) return;   // no button: the entry is below, to select by hand
		b.hidden = false;
		var label = b.querySelector('span');
		b.addEventListener('click', function () {
			navigator.clipboard.writeText(src.textContent).then(function () {
				label.textContent = 'Copied';
				setTimeout(function () { label.textContent = 'Copy BibTeX'; }, 1800);
			}, function () {
				var d = src.closest('details'); if (d) d.open = true;   // show it to copy by hand
			});
		});
	});

	// ---- the stage: pick the demo or a talk
	var stage = document.getElementById('stage');
	if (!stage) return;
	var picks = Array.prototype.slice.call(stage.querySelectorAll('.stage-pick'));
	var panels = Array.prototype.slice.call(stage.querySelectorAll('.stage-panel'));

	function pauseVideos(panel) {
		Array.prototype.forEach.call(panel.querySelectorAll('.yt-lite iframe'), function (f) {
			try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch (e) { /* ignore */ }
		});
	}
	function startDemo() {
		if (window.innerWidth < 600) return;
		var d = stage.querySelector('.demo-lite:not(.is-open) > a');
		if (d) d.click();
	}
	function pick(entry, opts) {
		opts = opts || {};
		if (!picks.length) return;
		picks.forEach(function (b) {
			var on = b.getAttribute('data-entry') === entry;
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			b.tabIndex = on ? 0 : -1;
		});
		panels.forEach(function (p) {
			var on = p.getAttribute('data-entry') === entry;
			if (!on && !p.hidden) pauseVideos(p);
			p.hidden = !on;
		});
		if (entry === 'demo' && opts.open) startDemo();
	}
	if (picks.length) {
		stage.classList.add('picks-ready');
		pick(stage.getAttribute('data-default'));
		picks.forEach(function (b, i) {
			b.addEventListener('click', function () { pick(b.getAttribute('data-entry'), { open: true }); });
			b.addEventListener('keydown', function (e) {
				var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
				if (!d) return;
				e.preventDefault();
				var n = picks[(i + d + picks.length) % picks.length];
				n.focus(); pick(n.getAttribute('data-entry'));
			});
		});
	}

	// ---- links to the stage
	Array.prototype.forEach.call(document.querySelectorAll('a[data-jump="stage"]'), function (a) {
		a.addEventListener('click', function (e) {
			if (e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
			e.preventDefault();
			var pane = a.getAttribute('data-pane'), talk = a.getAttribute('data-talk');
			if (pane === 'demo') { pick('demo'); startDemo(); }
			else if (talk) {
				pick(talk);
				var tab = stage.querySelector('#stage-panel-' + talk + ' .talk-tab[data-pane="' + pane + '"]');
				if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
			}
			stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
			history.replaceState(history.state, '', '#stage');
		});
	});
})();
