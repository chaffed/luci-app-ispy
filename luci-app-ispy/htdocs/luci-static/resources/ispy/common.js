'use strict';
'require baseclass';
'require rpc';
'require dom';

/*
 * ISPy - "I spy on my ISP"
 * Shared data handling, statistics and SVG charts for the dashboard and
 * the report.
 * SPDX-License-Identifier: MIT
 *
 * Note on E(): LuCI assigns a bare string child via innerHTML. Anything
 * that comes from the results file is therefore always passed as an array
 * child ([ text ]), which LuCI appends as a text node.
 */

var callResults = rpc.declare({
	object: 'luci.ispy', method: 'results',
	params: [ 'since', 'limit', 'offset' ], expect: { csv: '' }
});

var PAGE = 1500;
var SVGNS = 'http://www.w3.org/2000/svg';

var C = {
	down: '#2f7ed8',
	up: '#e8743b',
	ping: '#3fa66b',
	ldown: '#c0392b',
	lup: '#8e44ad',
	bad: '#d9534f',
	warn: '#d99a1c',
	good: '#3fa66b'
};

var DAYS = [ _('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun') ];

/* Peak period and bands follow the conventions of the FCC's Measuring
 * Broadband America reports: weekdays 7-11 pm local time; results grouped
 * as above 95%, 80-95% and below 80% of the advertised speed. */
var PEAK_FROM = 19, PEAK_TO = 23;
var BAND_HIGH = 0.95, BAND_LOW = 0.8;

/* ---------------------------------------------------------------- data -- */

function num(v) {
	if (v == null || v === '')
		return null;
	var n = +v;
	return isFinite(n) ? n : null;
}

/* The speed a test is credited with: the higher of what the test itself
 * measured and the total throughput seen on the WAN port while it ran.
 * Other traffic on the connection can therefore only raise the figure. */
function delivered(test, wan) {
	if (test == null) return wan;
	if (wan == null) return test;
	return Math.max(test, wan);
}

function parseCSV(text) {
	var lines = (text || '').split('\n'), rows = [];
	for (var i = 1; i < lines.length; i++) {
		var f = lines[i].split(',');
		if (f.length < 13 || !/^\d+$/.test(f[0]))
			continue;
		var ok = f[11] === 'ok';
		var r = {
			ts: +f[0], backend: f[1], server: f[2],
			ping: num(f[3]), jitter: num(f[4]), loss: num(f[5]),
			ldown: num(f[6]), lup: num(f[7]),
			/* speeds only count for tests that completed properly */
			downTest: ok ? num(f[8]) : null, upTest: ok ? num(f[9]) : null,
			bytes: num(f[10]) || 0, status: f[11], message: f[12] || '',
			downWan: ok ? num(f[13]) : null, upWan: ok ? num(f[14]) : null,
			bgDown: num(f[15]), bgUp: num(f[16]),
			cpuDown: num(f[17]), cpuUp: num(f[18]),
			link: num(f[19]), dev: f[20] || ''
		};
		r.down = delivered(r.downTest, r.downWan);
		r.up = delivered(r.upTest, r.upWan);
		if (ok && (r.down == null || r.up == null))
			continue;
		rows.push(r);
	}
	rows.sort(function(a, b) { return a.ts - b.ts });
	return rows;
}

/* Fetch all rows since a timestamp, page by page (ubus messages are size
 * limited). Resolves to CSV text: header line plus rows. */
function loadResults(since) {
	var header = '', rows = [];
	var page = function(offset) {
		return callResults(since || 0, PAGE, offset).then(function(csv) {
			var lines = (csv || '').split('\n').filter(function(l) { return l.length });
			if (lines.length)
				header = lines.shift();
			rows = rows.concat(lines);
			if (lines.length >= PAGE)
				return page(offset + PAGE);
			return [ header ].concat(rows).join('\n') + '\n';
		});
	};
	return page(0);
}

