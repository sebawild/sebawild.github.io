/* Current week in a module's units table, for wild-inter.net teaching pages.
 *
 * Loaded by _includes/this-week.html (put that include where the
 * "This week: ..." line should appear, e.g. below the Quick links).
 *
 * Finds the table(s) on the page with a column of YYYY-MM-DD dates (the
 * "w/c (Mon)" column) and groups the rows by week: a row with a date starts
 * a new week unless its date lies within the previous one (e.g. a Tuesday
 * row); rows without a date (second unit, notes like "Pfingstmontag") belong
 * to the week above them. The rows of the week containing today get the class
 * "current-week" (styled in _sass/_tables.scss), and the "This week" line is
 * filled with the non-empty cells of those rows (units, sheets, notes).
 * Date cells get the class "week-date" (no line break inside the date).
 *
 * Weeks run Monday to Sunday. Outside the term (before the first or after the
 * last week, e.g. on archived pages) nothing happens and the line stays
 * hidden. Without JavaScript, the page is unchanged.
 *
 * Testing: append ?today=2026-11-04 to the URL to pretend another date.
 */
(function () {
	'use strict';

	var DATE = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/;
	var EMPTY = /^[\s\u2014\u2013\-]*$/;           // blank, ---, —, –

	function parse(s) {
		var m = DATE.exec(s);
		return m ? new Date(+m[1], m[2] - 1, +m[3]) : null;
	}
	function addDays(d, n) {
		var r = new Date(d.getTime());
		r.setDate(r.getDate() + n);
		return r;
	}
	function monday(d) {
		return addDays(d, -((d.getDay() + 6) % 7));
	}
	function cellText(row, i) {
		var c = row.cells[i];
		return c ? c.textContent : '';
	}

	var today = new Date();
	today.setHours(0, 0, 0, 0);
	var fake = /[?&]today=(\d{4}-\d{2}-\d{2})/.exec(location.search);
	if (fake) today = parse(fake[1]);

	function weeks(table) {
		var rows = [];
		for (var b = 0; b < table.tBodies.length; b++) {
			rows.push.apply(rows, table.tBodies[b].rows);
		}
		// the date column: the one with the most YYYY-MM-DD cells (at least 3)
		var counts = [], col = -1;
		rows.forEach(function (r) {
			for (var i = 0; i < r.cells.length; i++) {
				if (DATE.test(r.cells[i].textContent)) counts[i] = (counts[i] || 0) + 1;
			}
		});
		counts.forEach(function (n, i) {
			if (n >= 3 && (col < 0 || n > counts[col])) col = i;
		});
		if (col < 0) return null;
		rows.forEach(function (r) {                // lets CSS keep dates on one line
			if (r.cells[col]) r.cells[col].classList.add('week-date');
		});

		var list = [], cur = null;
		rows.forEach(function (r) {
			var d = parse(cellText(r, col));
			if (d && (!cur || d >= addDays(cur.start, 7))) {
				cur = { start: monday(d), rows: [] };
				list.push(cur);
			}
			if (cur) cur.rows.push(r);
		});
		return { col: col, list: list };
	}

	function fillLine(line, week, col) {
		var seen = {}, items = [];
		var ncols = week.rows[0].cells.length;
		for (var i = 1; i < ncols; i++) {           // column by column: units, then sheets
			if (i === col) continue;
			week.rows.forEach(function (r) {
				var c = r.cells[i];
				var text = c ? c.textContent.replace(/\s+/g, ' ').trim() : '';
				if (EMPTY.test(text) || seen[text]) return;
				seen[text] = true;
				items.push(c.innerHTML.trim());
			});
		}
		if (!items.length) return;
		line.querySelector('.this-week-what').innerHTML = items.join('&ensp;|&ensp;');
		line.hidden = false;
	}

	var line = document.querySelector('.this-week');
	var tables = document.querySelectorAll('table');
	for (var t = 0; t < tables.length; t++) {
		var w = weeks(tables[t]);
		if (!w) continue;
		for (var k = 0; k < w.list.length; k++) {
			var week = w.list[k];
			if (today < week.start || today >= addDays(week.start, 7)) continue;
			week.rows.forEach(function (r) { r.classList.add('current-week'); });
			week.rows[0].cells[w.col].setAttribute('aria-current', 'date');
			if (line && line.hidden) fillLine(line, week, w.col);
		}
	}
})();
