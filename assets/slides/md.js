/* md.js -- Markdown slides for the viewer: where the Markdown may come
 * from, and HackMD's slide dialect turned into Marp's.  Pure functions, no
 * DOM; tested in _tools/talks/test/md.test.mjs.  The rendering happens in
 * deck-md.html (a sandboxed frame, Marp Core); see
 * _tools/talks/DEVNOTES-viewer.md, "Markdown slides".
 */

/** Where a Markdown deck comes from: {fetch, view, host, name} or null.
 *   - HackMD notes (https://hackmd.io/@user/ID, https://hackmd.io/ID): the
 *     raw Markdown is at .../download (HackMD lets other pages read it);
 *   - GitHub: raw.githubusercontent.com and gist.githubusercontent.com URLs,
 *     and github.com/USER/REPO/blob/BRANCH/PATH (turned into the raw URL);
 *   - files of this site (a path, or a URL with this origin);
 *   - any https address ending in .md / .markdown / .marp (if that site lets
 *     other pages read it).
 *  Anything else: null.  (Whatever the Markdown holds is rendered in a
 *  sandboxed frame, so the source needs no vetting for safety.) */
export function mdSource(input, origin) {
	if (!input) return null;
	const s = String(input).trim();
	let u;
	try { u = new URL(s, origin); } catch (e) { return null; }
	if (u.origin === origin) {
		if (!/\.(md|markdown|marp|txt)$/i.test(u.pathname)) return null;
		return { fetch: u.pathname + u.search, view: u.pathname, host: 'this site', name: decodeURIComponent(u.pathname.split('/').pop()) };
	}
	if (u.protocol !== 'https:') return null;
	if (u.hostname === 'hackmd.io') {
		const m = /^\/((?:@[\w.-]+\/)?[\w-]{6,})(?:\/download)?\/?$/.exec(u.pathname);
		if (!m) return null;
		return { fetch: 'https://hackmd.io/' + m[1] + '/download', view: 'https://hackmd.io/' + m[1], host: 'HackMD', name: m[1] };
	}
	if (u.hostname === 'raw.githubusercontent.com' || u.hostname === 'gist.githubusercontent.com') {
		return { fetch: u.href, view: u.href, host: 'GitHub', name: decodeURIComponent(u.pathname.split('/').pop()) };
	}
	if (u.hostname === 'github.com') {
		const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
		if (!m) return null;
		return { fetch: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, view: u.href, host: 'GitHub', name: decodeURIComponent(m[3].split('/').pop()) };
	}
	if (/\.(md|markdown|marp)$/i.test(u.pathname)) {
		// any other site: works if it lets other pages read the file (CORS)
		return { fetch: u.href, view: u.href, host: u.hostname, name: decodeURIComponent(u.pathname.split('/').pop()) };
	}
	return null;
}

/** The slide looks (assets/slides/marp-NAME.css): the site's (default),
 *  white on black (HackMD's default), black on white. */
export const THEMES = ['wi', 'black', 'white'];