function quantile(sorted, p) {
	var i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function stats(values) {
	var v = values.filter(function(x) { return x != null }).sort(function(a, b) { return a - b });
	if (!v.length)
		return null;
	var sum = v.reduce(function(a, b) { return a + b }, 0), avg = sum / v.length;
	var sd = Math.sqrt(v.reduce(function(a, b) { return a + (b - avg) * (b - avg) }, 0) / v.length);
	return {
		n: v.length, min: v[0], max: v[v.length - 1], avg: avg, sd: sd,
		median: quantile(v, 0.5), p5: quantile(v, 0.05), p20: quantile(v, 0.2), p95: quantile(v, 0.95)
	};
}

/* ---------------------------------------------------------- formatting -- */

function fmtMbps(v) {
	if (v == null) return '–';
	if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbit/s';
	return v.toFixed(v < 10 ? 2 : 1) + ' Mbit/s';
}

/* Always Mbit/s, for tables that compare against an advertised figure. */
function fmtM(v) {
	if (v == null) return '–';
	var frac = (v < 100 && Math.abs(v - Math.round(v)) > 1e-9) ? 1 : 0;
	return v.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

/* Shares are never rounded to "0%" or "100%" unless they are exactly that. */
function fmtPct(f) {
	if (f == null) return '–';
	if (f > 0 && f < 0.005) return '<1%';
	if (f < 1 && f > 0.995) return '>99%';
	return Math.round(f * 100) + '%';
}

function fmtMs(v) {
	return v == null ? '–' : v.toFixed(v < 10 ? 1 : 0) + ' ms';
}

function fmtBytes(b) {
	if (!b) return '0 B';
	var u = [ 'B', 'kB', 'MB', 'GB', 'TB' ], i = 0;
	while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
	return b.toFixed(b < 10 && i ? 1 : 0) + ' ' + u[i];
}

function fmtTime(ts, short) {
	var d = new Date(ts * 1000);
	if (short)
		return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	return d.toLocaleString();
}

function fmtDate(ts) {
	return new Date(ts * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function axisMbps(v) {
	return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'G' : (v < 10 && v % 1 ? v.toFixed(1) : String(Math.round(v)));
}

/* Latency increase under load -> letter grade (bufferbloat). */
function bloatGrade(idle, loaded) {
	if (idle == null || loaded == null)
		return null;
	var d = Math.max(0, loaded - idle);
	var g = d < 5 ? [ 'A+', '#2e9e5b' ] : d < 30 ? [ 'A', '#3fa66b' ] : d < 60 ? [ 'B', '#8bb33a' ] :
		d < 200 ? [ 'C', '#e0a526' ] : d < 400 ? [ 'D', '#e8743b' ] : [ 'F', '#d9534f' ];
	return { grade: g[0], color: g[1], delta: d };
}

/* ------------------------------------------------------------ analysis -- */

function isPeak(ts) {
	var d = new Date(ts * 1000), dow = d.getDay(), h = d.getHours();
	return dow >= 1 && dow <= 5 && h >= PEAK_FROM && h < PEAK_TO;
}

function share(values, test) {
	var v = values.filter(function(x) { return x != null });
	return v.length ? v.filter(test).length / v.length : null;
}

/* Statistics of one direction compared with the advertised speed. */
function versusPlan(values, plan) {
	var s = stats(values);
	if (!s)
		return null;
	s.plan = plan || null;
	if (plan) {
		s.pct = s.median / plan;
		s.avgPct = s.avg / plan;
		s.maxPct = s.max / plan;
		s.p20Pct = s.p20 / plan;
		s.shareFull = share(values, function(v) { return v >= plan });
		s.shareHigh = share(values, function(v) { return v >= BAND_HIGH * plan });
		s.shareLow = share(values, function(v) { return v < BAND_LOW * plan });
		s.shareMid = Math.max(0, 1 - s.shareHigh - s.shareLow);
		s.share80 = 1 - s.shareLow;
	}
	return s;
}

function verdict(s, peak) {
	if (!s || !s.plan) return 'noplan';
	if (s.n < 24) return 'insufficient';
	if (s.pct < BAND_LOW) return 'well_below';
	if (s.pct < BAND_HIGH) return 'below';
	if (s.share80 < 0.8 || (peak && peak.n >= 10 && peak.pct < BAND_LOW)) return 'inconsistent';
	return 'met';
}

function dayKey(ts) {
	var d = new Date(ts * 1000);
	return '%04d-%02d-%02d'.format(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function medianGap(rows) {
	var gaps = [];
	for (var i = 1; i < rows.length; i++)
		gaps.push(rows[i].ts - rows[i - 1].ts);
	gaps.sort(function(a, b) { return a - b });
	return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600;
}

/* Runs of consecutive tests below 80% of the advertised download speed. */
function shortfalls(ok, plan) {
	var out = [], cur = null, maxGap = Math.max(3 * medianGap(ok), 1800);
	ok.forEach(function(r, i) {
		var low = r.down < BAND_LOW * plan;
		if (cur && (!low || r.ts - ok[i - 1].ts > maxGap)) { out.push(cur); cur = null; }
		if (low) {
			if (!cur) cur = { start: r.ts, end: r.ts, vals: [] };
			cur.end = r.ts;
			cur.vals.push(r.down);
		}
	});
	if (cur) out.push(cur);
	return out.filter(function(e) { return e.vals.length >= 2 }).map(function(e) {
		var s = stats(e.vals);
		return { start: e.start, end: e.end, n: s.n, hours: (e.end - e.start) / 3600, min: s.min, median: s.median };
	}).sort(function(a, b) { return b.hours - a.hours });
}

function countBy(rows, key) {
	var m = {}, out = [];
	rows.forEach(function(r) {
		var k = key(r);
		if (k == null || k === '') return;
		(m[k] = m[k] || []).push(r);
	});
	for (var k in m)
		out.push({ key: k, n: m[k].length, rows: m[k] });
	return out.sort(function(a, b) { return b.n - a.n });
}

/*
 * Everything the report states, computed in one place.
 *   o.planDown / o.planUp  advertised speeds (Mbit/s)
 *   o.from / o.to          period (unix seconds)
 */
function analyze(rows, o) {
	var all = rows.filter(function(r) { return r.ts >= o.from && r.ts <= o.to });
	var ok = all.filter(function(r) { return r.status === 'ok' });
	var pd = o.planDown || null, pu = o.planUp || null;
	var col = function(list, k) { return list.map(function(r) { return r[k] }) };
	var A = {
		from: o.from, to: o.to, planDown: pd, planUp: pu,
		rows: all, ok: ok,
		counts: {
			total: all.length, ok: ok.length,
			failed: all.filter(function(r) { return r.status === 'error' }).length,
			skipped: all.filter(function(r) { return r.status === 'skipped' }).length
		},
		first: ok.length ? ok[0].ts : null, last: ok.length ? ok[ok.length - 1].ts : null,
		gap: medianGap(ok)
	};

	A.down = versusPlan(col(ok, 'down'), pd);
	A.up = versusPlan(col(ok, 'up'), pu);

	var peak = ok.filter(function(r) { return isPeak(r.ts) });
	var off = ok.filter(function(r) { return !isPeak(r.ts) });
	A.peak = { n: peak.length, down: versusPlan(col(peak, 'down'), pd), up: versusPlan(col(peak, 'up'), pu) };
	A.offpeak = { n: off.length, down: versusPlan(col(off, 'down'), pd), up: versusPlan(col(off, 'up'), pu) };

	/* per calendar day */
	A.daily = countBy(ok, function(r) { return dayKey(r.ts) }).map(function(g) {
		var d = stats(col(g.rows, 'down')), u = stats(col(g.rows, 'up'));
		return {
			key: g.key, ts: g.rows[0].ts, n: g.n, down: d, up: u,
			pct: pd ? d.median / pd : null,
			share80: pd ? share(col(g.rows, 'down'), function(v) { return v >= BAND_LOW * pd }) : null
		};
	}).sort(function(a, b) { return a.key < b.key ? -1 : 1 });
	A.days = A.daily.length;
	A.daysBelow = pd ? A.daily.filter(function(d) { return d.pct < BAND_LOW }).length : 0;

	A.episodes = pd ? shortfalls(ok, pd) : [];

	/* per hour of day */
	A.hours = [];
	for (var h = 0; h < 24; h++) {
		var hr = ok.filter(function(r) { return new Date(r.ts * 1000).getHours() === h });
		A.hours.push({ h: h, n: hr.length, down: stats(col(hr, 'down')), up: stats(col(hr, 'up')) });
	}

	/* distribution of download speed as a share of the advertised speed */
	A.hist = [];
	if (pd) {
		for (var b = 0; b <= 11; b++)
			A.hist.push({ lo: b / 10, hi: b < 11 ? (b + 1) / 10 : Infinity, n: 0 });
		ok.forEach(function(r) { A.hist[Math.min(11, Math.floor(r.down / pd * 10))].n++; });
	}

	A.quality = {
		ping: stats(col(ok, 'ping')), jitter: stats(col(ok, 'jitter')), loss: stats(col(ok, 'loss')),
		ldown: stats(col(ok, 'ldown')), lup: stats(col(ok, 'lup')),
		lossy: ok.filter(function(r) { return r.loss > 0 }).length
	};

	/* measurement controls */
	var bgLimit = pd ? 0.05 * pd : null;
	var busy = function(r) { return bgLimit != null && r.bgDown != null && r.bgDown > bgLimit };
	var hot = function(r) { return r.cpuDown != null && r.cpuDown >= 90 };
	var clean = ok.filter(function(r) { return !busy(r) && !hot(r) });
	A.controls = {
		wan: ok.filter(function(r) { return r.downWan != null }).length,
		bg: stats(col(ok, 'bgDown')), bgLimit: bgLimit, bgBusy: ok.filter(busy).length,
		cpu: stats(col(ok, 'cpuDown')), cpuHot: ok.filter(hot).length,
		links: countBy(ok, function(r) { return r.link }),
		devs: countBy(ok, function(r) { return r.dev }),
		servers: countBy(ok, function(r) { return r.server || r.backend }).map(function(g) {
			return { key: g.key, n: g.n, down: versusPlan(col(g.rows, 'down'), pd) };
		}),
		flagged: ok.length - clean.length,
		cleanDown: clean.length < ok.length ? versusPlan(col(clean, 'down'), pd) : null
	};

	A.errors = countBy(all.filter(function(r) { return r.status === 'error' }), function(r) { return r.message || _('unknown error') });

	A.verdict = { down: verdict(A.down, A.peak.down), up: verdict(A.up, A.peak.up) };
	A.preliminary = A.days < 7 || ok.length < 50;
	return A;
}

/* ----------------------------------------------------------------- SVG -- */

function niceStep(range, count) {
	var raw = range / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
	return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function S(tag, attrs, children) {
	var el = document.createElementNS(SVGNS, tag);
	for (var k in attrs)
		if (attrs[k] != null)
			el.setAttribute(k, attrs[k]);
	(children || []).forEach(function(c) {
		el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	});
	return el;
}

function legend(items) {
	return E('div', { 'class': 'ispy-legend' }, items.map(function(it) {
		if (it.text)
			return E('span', { 'style': 'color:' + it.color }, [ it.label ]);
		return E('span', {}, [
			E('i', { 'style': 'background:%s%s'.format(it.color, it.dash ? ';height:0;border-top:2px dashed ' + it.color : '') }),
			it.label
		]);
	}));
}

/* Tick positions on local-time boundaries (calendar arithmetic, so they
 * stay on the hour/midnight across daylight-saving changes). */
function timeTicks(t0, t1) {
	var span = t1 - t0, steps = [ 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400 ];
	var step = steps.filter(function(s) { return span / s <= 8 })[0] || steps[steps.length - 1];
	var d0 = new Date(t0 * 1000), ticks = [], k, d;
	if (step >= 86400) {
		for (k = 0; k < 400; k += step / 86400) {
			d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k).getTime() / 1000;
			if (d > t1) break;
			if (d >= t0) ticks.push(d);
		}
	} else {
		for (k = 0; k < 400; k += step / 3600) {
			d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), k).getTime() / 1000;
			if (d > t1) break;
			if (d >= t0) ticks.push(d);
		}
	}
	return { step: step, ticks: ticks };
}

/*
 * opts.rows    result rows (sorted by ts)
 * opts.series  [{ label, color, get(row) }]
 * opts.refs    [{ value, color, label }]  dashed reference lines
 * opts.fmt     value formatter (tooltips), opts.axisFmt (axis)
 * opts.t0/t1   time window
 * opts.marks   show failed / skipped tests along the x axis
 * opts.static  plain SVG without interaction (returns the <svg>)
 */
function lineChart(opts) {
	var W = 900, H = opts.height || 240, ml = 58, mr = 12, mt = 10, mb = 26;
	var pw = W - ml - mr, ph = H - mt - mb;
	var rows = opts.rows, t0 = opts.t0, t1 = opts.t1;
	if (t1 - t0 < 3600) t0 = t1 - 3600;
	rows = rows.filter(function(r) { return r.ts >= t0 && r.ts <= t1 });

	var ymax = 0;
	rows.forEach(function(r) {
		opts.series.forEach(function(s) { var v = s.get(r); if (v != null && v > ymax) ymax = v; });
	});
	(opts.refs || []).forEach(function(rf) { if (rf.value > ymax) ymax = rf.value; });
	if (ymax <= 0) ymax = 1;
	var ystep = niceStep(ymax * 1.08, 4);
	ymax = Math.ceil(ymax * 1.08 / ystep) * ystep;

	var X = function(t) { return ml + (t - t0) / (t1 - t0) * pw; };
	var Y = function(v) { return mt + ph - v / ymax * ph; };

	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H), role: 'img',
		tabindex: (rows.length && !opts.static) ? 0 : null,
		'aria-label': opts.label ? opts.label + (opts.static ? '' : '. ' + _('Use the left and right arrow keys to step through tests.')) : null });

	for (var y = 0; y <= ymax + 1e-9; y += ystep) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(y), y2: Y(y), 'class': 'grid' }));
		svg.appendChild(S('text', { x: ml - 6, y: Y(y) + 4, 'text-anchor': 'end' }, [ opts.axisFmt(y) ]));
	}

	var tt = timeTicks(t0, t1);
	tt.ticks.forEach(function(tk) {
		var d = new Date(tk * 1000);
		var label = tt.step < 86400 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString([], { month: 'short', day: 'numeric' });
		svg.appendChild(S('line', { x1: X(tk), x2: X(tk), y1: mt, y2: mt + ph, 'class': 'grid' }));
		svg.appendChild(S('text', { x: X(tk), y: H - 8, 'text-anchor': 'middle' }, [ label ]));
	});

	(opts.refs || []).forEach(function(rf) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(rf.value), y2: Y(rf.value),
			stroke: rf.color, 'stroke-width': 1.2, 'stroke-dasharray': rf.dash || '6 4', opacity: 0.85 }));
		if (rf.label)
			svg.appendChild(S('text', { x: W - mr - 4, y: Y(rf.value) - 4, 'text-anchor': 'end', 'class': 'ref' }, [ rf.label ]));
	});

	/* break lines across gaps (scheduler off, router down) */
	var maxGap = Math.max(3 * medianGap(rows), 1800);

	opts.series.forEach(function(s) {
		var d = '', prev = null, pts = 0;
		rows.forEach(function(r) {
			var v = s.get(r);
			if (v == null) return;
			d += ((prev == null || r.ts - prev > maxGap) ? 'M' : 'L') + X(r.ts).toFixed(1) + ',' + Y(v).toFixed(1);
			prev = r.ts;
			pts++;
		});
		if (d)
			svg.appendChild(S('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 1.8,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
		if (pts > 0 && pts <= 120)
			rows.forEach(function(r) {
				var v = s.get(r);
				if (v != null)
					svg.appendChild(S('circle', { cx: X(r.ts), cy: Y(v), r: 2.4, fill: s.color }));
			});
	});

	if (opts.marks)
		rows.forEach(function(r) {
			if (r.status === 'error')        /* failed: red triangle */
				svg.appendChild(S('path', { d: 'M%f,%fl5,9h-10z'.format(X(r.ts), mt + ph - 10), fill: C.bad }));
			else if (r.status === 'skipped') /* skipped: hollow grey circle */
				svg.appendChild(S('circle', { cx: X(r.ts), cy: mt + ph - 5, r: 3.5, fill: 'none', stroke: '#888', 'stroke-width': 1.5 }));
		});

	if (opts.static)
		return svg;

	/* hover / keyboard */
	var cursor = S('line', { y1: mt, y2: mt + ph, stroke: 'currentColor', 'stroke-opacity': 0.4, visibility: 'hidden' });
	var dots = opts.series.map(function(s) { return S('circle', { r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' }); });
	var overlay = S('rect', { x: ml, y: mt, width: pw, height: ph, fill: 'transparent' });
	svg.appendChild(cursor);
	dots.forEach(function(d) { svg.appendChild(d); });
	svg.appendChild(overlay);

	var tip = E('div', { 'class': 'ispy-tip' });
	var live = E('div', { 'class': 'ispy-sr', 'aria-live': 'polite' });
	var wrap = E('div', { 'class': 'ispy-chart' }, [ svg, tip, live ]);
	var current = -1;

	function hide() {
		tip.style.display = 'none';
		cursor.setAttribute('visibility', 'hidden');
		dots.forEach(function(d) { d.setAttribute('visibility', 'hidden'); });
	}

	function showIndex(idx, announce) {
		current = idx;
		var r = rows[idx], rect = svg.getBoundingClientRect(), x = X(r.ts);
		cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
		cursor.setAttribute('visibility', 'visible');
		var lines = [ E('b', {}, [ fmtTime(r.ts) ]) ];
		opts.series.forEach(function(s, i) {
			var v = s.get(r);
			if (v != null) {
				dots[i].setAttribute('cx', x); dots[i].setAttribute('cy', Y(v));
				dots[i].setAttribute('visibility', 'visible');
			} else {
				dots[i].setAttribute('visibility', 'hidden');
			}
			lines.push(E('div', {}, [ E('span', { 'style': 'color:' + s.color }, [ '● ' ]), s.label + ': ', E('b', {}, [ opts.fmt(v) ]) ]));
		});
		if (r.status !== 'ok')
			lines.push(E('div', { 'style': 'color:#f5a3a1' }, [ (r.status === 'error' ? _('Test failed') : _('Test skipped')) + (r.message ? ': ' + r.message : '') ]));
		if (r.server)
			lines.push(E('div', { 'style': 'opacity:.7' }, [ r.server ]));
		dom.content(tip, lines);
		tip.style.display = 'block';
		if (announce)
			live.textContent = lines.map(function(n) { return n.textContent.replace('● ', ''); }).join('. ');
		var px = x / W * rect.width;
		if (px > rect.width / 2) { tip.style.left = ''; tip.style.right = (rect.width - px + 12) + 'px'; }
		else { tip.style.right = ''; tip.style.left = (px + 12) + 'px'; }
	}

	function show(ev) {
		if (!rows.length) return;
		var rect = svg.getBoundingClientRect();
		var cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
		var t = t0 + ((cx - rect.left) * W / rect.width - ml) / pw * (t1 - t0);
		var lo = 0, hi = rows.length - 1;
		while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (rows[mid].ts < t) lo = mid; else hi = mid; }
		showIndex(Math.abs(rows[lo].ts - t) < Math.abs(rows[hi].ts - t) ? lo : hi, false);
	}

	overlay.addEventListener('mousemove', show);
	overlay.addEventListener('touchstart', show, { passive: true });
	overlay.addEventListener('touchmove', show, { passive: true });
	overlay.addEventListener('mouseleave', hide);

	/* arrows step through tests, PgUp/PgDn by 24, Home/End, Esc hides */
	svg.addEventListener('keydown', function(ev) {
		var n = rows.length, i = current < 0 ? n - 1 : current, step = current < 0 ? 0 : 1;
		switch (ev.key) {
		case 'ArrowLeft': i = Math.max(0, i - step); break;
		case 'ArrowRight': i = Math.min(n - 1, i + step); break;
		case 'PageUp': i = Math.max(0, i - 24); break;
		case 'PageDown': i = Math.min(n - 1, i + 24); break;
		case 'Home': i = 0; break;
		case 'End': i = n - 1; break;
		case 'Escape': hide(); current = -1; return;
		default: return;
		}
		ev.preventDefault();
		showIndex(i, true);
	});
	svg.addEventListener('blur', function() { hide(); current = -1; });

	return wrap;
}

/* Shared frame for the category charts: y grid, returns helpers. */
function frame(H, max, axisFmt) {
	var W = 900, ml = 58, mr = 12, mt = 14, mb = 26, pw = W - ml - mr, ph = H - mt - mb;
	if (!max) max = 1;
	var step = niceStep(max * 1.08, 4);
	max = Math.ceil(max * 1.08 / step) * step;
	var Y = function(v) { return mt + ph - v / max * ph; };
	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H), role: 'img' });
	for (var y = 0; y <= max + 1e-9; y += step) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(y), y2: Y(y), 'class': 'grid' }));
		svg.appendChild(S('text', { x: ml - 6, y: Y(y) + 4, 'text-anchor': 'end' }, [ axisFmt(y) ]));
	}
	return { svg: svg, W: W, H: H, ml: ml, mr: mr, mt: mt, pw: pw, ph: ph, Y: Y, max: max };
}

