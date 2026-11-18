'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require poll';
'require dom';

/*
 * ISPy - "I spy on my ISP"
 * Dashboard: throughput / latency history, statistics and patterns.
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.ispy', method: 'status' });
var callResults = rpc.declare({
	object: 'luci.ispy', method: 'results',
	params: [ 'since', 'limit' ], expect: { csv: '' }
});
var callRun = rpc.declare({ object: 'luci.ispy', method: 'run' });
var callClear = rpc.declare({ object: 'luci.ispy', method: 'clear' });

var RANGES = [
	[ '24h', _('24 hours'), 86400 ],
	[ '7d', _('7 days'), 7 * 86400 ],
	[ '30d', _('30 days'), 30 * 86400 ],
	[ '90d', _('90 days'), 90 * 86400 ],
	[ 'all', _('All'), 0 ]
];

var C = {
	down: '#2f7ed8',
	up: '#e8743b',
	ping: '#3fa66b',
	ldown: '#c0392b',
	lup: '#8e44ad',
	bad: '#d9534f'
};

var SVGNS = 'http://www.w3.org/2000/svg';
var DAYS = [ _('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun') ];

var CSS = [
	'.ispy-bar{display:flex;flex-wrap:wrap;gap:.5em;align-items:center;justify-content:space-between;margin:.5em 0 1em}',
	'.ispy-bar .ispy-info{opacity:.85}',
	'.ispy-bar .ispy-actions{display:flex;flex-wrap:wrap;gap:.4em;align-items:center}',
	'.ispy-ranges{display:inline-flex;border:1px solid rgba(127,127,127,.4);border-radius:6px;overflow:hidden}',
	'.ispy-ranges button{border:0;border-radius:0;margin:0;padding:.35em .8em;background:transparent;color:inherit;cursor:pointer}',
	'.ispy-ranges button.active{background:#2f7ed8;color:#fff}',
	'.ispy-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75em;margin-bottom:1.25em}',
	'.ispy-card{border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:.75em 1em;min-width:0}',
	'.ispy-card .k{font-size:.8em;text-transform:uppercase;letter-spacing:.04em;opacity:.7}',
	'.ispy-card .v{font-size:1.6em;font-weight:600;line-height:1.3;white-space:nowrap}',
	'.ispy-card .s{font-size:.85em;opacity:.75}',
	'.ispy-grade{display:inline-block;min-width:1.6em;text-align:center;border-radius:6px;color:#fff;padding:0 .3em}',
	'.ispy-chart{position:relative;margin:.25em 0 1.5em}',
	'.ispy-chart svg{width:100%;height:auto;display:block;overflow:visible}',
	'.ispy-chart text{fill:currentColor;font-size:11px;opacity:.75}',
	'.ispy-chart .grid{stroke:currentColor;stroke-opacity:.12}',
	'.ispy-legend{display:flex;flex-wrap:wrap;gap:1em;font-size:.9em;margin:.2em 0 .3em}',
	'.ispy-legend i{display:inline-block;width:12px;height:3px;margin-right:.35em;vertical-align:middle}',
	'.ispy-tip{position:absolute;top:4px;pointer-events:none;background:rgba(25,25,25,.92);color:#fff;padding:.45em .65em;border-radius:6px;font-size:12px;line-height:1.5;white-space:nowrap;display:none;z-index:5}',
	'.ispy-tip b{font-weight:600}',
		'.ispy-empty{padding:2em;text-align:center;opacity:.7;border:1px dashed rgba(127,127,127,.4);border-radius:8px}',
	'.ispy-ok{color:#3fa66b}.ispy-err{color:#d9534f}.ispy-skip{opacity:.6}',
	'.ispy-muted{opacity:.65;font-size:.9em}',
	'.ispy-scroll{overflow-x:auto;max-width:100%}'
].join('\n');

/* ------------------------------------------------------------ helpers -- */

