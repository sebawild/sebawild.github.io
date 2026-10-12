/* Click-to-load YouTube embeds for wild-inter.net.
 *
 * Markup comes from _includes/youtube.html:
 *   <div class="yt-lite" data-id="..." [data-start] [data-end] data-title="...">
 *     <a href="https://youtu.be/ID"><img ...><svg ...></a>
 *   </div>
 * A click replaces the link by a youtube-nocookie.com player that starts
 * playing right away (one click, also on phones). Ctrl/Cmd/middle-click keep
 * the normal link behaviour (open on YouTube).
 *
 * Chapter links (<a data-yt-id data-yt-start>) start the embedded player at
 * that time instead of leaving the page.
 *
 * Also upgrades legacy markup still found on older pages:
 *   <div class="youtube"><div class="youtube-player" data-id="..." data-opts="start=..&end=.."></div></div>
 *   <div class="stream-player" data-id="..."></div>   (Liverpool stream, spring 2020)
 */
(function () {
	'use strict';

	var EMBED = 'https://www.youtube-nocookie.com/embed/';
	var THUMBS = '/assets/video-thumbs/';

	function play(box, start) {
		var params = ['autoplay=1', 'rel=0', 'playsinline=1'];
		start = start != null ? start : box.getAttribute('data-start');
		if (start) params.push('start=' + parseInt(start, 10));
		var end = box.getAttribute('data-end');
		if (end) params.push('end=' + parseInt(end, 10));

		var iframe = document.createElement('iframe');
		iframe.src = EMBED + encodeURIComponent(box.getAttribute('data-id')) + '?' + params.join('&');
		iframe.title = box.getAttribute('data-title') || 'YouTube video';
		iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen');
		iframe.setAttribute('allowfullscreen', '');
		iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
		box.textContent = '';
		box.appendChild(iframe);
		box.classList.add('is-playing');
	}

	function plainClick(e) {
		return e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
	}

	document.addEventListener('click', function (e) {
		if (!plainClick(e) || !e.target.closest) return;
		var link = e.target.closest('.yt-lite > a');
		if (link) {
			e.preventDefault();
			play(link.parentNode);
			return;
		}
		var chapter = e.target.closest('a[data-yt-id][data-yt-start]');
		if (chapter) {
			var box = document.querySelector('.yt-lite[data-id="' + chapter.getAttribute('data-yt-id') + '"]');
			if (!box) return;
			e.preventDefault();
			play(box, chapter.getAttribute('data-yt-start'));
			box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	});

	function liteBox(id, start, end) {
		var box = document.createElement('div');
		box.className = 'yt-lite';
		box.setAttribute('data-id', id);
		if (start) box.setAttribute('data-start', start);
		if (end) box.setAttribute('data-end', end);
		var a = document.createElement('a');
		a.href = 'https://youtu.be/' + id + (start ? '?t=' + start : '');
		a.setAttribute('aria-label', 'Play video');
		var img = document.createElement('img');
		img.alt = '';
		img.width = 640; img.height = 360;
		img.loading = 'lazy';
		img.onerror = function () { img.onerror = null; img.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'; };
		img.src = THUMBS + id + '.webp';
		a.appendChild(img);
		a.insertAdjacentHTML('beforeend', '<svg class="yt-lite-play" viewBox="0 0 68 48" aria-hidden="true" focusable="false"><path class="yt-lite-play-bg" d="M66.5 7.7c-.8-2.9-2.5-5.4-5.4-6.2C55.8.1 34 0 34 0S12.2.1 6.9 1.6C4 2.3 2.3 4.8 1.5 7.7.1 13 0 24 0 24s.1 11 1.5 16.3c.8 2.9 2.5 5.4 5.4 6.2C12.2 47.9 34 48 34 48s21.8-.1 27.1-1.6c2.9-.7 4.6-3.2 5.4-6.1C67.9 35 68 24 68 24s-.1-11-1.5-16.3z"/><path d="M45 24 27 14v20z" fill="#fff"/></svg>');
		box.appendChild(a);
		return box;
	}

	function upgradeLegacy() {
		var olds = document.querySelectorAll('.youtube-player[data-id]');
		Array.prototype.forEach.call(olds, function (old) {
			var opts = new URLSearchParams((old.getAttribute('data-opts') || '').replace(/&amp;/g, '&'));
			var box = liteBox(old.getAttribute('data-id'), opts.get('start'), opts.get('end'));
			var wrapper = old.parentNode && old.parentNode.classList.contains('youtube') ? old.parentNode : old;
			wrapper.parentNode.replaceChild(box, wrapper);
		});
		var streams = document.querySelectorAll('.stream-player[data-id]:empty');
		Array.prototype.forEach.call(streams, function (s) {
			var iframe = document.createElement('iframe');
			iframe.src = 'https://stream.liv.ac.uk/s/' + encodeURIComponent(s.getAttribute('data-id'));
			iframe.setAttribute('allowfullscreen', '');
			s.appendChild(iframe);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', upgradeLegacy);
	} else {
		upgradeLegacy();
	}
})();