function refLine(f, rf) {
	if (rf.value > f.max) return;
	f.svg.appendChild(S('line', { x1: f.ml, x2: f.W - f.mr, y1: f.Y(rf.value), y2: f.Y(rf.value),
		stroke: rf.color, 'stroke-width': 1.2, 'stroke-dasharray': rf.dash || '6 4', opacity: 0.85 }));
	if (rf.label)
		f.svg.appendChild(S('text', { x: f.W - f.mr - 4, y: f.Y(rf.value) - 4, 'text-anchor': 'end', 'class': 'ref' }, [ rf.label ]));
}

/*
 * Median speed by hour of day.
 *   hours      [{ h, n, down: stats, up: stats }]  (from analyze().hours)
 *   opts.refs  reference lines, opts.peak shades the 7-11 pm band,
 *   opts.up    also draw upload bars
 */
function hourChart(hours, opts) {
	opts = opts || {};
	var max = 0;
	hours.forEach(function(x) { max = Math.max(max, x.down ? x.down.median : 0, (opts.up && x.up) ? x.up.median : 0); });
	(opts.refs || []).forEach(function(rf) { max = Math.max(max, rf.value); });
	var f = frame(opts.height || 200, max, axisMbps), bw = f.pw / 24, base = f.mt + f.ph;

	if (opts.peak) {
		f.svg.insertBefore(S('rect', { x: f.ml + PEAK_FROM * bw, y: f.mt, width: (PEAK_TO - PEAK_FROM) * bw, height: f.ph, fill: '#888', 'fill-opacity': 0.13 }), f.svg.firstChild);
		f.svg.appendChild(S('text', { x: f.ml + (PEAK_FROM + PEAK_TO) / 2 * bw, y: f.mt - 3, 'text-anchor': 'middle', 'class': 'ref' }, [ _('peak hours') ]));
	}
	var worst = null;
	hours.forEach(function(x, h) { if (x.down && (worst == null || x.down.median < hours[worst].down.median)) worst = h; });
	hours.forEach(function(x, h) {
		var x0 = f.ml + h * bw, d = x.down ? x.down.median : null, u = x.up ? x.up.median : null;
		var title = '%02d:00 · ↓ %s · ↑ %s · %d %s'.format(h, fmtMbps(d), fmtMbps(u), x.n, _('tests'));
		if (d != null)
			f.svg.appendChild(S('rect', { x: x0 + bw * (opts.up ? 0.12 : 0.18), y: f.Y(d), width: bw * (opts.up ? 0.4 : 0.64), height: base - f.Y(d),
				fill: C.down, opacity: h === worst ? 1 : 0.75, rx: 1.5 }, [ S('title', {}, [ title ]) ]));
		if (opts.up && u != null)
			f.svg.appendChild(S('rect', { x: x0 + bw * 0.52, y: f.Y(u), width: bw * 0.36, height: base - f.Y(u),
				fill: C.up, opacity: 0.75, rx: 1.5 }, [ S('title', {}, [ title ]) ]));
		if (h % 3 === 0)
			f.svg.appendChild(S('text', { x: x0 + bw / 2, y: f.H - 8, 'text-anchor': 'middle' }, [ '%02d:00'.format(h) ]));
	});
	(opts.refs || []).forEach(function(rf) { refLine(f, rf); });
	return { svg: f.svg, worst: worst };
}