function num(v) {
	if (v == null || v === '')
		return null;
	var n = +v;
	return isFinite(n) ? n : null;
}

function parseCSV(text) {
	var lines = (text || '').split('\n'), rows = [];
	for (var i = 1; i < lines.length; i++) {
		var f = lines[i].split(',');
		if (f.length < 13 || !/^\d+$/.test(f[0]))
			continue;
		rows.push({
			ts: +f[0], backend: f[1], server: f[2],
			ping: num(f[3]), jitter: num(f[4]), loss: num(f[5]),
			ldown: num(f[6]), lup: num(f[7]),
			down: num(f[8]), up: num(f[9]), bytes: num(f[10]) || 0,
			status: f[11], message: f.slice(12).join(',')
		});
	}
	rows.sort(function(a, b) { return a.ts - b.ts });
	return rows;
}

function stats(values) {
	var v = values.filter(function(x) { return x != null }).sort(function(a, b) { return a - b });
	if (!v.length)
		return null;
	var q = function(p) {
		var i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
		return v[lo] + (v[hi] - v[lo]) * (i - lo);
	};
	var sum = v.reduce(function(a, b) { return a + b }, 0), avg = sum / v.length;
	var sd = Math.sqrt(v.reduce(function(a, b) { return a + (b - avg) * (b - avg) }, 0) / v.length);
	return { n: v.length, min: v[0], max: v[v.length - 1], avg: avg, median: q(0.5), p5: q(0.05), p95: q(0.95), sd: sd };
}

function fmtMbps(v) {
	if (v == null) return '–';
	if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbit/s';
	return v.toFixed(v < 10 ? 2 : 1) + ' Mbit/s';
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

function fmtIn(sec) {
	if (sec <= 0) return _('any moment');
	if (sec < 90) return _('in %d s').format(sec);
	if (sec < 5400) return _('in %d min').format(Math.round(sec / 60));
	return _('in %.1f h').format(sec / 3600);
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
		return E('span', {}, [
			E('i', { 'style': 'background:%s%s'.format(it.color, it.dash ? ';height:0;border-top:2px dashed ' + it.color : '') }),
			it.label
		]);
	}));
}

/* ---------------------------------------------------------- line chart -- */

/*
 * opts.rows   result rows (sorted by ts)
 * opts.series [{ label, color, get(row) }]
 * opts.refs   [{ value, label, color }]  dashed reference lines
 * opts.fmt    value formatter
 * opts.t0/t1  time window
 * opts.marks  show failed tests along the x axis
 */
