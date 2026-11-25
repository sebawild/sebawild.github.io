/* Transcript pages (/videos/<module>/<video>/): click a sentence to play the
 * video from there; while playing, the current sentence is highlighted (and
 * followed, unless "follow along" is unticked).
 *
 * Nothing is loaded from YouTube until the first click; then the IFrame
 * Player API is used with the youtube-nocookie.com host.
 * #t=123 in the URL marks that point (e.g. links from the search).
 *
 * Other scripts can follow the video: the .tp element gets "tp-time" events,
 * detail {t: seconds, playing: bool} (transcript-timeline.js).
 */
(function () {
	'use strict';
	var root = document.querySelector('.tp');
	if (!root) return;
	var id = root.getAttribute('data-id');
	var box = document.getElementById('tp-player');
	var bar = box.closest('.tp-bar') || box;
	var follow = root.querySelector('.tp-follow');
	var pane = root.querySelector('.tp-scroll');   // the transcript scrolls in its own pane (timeline layout)
	var segs = Array.prototype.slice.call(root.querySelectorAll('.tp-text span[data-t]'));
	var times = segs.map(function (s) { return +s.getAttribute('data-t'); });
	var player = null, ready = false, pending = 0, current = null, lastUserScroll = 0;

	function indexAt(t) {          // last segment starting at or before t
		var lo = 0, hi = times.length - 1, ans = -1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (times[mid] <= t + 0.25) { ans = mid; lo = mid + 1; } else hi = mid - 1;
		}
		return ans;
	}

	function mark(i, scroll) {
		var el = i >= 0 ? segs[i] : null;
		if (el === current) return;
		if (current) current.classList.remove('tp-now');
		current = el;
		if (!el) return;
		el.classList.add('tp-now');
		if (scroll && pane) {
			var pr = pane.getBoundingClientRect(), er = el.getBoundingClientRect(), head = pane.firstElementChild;
			var ptop = pr.top + (head ? head.offsetHeight : 0) + 8;
			if (er.top < ptop || er.bottom > pr.bottom - 8) {
				pane.scrollBy({ top: er.top - ptop - (pr.bottom - ptop) / 3, behavior: 'smooth' });
			}
		} else if (scroll) {
			var r = el.getBoundingClientRect(), top = bar.getBoundingClientRect().bottom + 8;
			if (r.top < top || r.bottom > window.innerHeight - 8) {
				window.scrollBy({ top: r.top - top - (window.innerHeight - top) / 3, behavior: 'smooth' });
			}
		}
	}

	function tell(t, playing) {
		var ev;
		try { ev = new CustomEvent('tp-time', { detail: { t: t, playing: playing } }); }
		catch (e) { return; }
		root.dispatchEvent(ev);
	}

	function tick() {
		if (!ready || typeof player.getCurrentTime !== 'function') return;
		var playing = player.getPlayerState && player.getPlayerState() === 1;
		tell(player.getCurrentTime(), playing);
		var userScrolledRecently = Date.now() - lastUserScroll < 4000;
		mark(indexAt(player.getCurrentTime()), playing && follow && follow.checked && !userScrolledRecently);
	}

	function loadApi(cb) {
		if (window.YT && window.YT.Player) return cb();
		var prev = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = function () { if (prev) prev(); cb(); };
		var s = document.createElement('script');
		s.src = 'https://www.youtube.com/iframe_api';
		document.head.appendChild(s);
	}

	function play(t) {
		t = Math.max(0, +t || 0);
		mark(indexAt(t), false);
		tell(t, false);
		if (player && ready) { player.seekTo(t, true); player.playVideo(); return; }
		pending = t;
		if (player) return;               // still loading; will start at `pending`
		player = 'loading';
		box.innerHTML = '<div id="tp-yt"></div>';
		loadApi(function () {
			player = new window.YT.Player('tp-yt', {
				host: 'https://www.youtube-nocookie.com',
				videoId: id,
				playerVars: { autoplay: 1, start: Math.floor(pending), rel: 0, playsinline: 1 },
				events: {
					onReady: function (e) {
						ready = true;
						e.target.seekTo(pending, true);
						e.target.playVideo();
						setInterval(tick, 300);
					}
				}
			});
		});
	}

	root.addEventListener('click', function (e) {
		var el = e.target.closest && e.target.closest('[data-t]');
		if (!el || !root.contains(el)) return;
		if (e.target.closest('a') && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
		e.preventDefault();
		var t = +el.getAttribute('data-t');
		if (el.classList.contains('tp-start')) t = pending || t;
		if (history.replaceState && !el.classList.contains('tp-start')) history.replaceState(null, '', '#t=' + t);
		play(t);
	});

	['wheel', 'touchmove', 'keydown'].forEach(function (ev) {
		window.addEventListener(ev, function () { lastUserScroll = Date.now(); }, { passive: true });
	});

	// #t=123: mark and scroll to that point; the play button then starts there
	var m = location.hash.match(/t=(\d+)/);
	if (m) {
		pending = +m[1];
		setTimeout(function () { tell(pending, false); }, 0);
		var i = indexAt(pending);
		mark(i, false);
		if (i >= 0 && pane) {
			var pr = pane.getBoundingClientRect(), er = segs[i].getBoundingClientRect();
			pane.scrollTop += er.top - pr.top - 60;
		} else if (i >= 0) {
			var r = segs[i].getBoundingClientRect(), top = bar.getBoundingClientRect().height + 20;
			window.scrollTo({ top: window.scrollY + r.top - top - 40 });
		}
		var q = location.hash.match(/q=([^&]+)/);
		if (q) highlight(decodeURIComponent(q[1]));
	}

	function highlight(query) {   // mark search terms (from the search results)
		var phrase = query.match(/^\s*"(.+)"\s*$/);
		var words = phrase ? [phrase[1].toLowerCase()]
			: query.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 1; });
		if (!words.length) return;
		var re = new RegExp('(' + words.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
		segs.forEach(function (s) {
			if (re.test(s.textContent)) s.innerHTML = s.textContent.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }).replace(re, '<mark>$1</mark>');
			re.lastIndex = 0;
		});
	}
})();