/* One bar per day: the day's median download speed, with a whisker from
 * the day's lowest to highest result. */
function dailyChart(daily, opts) {
	opts = opts || {};
	var max = 0;
	daily.forEach(function(d) { max = Math.max(max, d.down.max); });
	(opts.refs || []).forEach(function(rf) { max = Math.max(max, rf.value); });
	var f = frame(opts.height || 210, max, axisMbps), n = daily.length, bw = f.pw / Math.max(n, 7), base = f.mt + f.ph;
	var every = Math.ceil(n / 12);
	daily.forEach(function(d, i) {
		var x0 = f.ml + i * bw, xc = x0 + bw / 2, date = new Date(d.ts * 1000);
		var low = opts.plan && d.pct < BAND_LOW;
		f.svg.appendChild(S('rect', { x: x0 + bw * 0.18, y: f.Y(d.down.median), width: bw * 0.64, height: base - f.Y(d.down.median),
			fill: low ? C.bad : C.down, opacity: 0.8, rx: 1.5 },
			[ S('title', {}, [ '%s · %s (%s – %s)'.format(fmtDate(d.ts), fmtMbps(d.down.median), fmtMbps(d.down.min), fmtMbps(d.down.max)) ]) ]));
		f.svg.appendChild(S('line', { x1: xc, x2: xc, y1: f.Y(d.down.max), y2: f.Y(d.down.min), stroke: '#555', 'stroke-width': 1.2 }));
		f.svg.appendChild(S('line', { x1: xc - 3, x2: xc + 3, y1: f.Y(d.down.max), y2: f.Y(d.down.max), stroke: '#555', 'stroke-width': 1.2 }));
		f.svg.appendChild(S('line', { x1: xc - 3, x2: xc + 3, y1: f.Y(d.down.min), y2: f.Y(d.down.min), stroke: '#555', 'stroke-width': 1.2 }));
		if (i % every === 0)
			f.svg.appendChild(S('text', { x: xc, y: f.H - 8, 'text-anchor': 'middle' }, [ date.toLocaleDateString([], { month: 'short', day: 'numeric' }) ]));
	});
	(opts.refs || []).forEach(function(rf) { refLine(f, rf); });
	return f.svg;
}