function lineChart(opts) {
	var W = 900, H = opts.height || 240, ml = 58, mr = 12, mt = 10, mb = 26;
	var pw = W - ml - mr, ph = H - mt - mb;
	var rows = opts.rows, t0 = opts.t0, t1 = opts.t1;
	if (t1 - t0 < 3600) t0 = t1 - 3600;

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

	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H), role: 'img' });

	/* y grid */
	for (var y = 0; y <= ymax + 1e-9; y += ystep) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(y), y2: Y(y), 'class': 'grid' }));
		svg.appendChild(S('text', { x: ml - 6, y: Y(y) + 4, 'text-anchor': 'end' }, [ opts.axisFmt(y) ]));
	}

	/* x ticks aligned to local time */
	var span = t1 - t0, steps = [ 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400 ];
	var step = steps.filter(function(s) { return span / s <= 8 })[0] || steps[steps.length - 1];
	var tzo = new Date(t0 * 1000).getTimezoneOffset() * 60;
	for (var tk = Math.ceil((t0 - tzo) / step) * step + tzo; tk <= t1; tk += step) {
		var d = new Date(tk * 1000);
		var label = step < 86400 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString([], { month: 'short', day: 'numeric' });
		svg.appendChild(S('line', { x1: X(tk), x2: X(tk), y1: mt, y2: mt + ph, 'class': 'grid' }));
		svg.appendChild(S('text', { x: X(tk), y: H - 8, 'text-anchor': 'middle' }, [ label ]));
	}

	/* reference lines (e.g. advertised plan speed) */
	(opts.refs || []).forEach(function(rf) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(rf.value), y2: Y(rf.value),
			stroke: rf.color, 'stroke-width': 1.2, 'stroke-dasharray': '6 4', opacity: 0.8 }));
	});

	/* median spacing -> break lines across gaps (scheduler off, router down) */
	var gaps = [];
	for (var i = 1; i < rows.length; i++) gaps.push(rows[i].ts - rows[i - 1].ts);
	gaps.sort(function(a, b) { return a - b });
	var maxGap = Math.max(3 * (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600), 1800);

	opts.series.forEach(function(s) {
		var d = '', prev = null, pts = 0;
		rows.forEach(function(r) {
			var v = s.get(r);
			if (v == null) return;
			var cmd = (prev == null || r.ts - prev > maxGap) ? 'M' : 'L';
			d += cmd + X(r.ts).toFixed(1) + ',' + Y(v).toFixed(1);
			prev = r.ts;
			pts++;
		});
		if (d)
			svg.appendChild(S('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 1.8,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
		if (pts > 0 && pts <= 120)
			rows.forEach(function(r) {
				var v = s.get(r);
				if (v != null)
					svg.appendChild(S('circle', { cx: X(r.ts), cy: Y(v), r: 2.4, fill: s.color }));
			});
	});

	/* failed / skipped tests as ticks on the x axis */
	if (opts.marks)
		rows.forEach(function(r) {
			if (r.status !== 'ok')
				svg.appendChild(S('rect', { x: X(r.ts) - 1.5, y: mt + ph - 8, width: 3, height: 8,
					fill: r.status === 'skipped' ? '#999' : C.bad }));
		});

	/* hover */
	var cursor = S('line', { y1: mt, y2: mt + ph, stroke: 'currentColor', 'stroke-opacity': 0.4, visibility: 'hidden' });
	var dots = opts.series.map(function(s) { return S('circle', { r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' }); });
	var overlay = S('rect', { x: ml, y: mt, width: pw, height: ph, fill: 'transparent' });
	svg.appendChild(cursor);
	dots.forEach(function(d) { svg.appendChild(d); });
	svg.appendChild(overlay);

	var tip = E('div', { 'class': 'ispy-tip' });
	var wrap = E('div', { 'class': 'ispy-chart' }, [ svg, tip ]);

	function hide() {
		tip.style.display = 'none';
		cursor.setAttribute('visibility', 'hidden');
		dots.forEach(function(d) { d.setAttribute('visibility', 'hidden'); });
	}

	function show(ev) {
		if (!rows.length) return;
		var rect = svg.getBoundingClientRect();
		var cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
		var t = t0 + ((cx - rect.left) * W / rect.width - ml) / pw * (t1 - t0);
		var lo = 0, hi = rows.length - 1;
		while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (rows[mid].ts < t) lo = mid; else hi = mid; }
		var r = Math.abs(rows[lo].ts - t) < Math.abs(rows[hi].ts - t) ? rows[lo] : rows[hi];
		var x = X(r.ts);
		cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
		cursor.setAttribute('visibility', 'visible');
		var lines = [ E('b', {}, fmtTime(r.ts)) ];
		opts.series.forEach(function(s, i) {
			var v = s.get(r);
			if (v != null) {
				dots[i].setAttribute('cx', x); dots[i].setAttribute('cy', Y(v));
				dots[i].setAttribute('visibility', 'visible');
			} else {
				dots[i].setAttribute('visibility', 'hidden');
			}
			lines.push(E('div', {}, [ E('span', { 'style': 'color:' + s.color }, '● '), s.label + ': ', E('b', {}, opts.fmt(v)) ]));
		});
		if (r.status !== 'ok' || r.message)
			lines.push(E('div', { 'style': 'color:#f5a3a1' }, (r.status === 'ok' ? '' : r.status + ': ') + (r.message || '')));
		if (r.server)
			lines.push(E('div', { 'style': 'opacity:.7' }, r.server));
		dom.content(tip, lines);
		tip.style.display = 'block';
		var px = x / W * rect.width;
		if (px > rect.width / 2) { tip.style.left = ''; tip.style.right = (rect.width - px + 12) + 'px'; }
		else { tip.style.right = ''; tip.style.left = (px + 12) + 'px'; }
	}

	overlay.addEventListener('mousemove', show);
	overlay.addEventListener('touchstart', show, { passive: true });
	overlay.addEventListener('touchmove', show, { passive: true });
	overlay.addEventListener('mouseleave', hide);

	return wrap;
}

/* ------------------------------------------------- hour-of-day bars -- */

function hourChart(rows) {
	var W = 900, H = 200, ml = 58, mr = 12, mt = 10, mb = 26, pw = W - ml - mr, ph = H - mt - mb;
	var b = [];
	for (var h = 0; h < 24; h++) b.push({ d: [], u: [] });
	rows.forEach(function(r) {
		var hr = new Date(r.ts * 1000).getHours();
		if (r.down != null) b[hr].d.push(r.down);
		if (r.up != null) b[hr].u.push(r.up);
	});
	var avg = function(a) { return a.length ? a.reduce(function(x, y) { return x + y }, 0) / a.length : null; };
	var data = b.map(function(x) { return { d: avg(x.d), u: avg(x.u), n: x.d.length }; });
	var max = 0;
	data.forEach(function(x) { max = Math.max(max, x.d || 0, x.u || 0); });
	if (!max) max = 1;
	var step = niceStep(max * 1.08, 4);
	max = Math.ceil(max * 1.08 / step) * step;
	var Y = function(v) { return mt + ph - v / max * ph; };

	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H) });
	for (var y = 0; y <= max + 1e-9; y += step) {
		svg.appendChild(S('line', { x1: ml, x2: W - mr, y1: Y(y), y2: Y(y), 'class': 'grid' }));
		svg.appendChild(S('text', { x: ml - 6, y: Y(y) + 4, 'text-anchor': 'end' }, [ axisMbps(y) ]));
	}
	var bw = pw / 24;
	var worst = null;
	data.forEach(function(x, h) { if (x.d != null && (worst == null || x.d < data[worst].d)) worst = h; });
	data.forEach(function(x, h) {
		var x0 = ml + h * bw;
		var title = '%02d:00 · ↓ %s · ↑ %s · %d %s'.format(h, fmtMbps(x.d), fmtMbps(x.u), x.n, _('tests'));
		if (x.d != null)
			svg.appendChild(S('rect', { x: x0 + bw * 0.12, y: Y(x.d), width: bw * 0.4, height: mt + ph - Y(x.d),
				fill: C.down, opacity: h === worst ? 1 : 0.75, rx: 1.5 }, [ S('title', {}, [ title ]) ]));
		if (x.u != null)
			svg.appendChild(S('rect', { x: x0 + bw * 0.52, y: Y(x.u), width: bw * 0.36, height: mt + ph - Y(x.u),
				fill: C.up, opacity: 0.75, rx: 1.5 }, [ S('title', {}, [ title ]) ]));
		if (h % 3 === 0)
			svg.appendChild(S('text', { x: x0 + bw / 2, y: H - 8, 'text-anchor': 'middle' }, [ '%02d:00'.format(h) ]));
	});
	return { el: E('div', { 'class': 'ispy-chart' }, [ svg ]), worst: worst, data: data };
}

/* ------------------------------------------ weekday x hour heatmap -- */

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
	var svg = S('svg', { viewBox: '0 0 %d %d'.format(W, H) });
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
	return E('div', { 'class': 'ispy-chart' }, [ svg ]);
}