/** A theme name from HackMD (reveal.js) or Marp -> one of THEMES (or null). */
export function themeFor(name) {
	const n = String(name || '').trim().toLowerCase().replace(/^(['"])(.*)\1$/, '$2');
	if (THEMES.includes(n)) return n;
	if (['dark', 'night', 'league', 'blood', 'moon', 'dracula'].includes(n)) return 'black';
	if (['light', 'plain', 'simple', 'default', 'uncover'].includes(n)) return 'white';
	if (['beige', 'serif', 'sky', 'solarized', 'gaia'].includes(n)) return 'wi';
	return null;
}

/** HackMD (reveal.js-style) slide Markdown -> Marp Markdown.
 *  Returns {markdown, title, theme, paginate, slides, unsupported: [what, ...]}.
 *
 *  The theme: `opts.theme` (?theme= in the viewer) if given, else the note's
 *  (`slideOptions: theme:` or Marp's `theme:`, through themeFor), else 'wi'.
 *
 *  Handled: the YAML header (title; slideOptions.slideNumber -> page
 *  numbers; the rest is dropped), `----` (vertical slides) as `---`, empty
 *  slides at the end, `Note:` (speaker notes, dropped), `<!-- .slide:
 *  data-background="#hex|url" -->`, list items marked `<!-- .element:
 *  class="fragment" -->` (build steps), `==marked==`, `{%youtube ID %}` and
 *  `<iframe src>` (links), `<script>` (dropped; one line), `<style>` (reveal.js
 *  selectors `.reveal .slides section …` become Marp's `section …`; only
 *  with the looks black and white, which imitate HackMD: in the site's look
 *  the site's typography wins).  `*`
 *  bullets become `-` (in Marp, `*` items are build steps; on HackMD they are
 *  not).  The slides get class `hackmd` (centered, like reveal.js; not with
 *  `slideOptions: center: false`), and `typographer` is set (as on HackMD:
 *  -- → –, ... → …, "…" → “…”).
 *
 *  A Marp deck (header with `marp: true` and no `slideOptions` / `type:
 *  slide`, which mean a HackMD note) passes through unchanged apart from the
 *  theme.  Code fences are left alone throughout. */
export function hackmdToMarp(text, opts = {}) {
	text = String(text || '').replace(/\r\n?/g, '\n');
	const unsupported = new Set();
	let title = null, paginate = false, marp = false, head = '', theme = null, center = true;
	const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
	if (fm) {
		const y = fm[1];
		const t = /^title:[ \t]*(.+)$/m.exec(y);
		if (t) title = t[1].trim().replace(/^(['"])(.*)\1$/, '$2');
		paginate = /^[ \t]+slideNumber:[ \t]*(?!false\b)\S/m.test(y) || /^paginate:[ \t]*true\b/m.test(y);
		marp = /^marp:[ \t]*true\b/m.test(y) && !/^slideOptions:/m.test(y) && !/^type:[ \t]*slides?\b/m.test(y);
		center = !/^[ \t]+center:[ \t]*false\b/m.test(y);
		const th = (marp ? /^theme:[ \t]*(.+)$/m : /^[ \t]+theme:[ \t]*(.+)$/m).exec(y);
		if (th) {
			theme = themeFor(th[1]);
			if (!theme) unsupported.add('theme ' + th[1].trim() + ' (shown in the site\'s look)');
		}
		if (marp) head = y.split('\n').filter(l => !/^theme:/.test(l)).join('\n');
		text = text.slice(fm[0].length);
	}
	// line by line, outside code fences
	const out = [];
	theme = themeFor(opts.theme) || theme || 'wi';
	let fence = null, inNote = false, inStyle = false;
	for (let line of text.split('\n')) {
		const f = /^[ \t]*(```+|~~~+)/.exec(line);
		if (fence) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
			out.push(line);
			continue;
		}
		if (f) { fence = f[1]; out.push(line); continue; }
		if (/^----+[ \t]*$/.test(line)) line = '---';
		if (/^---[ \t]*$/.test(line)) { inNote = false; out.push('---'); continue; }
		if (inNote) continue;
		if (!marp && /^Note:/.test(line)) { inNote = true; continue; }
		if (!marp && (inStyle || /<style\b/i.test(line))) {
			// a note's CSS tweaks, written for reveal.js: they go with the
			// HackMD-like looks; the site's look keeps the site's typography
			inStyle = !/<\/style>/i.test(line);
			if (theme === 'wi') { unsupported.add('the note\'s <style> (used with the looks black and white)'); continue; }
			out.push(line.replace(/\.reveal(?:\s+\.slides)?\s+section\b/g, 'section').replace(/\.reveal(?:\s+\.slides)?\s+/g, '').replace(/\.reveal\b(?:\s+\.slides\b)?/g, 'section'));
			continue;
		}
		if (!marp) {
			// `*` bullets: plain list items, as on HackMD (thematic breaks stay)
			if (!/^[ \t]*(\*[ \t]*){3,}$/.test(line)) line = line.replace(/^((?:[ \t]*>)*[ \t]*)\*(?=[ \t])/, '$1-');
			line = line.replace(/<!--\s*\.slide:\s*data-background(?:-color)?="(#[0-9a-fA-F]{3,8}|[a-z]+)"[^>]*-->/g, '<!-- _backgroundColor: $1 -->');
			line = line.replace(/<!--\s*\.slide:\s*data-background(?:-image)?="(https?:[^"]+)"[^>]*-->/g, '![bg]($1)');
			if (/<!--\s*\.slide:/.test(line)) { unsupported.add('slide attributes other than a background'); line = line.replace(/<!--\s*\.slide:[^>]*-->/g, ''); }
			const li = /^([ \t]*)[-+*]([ \t]+.*?)[ \t]*<!--\s*\.element:\s*class="[^"]*\bfragment\b[^"]*"[^>]*-->[ \t]*$/.exec(line);
			if (li) line = li[1] + '*' + li[2];
			if (/<!--\s*\.element:/.test(line)) { unsupported.add('element attributes other than fragments on list items'); line = line.replace(/<!--\s*\.element:[^>]*-->/g, ''); }
			line = line.replace(/\{%\s*youtube\s+([\w-]{6,})\s*%\}/g, '[▶ Video on YouTube](https://youtu.be/$1)');
			// embedded pages cannot run in the slides: a link instead
			line = line.replace(/<iframe\b[^>]*?\bsrc="(https?:[^"]+)"[^>]*>(?:\s*<\/iframe>)?/gi, (_, u) => { unsupported.add('embedded pages (<iframe>), shown as links'); return `[▶ ${u.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '')}](${u})`; });
			if (/<script\b/i.test(line)) { unsupported.add('scripts'); line = line.replace(/<script\b[\s\S]*?(<\/script>|$)/gi, ''); }
			if (/\{%[^%]*%\}/.test(line)) { unsupported.add('HackMD embeds ({% … %}) other than YouTube'); }
			if (/^:::/.test(line)) unsupported.add('HackMD containers (::: … :::)');
			line = line.replace(/==([^=\n][^\n]*?)==/g, '<mark>$1</mark>');
		}
		out.push(line);
	}
	// drop empty slides at the start and the end
	const slides = out.join('\n').split(/^---$/m);
	while (slides.length > 1 && !slides[slides.length - 1].trim()) slides.pop();
	while (slides.length > 1 && !slides[0].trim()) slides.shift();
	const body = slides.join('---');
	if (!title) {
		const h = /^#{1,3}[ \t]+(.+)$/m.exec(body);
		if (h) title = h[1].replace(/\$[^$]*\$/g, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim() || null;
	}
	const header = marp
		? head + '\ntheme: ' + theme
		: `marp: true\ntheme: ${theme}${center ? '\nclass: hackmd' : ''}${paginate ? '\npaginate: true' : ''}`;
	return {
		markdown: `---\n${header.replace(/^\n+/, '')}\n---\n\n${body.replace(/^\n+/, '')}\n`,
		title, theme, paginate, slides: slides.length, unsupported: [...unsupported], typographer: !marp,
	};
}