/* Share of tests by download speed as a percentage of the advertised
 * speed, in 10-point steps, with the 80% and 95% marks. */
function histChart(hist, total) {
	var max = 0;
	hist.forEach(function(b) { max = Math.max(max, b.n / total * 100); });
	var f = frame(200, max, function(v) { return Math.round(v) + '%'; }), bw = f.pw / hist.length, base = f.mt + f.ph;
	hist.forEach(function(b, i) {
		var p = b.n / total * 100, x0 = f.ml + i * bw;
		var color = b.hi <= BAND_LOW + 1e-9 ? C.bad : b.lo >= 1 - 1e-9 ? C.good : C.warn;
		if (b.n)
			f.svg.appendChild(S('rect', { x: x0 + bw * 0.1, y: f.Y(p), width: bw * 0.8, height: base - f.Y(p), fill: color, opacity: 0.85, rx: 1.5 },
				[ S('title', {}, [ '%d %s'.format(b.n, _('tests')) ]) ]));
		if (b.n)
			f.svg.appendChild(S('text', { x: x0 + bw / 2, y: f.Y(p) - 4, 'text-anchor': 'middle', 'class': 'ref' }, [ Math.round(p) + '%' ]));
		f.svg.appendChild(S('text', { x: x0 + bw / 2, y: f.H - 8, 'text-anchor': 'middle' },
			[ b.hi === Infinity ? '≥110%' : '%d–%d%%'.format(Math.round(b.lo * 100), Math.round(b.hi * 100)) ]));
	});
	[ [ BAND_LOW, '80%' ], [ 1, _('advertised') ] ].forEach(function(m) {
		var x = f.ml + m[0] * 10 * bw;
		f.svg.appendChild(S('line', { x1: x, x2: x, y1: f.mt, y2: base, stroke: '#333', 'stroke-width': 1.2, 'stroke-dasharray': '5 4' }));
		f.svg.appendChild(S('text', { x: x + 4, y: f.mt + 10, 'class': 'ref' }, [ m[1] ]));
	});
	return f.svg;
}