function axisMbps(v) {
	return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'G' : (v < 10 && v % 1 ? v.toFixed(1) : Math.round(v));
}

/* ---------------------------------------------------------------- view -- */

return view.extend({
	range: '7d',
	csv: '',
	status: {},
	wasRunning: false,

	load: function() {
		try {
			var r = window.localStorage.getItem('ispy.range');
			if (r && RANGES.some(function(x) { return x[0] === r }))
				this.range = r;
		} catch (e) {}
		return Promise.all([ callStatus(), uci.load('ispy'), this.fetchResults() ]);
	},

	rangeSeconds: function() {
		var r = RANGES.filter(L.bind(function(x) { return x[0] === this.range }, this))[0];
		return r ? r[2] : 0;
	},

	fetchResults: function() {
		var secs = this.rangeSeconds();
		var since = secs ? Math.floor(Date.now() / 1000) - secs : 0;
		return callResults(since, 4000).then(L.bind(function(csv) { this.csv = csv || ''; return this.csv; }, this));
	},

	render: function(data) {
		this.status = data[0] || {};
		this.wasRunning = !!this.status.running;

		this.statusNode = E('div', { 'class': 'ispy-info' });
		this.runBtn = E('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'handleRun') }, _('Run test now'));
		this.rangeNode = E('div', { 'class': 'ispy-ranges' });
		this.body = E('div');

		var root = E('div', { 'class': 'cbi-map' }, [
			E('style', {}, CSS),
			E('h2', {}, _('ISPy Speed Monitor')),
			E('div', { 'class': 'cbi-map-descr' }, _('Scheduled speed tests of your internet connection, so you can see what your ISP really delivers – and when.')),
			E('div', { 'class': 'ispy-bar' }, [
				this.statusNode,
				E('div', { 'class': 'ispy-actions' }, [
					this.rangeNode,
					this.runBtn,
					E('button', { 'class': 'cbi-button', 'click': L.bind(this.handleExport, this) }, _('Export CSV')),
					E('button', { 'class': 'cbi-button cbi-button-negative', 'click': L.bind(this.handleClear, this) }, _('Clear history'))
				])
			]),
			this.body
		]);

		this.renderRanges();
		this.renderStatus();
		this.renderBody();

		poll.add(L.bind(this.pollStatus, this), 5);
		return root;
	},

	renderRanges: function() {
		dom.content(this.rangeNode, RANGES.map(L.bind(function(r) {
			return E('button', {
				'class': r[0] === this.range ? 'active' : '',
				'click': ui.createHandlerFn(this, 'setRange', r[0])
			}, r[1]);
		}, this)));
	},

	setRange: function(r) {
		this.range = r;
		try { window.localStorage.setItem('ispy.range', r); } catch (e) {}
		this.renderRanges();
		return this.fetchResults().then(L.bind(this.renderBody, this));
	},

	renderStatus: function() {
		var st = this.status, parts = [];
		if (st.running) {
			var phase = { ping: _('measuring latency'), download: _('testing download'), upload: _('testing upload'),
				waiting: _('waiting for the line to go quiet'), running: _('running') }[st.phase] || _('starting');
			parts.push(E('span', { 'class': 'spinning' }, _('Test in progress: %s…').format(phase)));
		} else if (st.scheduler) {
			parts.push(E('span', {}, _('Testing every %s via %s').format(
				st.interval >= 60 && st.interval % 60 === 0 ? _('%d h').format(st.interval / 60) : _('%d min').format(st.interval),
				st.resolved_backend)));
			if (st.next_run)
				parts.push(E('span', { 'class': 'ispy-muted' }, ' · ' + _('next test %s').format(fmtIn(st.next_run - (st.now || Date.now() / 1000)))));
		} else {
			parts.push(E('span', { 'class': 'ispy-err' }, st.enabled ? _('Scheduler is not running.') : _('Scheduled testing is disabled.')));
			parts.push(' ');
			parts.push(E('a', { 'href': L.url('admin/services/ispy/settings') }, _('Settings')));
		}
		dom.content(this.statusNode, parts);
		this.runBtn.disabled = !!st.running;
	},

	pollStatus: function() {
		return callStatus().then(L.bind(function(st) {
			this.status = st || {};
			this.renderStatus();
			if (this.wasRunning && !st.running)
				this.fetchResults().then(L.bind(this.renderBody, this));
			this.wasRunning = !!st.running;
		}, this));
	},

	handleRun: function() {
		return callRun().then(L.bind(function() {
			this.status.running = true;
			this.status.phase = '';
			this.wasRunning = true;
			this.renderStatus();
		}, this));
	},

	handleExport: function() {
		var blob = new Blob([ this.csv ], { type: 'text/csv' });
		var a = E('a', { 'href': URL.createObjectURL(blob), 'download': 'ispy-%s-%s.csv'.format(this.range, new Date().toISOString().slice(0, 10)) });
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	},

	handleClear: function() {
		var self = this;
		ui.showModal(_('Clear history'), [
			E('p', {}, _('Delete all stored speed test results? This cannot be undone.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
					ui.hideModal();
					return callClear().then(function() { return self.fetchResults(); }).then(L.bind(self.renderBody, self));
				} }, _('Delete'))
			])
		]);
	},

	renderBody: function() {
		var rows = parseCSV(this.csv);
		var ok = rows.filter(function(r) { return r.status === 'ok' });
		var nowTs = Math.floor(Date.now() / 1000);
		var secs = this.rangeSeconds();

		if (!rows.length) {
			dom.content(this.body, E('div', { 'class': 'ispy-empty' }, [
				E('p', {}, _('No results in this time range yet.')),
				E('p', {}, _('Press “Run test now”, or wait for the next scheduled test.'))
			]));
			return;
		}

		var t0 = secs ? nowTs - secs : rows[0].ts, t1 = nowTs;
		var planDown = num(uci.get('ispy', 'main', 'plan_down'));
		var planUp = num(uci.get('ispy', 'main', 'plan_up'));
		var interval = num(this.status.interval) || num(uci.get('ispy', 'main', 'interval')) || 60;

		var sd = stats(ok.map(function(r) { return r.down })), su = stats(ok.map(function(r) { return r.up }));
		var sp = stats(ok.map(function(r) { return r.ping })), sj = stats(ok.map(function(r) { return r.jitter }));
		var sld = stats(ok.map(function(r) { return r.ldown })), slu = stats(ok.map(function(r) { return r.lup }));
		var sl = stats(ok.map(function(r) { return r.loss }));
		var last = ok[ok.length - 1];
		var failed = rows.filter(function(r) { return r.status === 'error' }).length;
		var skipped = rows.filter(function(r) { return r.status === 'skipped' }).length;
		var bytes = rows.reduce(function(a, r) { return a + r.bytes }, 0);
		var perMonth = ok.length ? bytes / ok.length * (30 * 1440 / interval) : 0;
		var grade = bloatGrade(sp && sp.median, Math.max(sld ? sld.median : 0, slu ? slu.median : 0) || null);

		var card = function(k, v, s, color) {
			return E('div', { 'class': 'ispy-card' }, [
				E('div', { 'class': 'k' }, k),
				E('div', { 'class': 'v', 'style': color ? 'color:' + color : '' }, v),
				E('div', { 'class': 's' }, s || ' ')
			]);
		};

		var cards = [
			card(_('Download'), sd ? fmtMbps(sd.median) : '–',
				last ? _('median · last %s').format(fmtMbps(last.down)) : '', C.down),
			card(_('Upload'), su ? fmtMbps(su.median) : '–',
				last ? _('median · last %s').format(fmtMbps(last.up)) : '', C.up),
			card(_('Latency'), sp ? fmtMs(sp.median) : '–',
				sj ? _('jitter %s · loss %s%%').format(fmtMs(sj.median), sl ? sl.avg.toFixed(1) : '0') : '', C.ping),
			card(_('Bufferbloat'), grade ? E('span', { 'class': 'ispy-grade', 'style': 'background:' + grade.color }, grade.grade) : '–',
				grade ? _('+%s under load').format(fmtMs(grade.delta)) : _('needs loaded latency'))
		];

		if (planDown) {
			var meet = ok.filter(function(r) { return r.down != null && r.down >= 0.8 * planDown }).length;
			cards.push(card(_('Plan delivery'), sd ? Math.round(sd.median / planDown * 100) + '%' : '–',
				_('%d%% of tests ≥ 80%% of %s').format(ok.length ? Math.round(meet / ok.length * 100) : 0, fmtMbps(planDown))));
		}
		cards.push(card(_('Consistency'), sd && sd.avg ? Math.max(0, Math.round((1 - sd.sd / sd.avg) * 100)) + '%' : '–',
			sd ? _('worst 5%% below %s').format(fmtMbps(sd.p5)) : ''));
		cards.push(card(_('Tests'), String(rows.length),
			_('%d ok · %d failed · %d skipped').format(ok.length, failed, skipped)));
		cards.push(card(_('Test data used'), fmtBytes(bytes), _('≈ %s / month at this interval').format(fmtBytes(perMonth))));

		/* charts */
		var refs = [];
		if (planDown) refs.push({ value: planDown, color: C.down });
		if (planUp) refs.push({ value: planUp, color: C.up });

		/* Asymmetric links (e.g. cable/DSL): upload would be a flat line on the
		 * download scale, so give it a chart of its own. */
		var split = sd && su && su.max < sd.max * 0.25;
		var sDown = { label: _('Download'), color: C.down, get: function(r) { return r.down } };
		var sUp = { label: _('Upload'), color: C.up, get: function(r) { return r.up } };
		var tput = lineChart({
			rows: rows, t0: t0, t1: t1, marks: true, height: 260,
			refs: split ? refs.slice(0, planDown ? 1 : 0) : refs,
			fmt: fmtMbps, axisFmt: axisMbps,
			series: split ? [ sDown ] : [ sDown, sUp ]
		});
		var upChart = split ? lineChart({
			rows: rows, t0: t0, t1: t1, height: 170,
			refs: planUp ? [ { value: planUp, color: C.up } ] : [],
			fmt: fmtMbps, axisFmt: axisMbps, series: [ sUp ]
		}) : null;
		var lat = lineChart({
			rows: rows, t0: t0, t1: t1, height: 200,
			fmt: fmtMs, axisFmt: function(v) { return Math.round(v) + '' },
			series: [
				{ label: _('Idle'), color: C.ping, get: function(r) { return r.ping } },
				{ label: _('Loaded ↓'), color: C.ldown, get: function(r) { return r.ldown } },
				{ label: _('Loaded ↑'), color: C.lup, get: function(r) { return r.lup } }
			]
		});

		var tputLegend = [ { label: _('Download'), color: C.down } ];
		if (!split) tputLegend.push({ label: _('Upload'), color: C.up });
		if (planDown) tputLegend.push({ label: _('Plan ↓'), color: C.down, dash: true });
		if (planUp && !split) tputLegend.push({ label: _('Plan ↑'), color: C.up, dash: true });
		if (failed || skipped) tputLegend.push({ label: _('Failed / skipped test'), color: C.bad });

		var hours = hourChart(ok);
		var spanDays = (ok.length ? ok[ok.length - 1].ts - ok[0].ts : 0) / 86400;

		/* stats table */
		var statRow = function(label, s, fmt, lastV, worstIsLow) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('b', {}, label)),
				E('td', { 'class': 'td' }, fmt(lastV)),
				E('td', { 'class': 'td' }, s ? fmt(s.min) : '–'),
				E('td', { 'class': 'td' }, s ? fmt(s.median) : '–'),
				E('td', { 'class': 'td' }, s ? fmt(s.avg) : '–'),
				E('td', { 'class': 'td' }, s ? fmt(s.max) : '–'),
				E('td', { 'class': 'td' }, s ? fmt(worstIsLow ? s.p5 : s.p95) : '–')
			]);
		};
		var th = function(t) { return E('th', { 'class': 'th' }, t); };
		var statsTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ th(''), th(_('Last')), th(_('Min')), th(_('Median')), th(_('Average')), th(_('Max')), th(_('Worst 5%')) ]),
			statRow(_('Download'), sd, fmtMbps, last && last.down, true),
			statRow(_('Upload'), su, fmtMbps, last && last.up, true),
			statRow(_('Idle latency'), sp, fmtMs, last && last.ping, false),
			statRow(_('Jitter'), sj, fmtMs, last && last.jitter, false),
			statRow(_('Latency, download load'), sld, fmtMs, last && last.ldown, false),
			statRow(_('Latency, upload load'), slu, fmtMs, last && last.lup, false)
		]);

		/* recent results */
		var recent = rows.slice(-25).reverse();
		var recentTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ th(_('Time')), th(_('Download')), th(_('Upload')), th(_('Ping')),
				th(_('Jitter')), th(_('Loaded ↓ / ↑')), th(_('Server')), th(_('Status')) ])
		].concat(recent.map(function(r) {
			var cls = r.status === 'ok' ? 'ispy-ok' : r.status === 'skipped' ? 'ispy-skip' : 'ispy-err';
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, fmtTime(r.ts, true)),
				E('td', { 'class': 'td' }, fmtMbps(r.down)),
				E('td', { 'class': 'td' }, fmtMbps(r.up)),
				E('td', { 'class': 'td' }, fmtMs(r.ping)),
				E('td', { 'class': 'td' }, fmtMs(r.jitter)),
				E('td', { 'class': 'td' }, fmtMs(r.ldown) + ' / ' + fmtMs(r.lup)),
				E('td', { 'class': 'td' }, r.server || r.backend),
				E('td', { 'class': 'td' }, E('span', { 'class': cls, 'title': r.message }, r.status + (r.message ? ' – ' + r.message : '')))
			]);
		})));

		var sections = [
			E('div', { 'class': 'ispy-cards' }, cards),
			E('h3', {}, _('Throughput')),
			legend(tputLegend),
			tput,
			upChart ? legend([ { label: _('Upload'), color: C.up } ].concat(planUp ? [ { label: _('Plan ↑'), color: C.up, dash: true } ] : [])) : '',
			upChart || '',
			E('h3', {}, _('Latency')),
			legend([ { label: _('Idle'), color: C.ping }, { label: _('Under download load'), color: C.ldown }, { label: _('Under upload load'), color: C.lup } ]),
			lat,
			E('div', {}, [
				E('div', {}, [
					E('h3', {}, _('Speed by time of day')),
					legend([ { label: _('Avg download'), color: C.down }, { label: _('Avg upload'), color: C.up } ]),
					hours.el,
					hours.worst != null && ok.length >= 24
						? E('p', { 'class': 'ispy-muted' }, _('Slowest hour: %02d:00 (avg %s, %d%% of your median).').format(
							hours.worst, fmtMbps(hours.data[hours.worst].d), sd ? Math.round(hours.data[hours.worst].d / sd.median * 100) : 0))
						: E('p', { 'class': 'ispy-muted' }, _('Patterns get meaningful after a day or two of tests.'))
				]),
				spanDays >= 3 ? E('div', {}, [
					E('h3', {}, _('Weekly pattern (download)')),
					E('p', { 'class': 'ispy-muted' }, _('Blue = faster than usual, red = slower. Hover a cell for details.')),
					heatmap(ok)
				]) : E('div')
			]),
			E('h3', {}, _('Statistics')),
			E('div', { 'class': 'ispy-scroll' }, statsTable),
			E('h3', {}, _('Recent tests')),
			E('div', { 'class': 'ispy-scroll' }, recentTable)
		];

		dom.content(this.body, sections);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
