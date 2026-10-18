/* Full-text search over lecture transcripts (forms from
 * _includes/transcript-search.html). Loads the search-index.json and, on the
 * first search, the search.json of each module iteration in scope (cached).
 * Matches all query words (or a "quoted phrase") within a few consecutive
 * caption lines; results link to the transcript page at that time.
 */
(function () {
	'use strict';
	var MAX_HITS = 300, PER_VIDEO = 4, WINDOW = 3;
	var cache = {};

	function getJSON(url) {
		if (!cache[url]) cache[url] = fetch(url).then(function (r) { return r.json(); });
		return cache[url];
	}
	function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
	function fold(s) { return s.toLowerCase(); }
	function fmt(t) {
		var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
		return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
	}
	function terms(q) {
		var phrase = q.match(/^\s*"(.+)"\s*$/);
		if (phrase) return [fold(phrase[1])];
		return fold(q).split(/\s+/).filter(function (w) { return w.length > 0; });
	}

	function setup(form) {
		var input = form.querySelector('.ts-input'), status = form.querySelector('.ts-status'),
			out = form.querySelector('.ts-results'), scope = form.getAttribute('data-scope'), timer, run = 0;

		function search() {
			var q = input.value.trim(), my = ++run;
			if (q.length < 3) { out.innerHTML = ''; status.textContent = ''; return; }
			var ts = terms(q);
			var re = new RegExp('(' + ts.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
			status.textContent = 'searching…';
			getJSON(form.getAttribute('data-index')).then(function (index) {
				var its = index.filter(function (it) { return scope === 'all' || it.slug === scope; });
				var seen = {}, hits = 0, html = [], done = 0;
				if (!its.length) { status.textContent = 'no transcripts'; return; }
				// load iterations one after another so results appear progressively
				return its.reduce(function (p, it) {
					return p.then(function () {
						if (my !== run || hits >= MAX_HITS) return;
						return getJSON(it.data).then(function (videos) {
							if (my !== run) return;
							videos.forEach(function (v) {
								if (hits >= MAX_HITS || (scope === 'all' && seen[v.id])) return;
								var found = [], s = v.s, lower = s.map(function (x) { return fold(x[1]); });
								for (var i = 0; i < s.length && found.length < PER_VIDEO; i++) {
									var win = lower.slice(i, i + WINDOW).join(' ');
									if (ts.every(function (w) { return win.indexOf(w) >= 0; }) &&
										ts.some(function (w) { return lower[i].indexOf(w) >= 0; })) {
										found.push(i);
										i += WINDOW - 1;
									}
								}
								if (!found.length) return;
								seen[v.id] = true;
								hits += found.length;
								var ctx = found.map(function (i) {
									var text = s.slice(Math.max(0, i - 1), i + WINDOW).map(function (x) { return x[1]; }).join(' ');
									return '<div class="ts-hit-ctx"><a class="ts-t" href="' + v.url + '#t=' + s[i][0] + '&q=' + encodeURIComponent(q) + '">' +
										fmt(s[i][0]) + '</a>' + esc(text).replace(re, '<mark>$1</mark>') + '</div>';
								}).join('');
								html.push('<div class="ts-hit"><div class="ts-hit-title"><a href="' + v.url + '">' +
									(scope === 'all' ? esc(it.module + ' (' + it.term + ') · ') : '') +
									'Video ' + esc(v.l) + ': ' + esc(v.title) + '</a></div>' + ctx + '</div>');
							});
							out.innerHTML = html.join('');
							done++;
							status.textContent = (hits >= MAX_HITS ? MAX_HITS + '+' : hits) + ' match' + (hits === 1 ? '' : 'es') +
								(done < its.length && hits < MAX_HITS ? ' (searching ' + (done + 1) + '/' + its.length + '…)' : '');
						});
					});
				}, Promise.resolve()).then(function () {
					if (my === run && !hits) { status.textContent = 'no matches'; out.innerHTML = ''; }
				});
			}).catch(function () { status.textContent = 'search unavailable'; });
		}

		input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 350); });
		input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(timer); search(); } });
		var q = new URLSearchParams(location.search).get('q');
		if (q) { input.value = q; search(); }
	}

	Array.prototype.forEach.call(document.querySelectorAll('form.ts'), setup);
})();