/* Weekday x hour grid of average download speed. */
function heatmap(rows) {
	var W = 900, ml = 44, mt = 4, cw = (W - ml - 4) / 24, ch = 22, H = mt + ch * 7 + 22;
	var cells = [];
	for (var i = 0; i < 7 * 24; i++) cells.push([]);
	rows.forEach(function(r) {
		if (r.down == null) return;
		var d = new Date(r.ts * 1000);
		cells[((d.getDay() + 6) % 7) * 24 + d.getHours()].push(r.down);
	});
	var avgs = cells.map(function(c) { return c.length ? c.reduce(function(a, b) { return a + b }, 0) / c.length : null; });
	var vals = avgs.filter(function(v) { return v != null });
	var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H), role: 'img' });
	DAYS.forEach(function(dn, day) {
		svg.appendChild(S('text', { x: ml - 6, y: mt + day * ch + ch / 2 + 4, 'text-anchor': 'end' }, [ dn ]));
		for (var h = 0; h < 24; h++) {
			var v = avgs[day * 24 + h];
			var f = v == null ? 0 : (hi > lo ? (v - lo) / (hi - lo) : 1);
			/* slow = red, fast = blue */
			var col = v == null ? 'none' : f < 0.5 ? C.bad : C.down;
			var op = v == null ? 1 : 0.18 + Math.abs(f - 0.5) * 1.6;
			svg.appendChild(S('rect', {
				x: ml + h * cw + 1, y: mt + day * ch + 1, width: cw - 2, height: ch - 2, rx: 3,
				fill: col, 'fill-opacity': Math.min(op, 1),
				stroke: v == null ? 'currentColor' : 'none', 'stroke-opacity': 0.15
			}, [ S('title', {}, [ '%s %02d:00 · %s · %d %s'.format(dn, h, fmtMbps(v), cells[day * 24 + h].length, _('tests')) ]) ]));
		}
	});
	for (var h2 = 0; h2 < 24; h2 += 3)
		svg.appendChild(S('text', { x: ml + h2 * cw + cw / 2, y: H - 6, 'text-anchor': 'middle' }, [ '%02d'.format(h2) ]));
	var at = function(i) { return '%s %02d:00'.format(DAYS[Math.floor(i / 24)], i % 24); };
	var summary = _('Slowest slot: %s (%s) · fastest: %s (%s).').format(at(avgs.indexOf(lo)), fmtMbps(lo), at(avgs.indexOf(hi)), fmtMbps(hi));
	svg.setAttribute('aria-label', _('Download speed by weekday and hour.') + ' ' + summary);
	return { svg: svg, summary: summary };
}

return baseclass.extend({
	C: C, DAYS: DAYS, PEAK_FROM: PEAK_FROM, PEAK_TO: PEAK_TO, BAND_HIGH: BAND_HIGH, BAND_LOW: BAND_LOW,
	num: num, parseCSV: parseCSV, loadResults: loadResults, stats: stats, analyze: analyze, isPeak: isPeak,
	fmtMbps: fmtMbps, fmtM: fmtM, fmtPct: fmtPct, fmtMs: fmtMs, fmtBytes: fmtBytes, fmtTime: fmtTime, fmtDate: fmtDate,
	axisMbps: axisMbps, bloatGrade: bloatGrade,
	legend: legend, lineChart: lineChart, hourChart: hourChart, dailyChart: dailyChart, histChart: histChart, heatmap: heatmap
});
