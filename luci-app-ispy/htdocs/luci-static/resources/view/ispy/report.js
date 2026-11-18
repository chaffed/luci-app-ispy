'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require dom';
'require ispy.common as ic';

/*
 * ISPy - "I spy on my ISP"
 * Report: a self-contained, printable document comparing measured speeds
 * with the advertised ones, written for a provider's support team or a
 * regulator. The document is built as a standalone HTML page (shown in an
 * iframe, printable to PDF, downloadable) so it looks the same everywhere.
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.ispy', method: 'status' });
var callMeta = rpc.declare({ object: 'luci.ispy', method: 'meta' });

var PERIODS = [
	[ '7', _('Last 7 days') ], [ '14', _('Last 14 days') ], [ '30', _('Last 30 days') ],
	[ '60', _('Last 60 days') ], [ '90', _('Last 90 days') ], [ 'all', _('All data') ], [ 'custom', _('Custom dates') ]
];

var REPORT_CSS = [
	'@page{margin:14mm 13mm}',
	'*{box-sizing:border-box}',
	'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
	'body{font:10.5pt/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c1c1e;background:#fff;margin:0 auto;padding:28px 34px;max-width:920px}',
	'.kicker{text-transform:uppercase;letter-spacing:.08em;font-size:8.5pt;color:#555}',
	'h1{font-size:20pt;line-height:1.2;margin:2px 0 12px}',
	'h2{font-size:12.5pt;margin:22px 0 8px;padding-bottom:3px;border-bottom:1.5px solid #1c1c1e;break-after:avoid}',
	'h3{font-size:10.5pt;margin:14px 0 4px;break-after:avoid}',
	'p{margin:6px 0}',
	'table{border-collapse:collapse;width:100%;font-size:9.5pt;margin:4px 0 6px}',
	'th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #d9d9d9;vertical-align:top}',
	'th{font-weight:600;background:#f1f1f1}',
	'td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
	'table.meta td:first-child{width:27%;color:#555}',
	'table.meta td{border-bottom:1px solid #e6e6e6}',
	'thead{display:table-header-group}',
	'tr{break-inside:avoid}',
	'.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}',
	'.tile{border:1px solid #c9c9c9;border-radius:6px;padding:8px 10px}',
	'.tile .k{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#555}',
	'.tile .v{font-size:17pt;font-weight:650;line-height:1.25;white-space:nowrap}',
	'.tile .s{font-size:8.5pt;color:#444}',
	'.finding{border-left:4px solid #b3261e;background:#fbeeed;padding:8px 12px;font-weight:600;margin:8px 0}',
	'.finding.ok{border-color:#2e7d4f;background:#edf7f0}',
	'.finding.neutral{border-color:#8a8a8a;background:#f3f3f3}',
	'.notice{border:1px solid #d99a1c;background:#fff7e5;padding:6px 10px;font-size:9.5pt;margin:8px 0}',
	'ul{margin:6px 0;padding-left:20px}',
	'li{margin:3px 0}',
	'.chart{margin:8px 0 2px;break-inside:avoid}',
	'.chart svg{width:100%;height:auto;display:block}',
	'.chart text{font-size:13px;fill:#333}',
	'.chart text.ref{font-size:12px;fill:#111;font-weight:600;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}',
	'.grid{stroke:#000;stroke-opacity:.12}',
	'.cap{font-size:8.8pt;color:#444;margin:0 0 10px}',
	'.low{color:#b3261e;font-weight:600}',
	'.keep{break-inside:avoid}',
	'.statement{white-space:pre-wrap;border:1px solid #d9d9d9;padding:8px 12px}',
	'footer{margin-top:24px;padding-top:6px;border-top:1px solid #c9c9c9;font-size:8.5pt;color:#555}',
	'@media print{body{padding:0;max-width:none}}'
].join('\n');

/* ------------------------------------------------------- HTML helpers -- */

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

/* cells: strings (escaped here) or { h: trustedHtml, n: rightAlign, c: cssClass } */
function cell(tag, c) {
	var o = (c != null && typeof c === 'object') ? c : { t: c };
	var cls = [ o.n ? 'n' : '', o.c || '' ].join(' ').trim();
	return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>' + (o.h != null ? o.h : esc(o.t)) + '</' + tag + '>';
}

function table(head, rows, cls) {
	return '<table' + (cls ? ' class="' + cls + '"' : '') + '>' +
		(head ? '<thead><tr>' + head.map(function(c) { return cell('th', c) }).join('') + '</tr></thead>' : '') +
		'<tbody>' + rows.map(function(r) { return '<tr>' + r.map(function(c) { return cell('td', c) }).join('') + '</tr>' }).join('') + '</tbody></table>';
}

function N(t, c) { return { t: t, n: true, c: c }; }
function chart(svg) { return '<div class="chart">' + svg.outerHTML + '</div>'; }
function cap(t) { return '<p class="cap">' + esc(t) + '</p>'; }
function mbps(v) { return v == null ? '–' : ic.fmtM(v) + ' Mbit/s'; }
function withPct(v, plan) { return mbps(v) + (plan && v != null ? ' (' + ic.fmtPct(v / plan) + ')' : ''); }

function fmtDay(ts) {
	return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtWhen(ts) {
	return new Date(ts * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtSpan(hours) {
	if (hours < 1.5) return _('about 1 hour');
	if (hours < 48) return _('%d hours').format(Math.round(hours));
	return _('%d days %d hours').format(Math.floor(hours / 24), Math.round(hours % 24));
}

function nTests(n) {
	return n === 1 ? _('1 test') : _('%d tests').format(n);
}

function fmtEvery(sec) {
	var m = Math.round(sec / 60);
	if (m < 90) return _('%d minutes').format(m);
	return _('%s hours').format((m / 60).toFixed(m % 60 ? 1 : 0));
}

var VERDICTS = {
	well_below: [ '', _('Measured %s speeds were substantially below the advertised speed.') ],
	below: [ '', _('Measured %s speeds were below the advertised speed.') ],
	inconsistent: [ '', _('The advertised %s speed was reached at times, but not consistently.') ],
	met: [ 'ok', _('Measured %s speeds were consistent with the advertised speed.') ],
	insufficient: [ 'neutral', _('There are not yet enough %s tests in this period to draw a conclusion.') ],
	noplan: [ 'neutral', _('No advertised %s speed has been entered, so no comparison is made.') ]
};

/* ------------------------------------------------------------ sections -- */

function secSummary(A) {
	var d = A.down, u = A.up, pd = A.planDown, pu = A.planUp, c = A.counts, out = [];

	[ [ 'down', _('download') ], [ 'up', _('upload') ] ].forEach(function(x) {
		var v = VERDICTS[A.verdict[x[0]]];
		out.push('<div class="finding ' + v[0] + '">' + esc(v[1].format(x[1])) + '</div>');
	});

	if (A.preliminary)
		out.push('<div class="notice">' + esc(_('Preliminary: this report covers %d valid tests on %d days. Two weeks or more of continuous testing gives a much firmer basis.').format(c.ok, A.days)) + '</div>');

	out.push('<div class="tiles">' + [
		[ _('Advertised'), pd || pu ? (pd ? ic.fmtM(pd) : '–') + ' / ' + (pu ? ic.fmtM(pu) : '–') : '–', _('Mbit/s download / upload') ],
		[ _('Median download'), d ? ic.fmtM(d.median) : '–', _('Mbit/s') + (d && pd ? ' · ' + _('%s of advertised').format(ic.fmtPct(d.pct)) : '') ],
		[ _('Peak-hour download'), A.peak.down ? ic.fmtM(A.peak.down.median) : '–',
			_('Mbit/s') + (A.peak.down && pd ? ' · ' + ic.fmtPct(A.peak.down.pct) : '') + ' · ' + _('weekdays 7–11 pm') ],
		[ _('Tests reaching 80% of advertised'), d && pd ? ic.fmtPct(d.share80) : '–', _('of %d download tests').format(c.ok) ]
	].map(function(t) {
		return '<div class="tile"><div class="k">' + esc(t[0]) + '</div><div class="v">' + esc(t[1]) + '</div><div class="s">' + esc(t[2]) + '</div></div>';
	}).join('') + '</div>');

	var li = [];
	if (c.ok)
		li.push(_('%d valid speed tests were recorded between %s and %s, on %d days, about every %s, at all hours of the day.').format(
			c.ok, fmtDay(A.first), fmtDay(A.last), A.days, fmtEvery(A.gap)));
	if (d && pd) {
		li.push(_('The median measured download speed was %s, which is %s of the advertised %s. The average was %s.').format(
			mbps(d.median), ic.fmtPct(d.pct), mbps(pd), mbps(d.avg)));
		li.push(_('%s of tests reached at least 95%% of the advertised download speed, %s were between 80%% and 95%%, and %s were below 80%%.').format(
			ic.fmtPct(d.shareHigh), ic.fmtPct(d.shareMid), ic.fmtPct(d.shareLow)));
		if (A.peak.down && A.peak.n >= 5 && A.offpeak.down)
			li.push(_('During peak hours (weekdays, 7 pm to 11 pm) the median download speed was %s (%s of advertised, %d tests). At all other times it was %s (%s).').format(
				mbps(A.peak.down.median), ic.fmtPct(A.peak.down.pct), A.peak.n, mbps(A.offpeak.down.median), ic.fmtPct(A.offpeak.down.pct)));
		if (A.daysBelow)
			li.push(_('On %d of %d days, the median download speed for the whole day was below 80%% of the advertised speed.').format(A.daysBelow, A.days));
		if (A.episodes.length)
			li.push(_('The longest unbroken run of tests below 80%% of the advertised speed lasted %s (%s to %s).').format(
				fmtSpan(A.episodes[0].hours), fmtWhen(A.episodes[0].start), fmtWhen(A.episodes[0].end)));
		li.push(d.max < pd
			? _('The highest download speed measured at any time in the period was %s, %s of the advertised speed.').format(mbps(d.max), ic.fmtPct(d.maxPct))
			: _('The highest download speed measured in the period was %s (%s of advertised), so the test equipment can measure the advertised speed when the connection delivers it.').format(mbps(d.max), ic.fmtPct(d.maxPct)));
	}
	if (u && pu)
		li.push(_('The median measured upload speed was %s, which is %s of the advertised %s; %s of tests were below 80%% of it.').format(
			mbps(u.median), ic.fmtPct(u.pct), mbps(pu), ic.fmtPct(u.shareLow)));
	if (c.failed || c.skipped)
		li.push(_('%s failed and %s skipped; these are listed under “Latency and reliability” and are not counted as slow results.').format(nTests(c.failed), nTests(c.skipped)));

	out.push('<ul>' + li.map(function(t) { return '<li>' + esc(t) + '</li>' }).join('') + '</ul>');
	return out.join('');
}

function secVersus(A) {
	var d = A.down || {}, u = A.up || {}, pd = A.planDown, pu = A.planUp;
	var row = function(label, fd, fu) { return [ label, N(d.n ? fd(d, pd) : '–'), N(u.n ? fu(u, pu) : '–') ]; };
	var both = function(label, f) { return row(label, f, f); };
	var rows = [
		[ _('Advertised speed'), N(pd ? mbps(pd) : _('not entered')), N(pu ? mbps(pu) : _('not entered')) ],
		both(_('Valid tests'), function(s) { return String(s.n) }),
		both(_('Median measured speed'), function(s, p) { return withPct(s.median, p) }),
		both(_('Average measured speed'), function(s, p) { return withPct(s.avg, p) }),
		both(_('Speed reached or exceeded in 80% of tests'), function(s, p) { return withPct(s.p20, p) }),
		both(_('Highest result in the period'), function(s, p) { return withPct(s.max, p) }),
		both(_('Lowest result in the period'), function(s, p) { return withPct(s.min, p) })
	];
	if (pd || pu) {
		var sh = function(k) { return function(s, p) { return p ? ic.fmtPct(s[k]) : '–' } };
		rows.push(both(_('Tests at 95% or more of the advertised speed'), sh('shareHigh')));
		rows.push(both(_('Tests between 80% and 95%'), sh('shareMid')));
		rows.push(both(_('Tests below 80%'), sh('shareLow')));
	}
	var html = table([ '', N(_('Download')), N(_('Upload')) ], rows);

	var pr = function(label, g) {
		return [ label, N(String(g.n)),
			N(g.down ? mbps(g.down.median) : '–'), N(g.down && pd ? ic.fmtPct(g.down.pct) : '–', g.down && pd && g.down.pct < ic.BAND_LOW ? 'low' : ''),
			N(g.down ? withPct(g.down.p20, pd) : '–'),
			N(g.up ? mbps(g.up.median) : '–'), N(g.up && pu ? ic.fmtPct(g.up.pct) : '–', g.up && pu && g.up.pct < ic.BAND_LOW ? 'low' : '') ];
	};
	html += '<h3>' + esc(_('Peak hours compared with other times')) + '</h3>' + table(
		[ _('Period'), N(_('Tests')), N(_('Median download')), N(_('% of advertised')), N(_('Reached in 80% of tests')), N(_('Median upload')), N(_('% of advertised')) ],
		[ pr(_('Peak hours (weekdays, 7 pm – 11 pm)'), A.peak), pr(_('All other times'), A.offpeak),
			pr(_('All tests'), { n: A.counts.ok, down: A.down, up: A.up }) ]);
	html += cap(_('These figures follow the conventions the FCC used in its Measuring Broadband America reports (2011–2024), which compared the median speed during peak hours (7 pm to 11 pm local time) with the advertised speed, grouped results as above 95%, 80–95% and below 80% of the advertised speed, and assessed consistency by the speed reached at least 80% of the time. Here they are applied to a single connection.'));
	return html;
}

function secCharts(A, t0, t1) {
	var pd = A.planDown, pu = A.planUp, out = [];
	var refs = function(p, color) {
		return p ? [ { value: p, color: '#111', label: _('advertised') }, { value: ic.BAND_LOW * p, color: '#b3261e', dash: '3 4', label: '80%' } ] : [];
	};
	out.push('<div class="keep"><h3>' + esc(_('Download speed, every test')) + '</h3>' + chart(ic.lineChart({
		rows: A.rows, t0: t0, t1: t1, static: true, marks: true, height: 250, refs: refs(pd),
		fmt: ic.fmtMbps, axisFmt: ic.axisMbps, label: _('Download speed of every test in the period'),
		series: [ { label: _('Download'), color: ic.C.down, get: function(r) { return r.down } } ]
	})) + cap(_('Blue line: measured download speed in Mbit/s. Dashed lines: the advertised speed and 80% of it. Triangles and circles on the baseline mark failed and skipped tests. Gaps mean no tests ran (for example, router switched off).')) + '</div>');

	if (A.days >= 3)
		out.push('<div class="keep"><h3>' + esc(_('Download speed, day by day')) + '</h3>' + chart(ic.dailyChart(A.daily, { plan: pd, refs: refs(pd) })) +
			cap(_('Bars: the median of each day’s tests. Thin lines: that day’s lowest and highest result. Days whose median is below 80% of the advertised speed are drawn in red and listed in section 5.')) + '</div>');

	out.push('<div class="keep"><h3>' + esc(_('Upload speed, every test')) + '</h3>' + chart(ic.lineChart({
		rows: A.rows, t0: t0, t1: t1, static: true, height: 170, refs: refs(pu),
		fmt: ic.fmtMbps, axisFmt: ic.axisMbps, label: _('Upload speed of every test in the period'),
		series: [ { label: _('Upload'), color: ic.C.up, get: function(r) { return r.up } } ]
	})) + '</div>');
	return out.join('');
}

function secPatterns(A) {
	var pd = A.planDown, out = [];
	if (pd && A.counts.ok)
		out.push('<div class="keep"><h3>' + esc(_('How often each speed level was measured')) + '</h3>' + chart(ic.histChart(A.hist, A.counts.ok)) +
			cap(_('Share of download tests by measured speed, as a percentage of the advertised speed. Red: below 80%. Amber: 80% to under 100%. Green: at or above the advertised speed.')) + '</div>');
	out.push('<div class="keep"><h3>' + esc(_('Download speed by time of day')) + '</h3>' + chart(ic.hourChart(A.hours, {
		peak: true, refs: pd ? [ { value: pd, color: '#111', label: _('advertised') }, { value: ic.BAND_LOW * pd, color: '#b3261e', dash: '3 4', label: '80%' } ] : []
	}).svg) + cap(_('Median download speed of all tests started in each hour of the day (local time, all days). The shaded band is 7 pm to 11 pm.')) + '</div>');
	return out.join('');
}

function secDaily(A) {
	var pd = A.planDown;
	return table(
		[ _('Date'), N(_('Tests')), N(_('Median download')), N(_('% of advertised')), N(_('Lowest')), N(_('Highest')), N(_('Tests at 80% or more')), N(_('Median upload')) ],
		A.daily.map(function(d) {
			var low = pd && d.pct < ic.BAND_LOW;
			return [ fmtDay(d.ts), N(String(d.n)), N(mbps(d.down.median), low ? 'low' : ''), N(pd ? ic.fmtPct(d.pct) : '–', low ? 'low' : ''),
				N(mbps(d.down.min)), N(mbps(d.down.max)), N(pd ? ic.fmtPct(d.share80) : '–'), N(mbps(d.up.median)) ];
		})) + (pd ? cap(_('Days whose median download speed is below 80% of the advertised speed are shown in red: %d of %d days.').format(A.daysBelow, A.days)) : '');
}

function secEpisodes(A) {
	if (!A.planDown)
		return '<p>' + esc(_('No advertised download speed has been entered.')) + '</p>';
	if (!A.episodes.length)
		return '<p>' + esc(_('There was no run of two or more consecutive tests below 80% of the advertised download speed.')) + '</p>';
	var top = A.episodes.slice(0, 12);
	return table(
		[ _('From'), _('To'), N(_('Duration')), N(_('Tests')), N(_('Lowest')), N(_('Median')) ],
		top.map(function(e) { return [ fmtWhen(e.start), fmtWhen(e.end), N(fmtSpan(e.hours)), N(String(e.n)), N(mbps(e.min)), N(mbps(e.median)) ]; })) +
		cap(_('Periods in which every consecutive test was below 80% of the advertised download speed (%s). %d such periods occurred; the %d longest are listed. Times are when the first and last test of each period started.').format(
			mbps(ic.BAND_LOW * A.planDown), A.episodes.length, top.length));
}

function secQuality(A) {
	var q = A.quality, c = A.counts, out = [];
	var r = function(label, s, f) { return [ label, N(s ? f(s.median) : '–'), N(s ? f(s.p95) : '–') ]; };
	out.push(table([ '', N(_('Median')), N(_('Worst 5% of tests')) ], [
		r(_('Latency (round trip), line idle'), q.ping, ic.fmtMs),
		r(_('Jitter'), q.jitter, ic.fmtMs),
		r(_('Latency while downloading at full speed'), q.ldown, ic.fmtMs),
		r(_('Latency while uploading at full speed'), q.lup, ic.fmtMs)
	]));
	if (q.loss)
		out.push('<p>' + esc(_('Packet loss during the idle latency check averaged %s%%; %d of %d tests saw any loss.').format(q.loss.avg.toFixed(2), q.lossy, c.ok)) + '</p>');
	out.push('<h3>' + esc(_('Tests that did not produce a result')) + '</h3>');
	if (!c.failed && !c.skipped)
		out.push('<p>' + esc(_('Every scheduled test in the period completed.')) + '</p>');
	else {
		out.push('<p>' + esc(_('%d of %d tests in the period did not produce a result. They are excluded from every speed figure in this report, so they neither raise nor lower the results.').format(c.failed + c.skipped, c.total)) + '</p>');
		var rows = A.errors.map(function(e) { return [ _('Failed') + ': ' + e.key, N(String(e.n)) ]; });
		if (c.skipped)
			rows.push([ _('Skipped: the connection was already busy with other traffic'), N(String(c.skipped)) ]);
		out.push(table([ _('Reason'), N(_('Tests')) ], rows));
	}
	return out.join('');
}

function secMethod(A, ctx) {
	var m = ctx.meta || {}, k = A.controls, pd = A.planDown, d = A.down, out = [], li = [];
	var listOf = function(groups, f) { return groups.map(function(g) { return f(g) + ' (' + nTests(g.n) + ')' }).join(', '); };
	var wired = k.links.length > 0;

	li.push(_('Tests were run automatically by the router itself (%s%s), not by a computer or phone. The router’s WAN interface is %s.').format(
		m.model || _('model not reported'), m.firmware ? ', ' + m.firmware : '',
		k.devs.length ? listOf(k.devs, function(g) { return g.key }) : (m.dev || _('not reported'))) +
		(wired ? ' ' + _('It is a wired Ethernet port, so no Wi-Fi link is part of the measured path.') : ''));
	li.push(_('A test started about every %s, day and night, with a small random offset so that tests do not always fall on the same minute. Nothing was selected by hand: every completed test in the period is included.').format(fmtEvery(A.gap)));
	li.push(_('Each test measures download and then upload for a fixed time using several parallel connections to a public test server, in the same way as common speed test services. Test servers used: %s.').format(
		listOf(k.servers, function(g) { return g.key })));
	li.push(k.wan
		? _('For each test two figures are recorded: the speed measured by the test itself, and the total data rate the router registered on its WAN interface while the test ran (which includes protocol overhead and other traffic on the connection). This report uses the higher of the two, so that overhead and other usage count toward the reported speed rather than against it.')
		: _('The speeds reported are those measured by the test itself.'));
	li.push(_('Times are local time (%s) from the router’s clock, which is synchronised over the network; no test runs until it has been.').format(ctx.tz));
	out.push('<ul>' + li.map(function(t) { return '<li>' + esc(t) + '</li>' }).join('') + '</ul>');

	/* Common explanations for slow speed test results, and what was recorded about each. */
	var rows = [];
	rows.push([ _('Wi-Fi or a slow device in the home'),
		_('Tests run on the router, at the point where the provider’s connection enters the home.'),
		wired ? _('WAN port link speed: %s.').format(listOf(k.links, function(g) { return ic.fmtM(+g.key) + ' Mbit/s' })) : _('Link speed of the WAN interface was not reported.') ]);
	rows.push([ _('Other people using the connection'),
		_('The traffic already on the connection is measured just before each test, and the reported speed is based on all traffic registered on the WAN interface.'),
		k.bg ? _('Median traffic before a test: %s. Tests that began with more than %s already in use: %d of %d.').format(
			mbps(k.bg.median), k.bgLimit != null ? mbps(k.bgLimit) : '–', k.bgBusy, A.counts.ok) : _('Not recorded for these tests.') ]);
	rows.push([ _('Router not fast enough'),
		_('Processor load is recorded during each download test.'),
		(k.cpu ? _('Median load of the busiest processor core: %d%%. Tests at 90%% or more: %d of %d.').format(Math.round(k.cpu.median), k.cpuHot, A.counts.ok) + ' ' : '') +
		(d ? _('Highest download speed this router measured in the period: %s.').format(mbps(d.max)) : '') ]);
	rows.push([ _('A slow or distant test server'),
		_('The server is recorded for every test.'),
		k.servers.map(function(g) { return g.key + ': ' + nTests(g.n) + (g.down ? ', ' + _('median %s').format(mbps(g.down.median)) : ''); }).join('; ') ]);
	out.push('<h3>' + esc(_('Checks on other possible causes of low results')) + '</h3>' +
		table([ _('Possible cause'), _('How it is controlled'), _('What was recorded') ], rows));
	if (k.cleanDown && pd)
		out.push('<p>' + esc(Math.round(d.median) === Math.round(k.cleanDown.median)
			? _('Leaving out the %s flagged above (other traffic or high processor load) leaves the median download speed unchanged at %s (%s of advertised).').format(
				nTests(k.flagged), mbps(k.cleanDown.median), ic.fmtPct(k.cleanDown.pct))
			: _('Leaving out the %s flagged above (other traffic or high processor load) changes the median download speed from %s to %s (%s of advertised).').format(
				nTests(k.flagged), mbps(d.median), mbps(k.cleanDown.median), ic.fmtPct(k.cleanDown.pct))) + '</p>');

	out.push('<h3>' + esc(_('Limits of these measurements')) + '</h3><ul>' + [
		_('The advertised speeds and the subscriber details in this report were entered by the subscriber.'),
		_('Each result is the speed between this connection and the test server at that moment. The path beyond the provider’s network can affect individual tests, which is why the report relies on many tests over many days rather than on single results.'),
		_('Tests last %s seconds per direction with %s parallel connections; the measuring software is open source (ISPy %s) and the complete per-test data is available as a CSV file.').format(
			m.duration || '–', m.streams || '–', ctx.version || '')
	].map(function(t) { return '<li>' + esc(t) + '</li>' }).join('') + '</ul>');
	return out.join('');
}

function secAppendix(A) {
	return table(
		[ _('Started'), N(_('Download')), N(_('Upload')), N(_('Test figure ↓')), N(_('WAN total ↓')), N(_('Latency')), N(_('Prior traffic ↓')), N(_('CPU')), _('Server'), _('Result') ],
		A.rows.map(function(r) {
			var f = function(v) { return v == null ? '–' : ic.fmtM(v); };
			return [ fmtWhen(r.ts), N(f(r.down)), N(f(r.up)), N(f(r.downTest)), N(f(r.downWan)), N(r.ping == null ? '–' : r.ping.toFixed(1)),
				N(f(r.bgDown)), N(r.cpuDown == null ? '–' : r.cpuDown + '%'), r.server || r.backend,
				r.status === 'ok' ? _('ok') : (r.status === 'error' ? _('failed') : _('skipped')) + (r.message ? ': ' + r.message : '') ];
		})) + cap(_('Speeds in Mbit/s, latency in ms. “Download” and “Upload” are the reported figures (the higher of the test figure and the WAN total).'));
}

/* The whole document as a standalone HTML page. */
function buildReport(A, ctx) {
	var s = ctx.sub, pd = A.planDown, pu = A.planUp, sec = 0;
	var H = function(t) { return '<h2>' + (++sec) + '. ' + esc(t) + '</h2>'; };
	var val = function(v) { return v ? esc(v) : '<span style="color:#999">' + esc(_('not entered')) + '</span>'; };
	var body = [];

	body.push('<div class="kicker">' + esc(_('Internet service performance report')) + '</div>');
	body.push('<h1>' + esc(_('Measured broadband speeds compared with advertised speeds')) + '</h1>');
	body.push(table(null, [
		[ _('Subscriber'), { h: val(s.subscriber) } ],
		[ _('Service address'), { h: val(s.address) } ],
		[ _('Provider'), { h: val(s.isp) } ],
		[ _('Account number'), { h: val(s.account) } ],
		[ _('Service plan'), { h: val(s.plan) } ],
		[ _('Advertised speed'), (pd ? mbps(pd) : _('not entered')) + ' ' + _('download') + ', ' + (pu ? mbps(pu) : _('not entered')) + ' ' + _('upload') ],
		[ _('Period covered'), fmtDay(A.from) + ' – ' + fmtDay(A.to) ],
		[ _('Report generated'), new Date(ctx.generated * 1000).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }) + ' (' + ctx.tz + ')' ]
	], 'meta'));

	if (!A.counts.ok) {
		body.push('<div class="finding neutral">' + esc(_('No completed speed tests were recorded in this period.')) + '</div>');
	} else {
		body.push(H(_('Summary of findings')) + secSummary(A));
		if (ctx.notes)
			body.push(H(_('Subscriber’s statement')) + '<div class="statement">' + esc(ctx.notes) + '</div>');
		body.push(H(_('Measured speeds compared with advertised speeds')) + secVersus(A));
		body.push(H(_('Speeds over the period')) + secCharts(A, ctx.t0, ctx.t1));
		body.push(H(_('Patterns')) + secPatterns(A));
		body.push(H(_('Results day by day')) + secDaily(A));
		body.push(H(_('Sustained periods below 80% of the advertised speed')) + secEpisodes(A));
		body.push(H(_('Latency and reliability')) + secQuality(A));
		body.push(H(_('How the measurements were made')) + secMethod(A, ctx));
		if (ctx.appendix)
			body.push('<h2>' + esc(_('Appendix: every test in the period')) + '</h2>' + secAppendix(A));
	}
	body.push('<footer>' + esc(_('Generated by ISPy %s, open-source measurement software running on the subscriber’s router (github.com/chaffed/luci-app-ispy). This report states measurements; it is not a legal opinion.').format(ctx.version || '')) + '</footer>');

	return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
		'<title>' + esc(_('Internet service performance report')) + '</title><style>' + REPORT_CSS + '</style></head><body>' + body.join('\n') + '</body></html>';
}

/* ---------------------------------------------------------------- view -- */

function download(name, type, text) {
	var a = E('a', { 'href': URL.createObjectURL(new Blob([ text ], { type: type })), 'download': name });
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

return view.extend({
	period: '30',
	csv: '',
	html: '',
	seq: 0,

	load: function() {
		return Promise.all([ callStatus(), callMeta().catch(function() { return {} }), uci.load('ispy') ]);
	},

	/* "Now" on the router's clock, which stamps the results. */
	routerNow: function() {
		return Math.floor(Date.now() / 1000 + this.skew);
	},

	window: function() {
		var now = this.routerNow();
		if (this.period === 'all')
			return { from: 0, to: now };
		if (this.period === 'custom') {
			var f = this.fromInput.value ? new Date(this.fromInput.value + 'T00:00:00').getTime() / 1000 : 0;
			var t = this.toInput.value ? new Date(this.toInput.value + 'T23:59:59').getTime() / 1000 : now;
			return { from: f || 0, to: Math.min(t || now, now) };
		}
		return { from: now - (+this.period) * 86400, to: now };
	},

	render: function(data) {
		var st = data[0] || {}, self = this;
		this.meta = data[1] || {};
		this.version = st.version || this.meta.version || '';
		this.skew = st.now ? st.now - Date.now() / 1000 : 0;

		var opt = function(k) { return uci.get('ispy', 'main', k) || ''; };
		this.planDown = ic.num(opt('plan_down'));
		this.planUp = ic.num(opt('plan_up'));
		this.sub = { isp: opt('isp_name'), plan: opt('plan_name'), subscriber: opt('subscriber'), account: opt('account'), address: opt('service_address') };

		var changed = function() { self.refresh(); };
		this.periodSel = E('select', { 'class': 'cbi-input-select', 'change': function(ev) {
			self.period = ev.target.value;
			self.customBox.style.display = self.period === 'custom' ? '' : 'none';
			self.refresh();
		} }, PERIODS.map(function(p) { return E('option', { 'value': p[0], 'selected': p[0] === self.period ? '' : null }, [ p[1] ]); }));
		this.fromInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('From date') });
		this.toInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('To date') });
		this.customBox = E('span', { 'style': 'display:none' }, [ ' ', this.fromInput, ' – ', this.toInput ]);
		this.appendixBox = E('input', { 'type': 'checkbox', 'id': 'ispy-appendix', 'change': changed });
		this.notes = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 3, 'style': 'width:100%',
			'placeholder': _('Optional: anything you want the reader to know, in your own words – for example when you first reported the problem and any ticket numbers. It is printed as “Subscriber’s statement”.'),
			'change': changed });
		this.msg = E('div');
		this.frame = E('iframe', { 'title': _('Report preview'),
			'style': 'width:100%;min-height:640px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:#fff' });
		this.frame.addEventListener('load', function() {
			try { self.frame.style.height = (self.frame.contentDocument.documentElement.scrollHeight + 24) + 'px'; } catch (e) {}
		});

		var hints = [];
		if (!this.planDown)
			hints.push(_('Your advertised speeds are not set, so the report cannot compare against them.'));
		if (!this.sub.isp || !this.sub.subscriber)
			hints.push(_('Provider and subscriber details are empty.'));
		if (this.meta.zonename && this.meta.zonename !== 'UTC') {
			var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (tz && tz !== this.meta.zonename)
				hints.push(_('This browser’s time zone (%s) differs from the router’s (%s). Times and peak hours in the report follow the browser; create the report from a device in the router’s time zone.').format(tz, this.meta.zonename));
		}

		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('ISPy Speed Monitor – Report') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('A printable record of what your connection delivered compared with what was advertised – written for your provider’s support team or a complaint to a regulator. Let tests run for at least two weeks before relying on it.') ]),
			hints.length ? E('div', { 'class': 'alert-message warning' }, [
				E('ul', { 'style': 'margin:0 0 .5em 1.2em' }, hints.map(function(h) { return E('li', {}, [ h ]); })),
				E('a', { 'class': 'cbi-button', 'href': L.url('admin/services/ispy/settings') }, [ _('Open settings → My plan') ])
			]) : '',
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.6em 1em;align-items:center;margin:.75em 0' }, [
				E('label', {}, [ _('Period') + ' ', this.periodSel ]),
				this.customBox,
				E('label', { 'for': 'ispy-appendix' }, [ this.appendixBox, ' ' + _('Include a table of every test') ])
			]),
			this.notes,
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.5em;margin:.75em 0' }, [
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': function() { self.handlePrint(); } }, [ _('Print / save as PDF') ]),
				E('button', { 'class': 'cbi-button', 'click': function() { self.handleDownload(); } }, [ _('Download report (HTML)') ]),
				E('button', { 'class': 'cbi-button', 'click': function() { self.handleCsv(); } }, [ _('Download the data (CSV)') ])
			]),
			this.msg,
			this.frame
		]);

		this.refresh();
		return root;
	},

	refresh: function() {
		var self = this, w = this.window(), my = ++this.seq;
		dom.content(this.msg, E('em', { 'class': 'spinning' }, [ _('Loading results…') ]));
		return ic.loadResults(w.from).then(function(csv) {
			if (my !== self.seq)
				return; /* a newer request has been made since */
			self.csv = csv;
			self.win = w;
			var rows = ic.parseCSV(csv);
			var A = ic.analyze(rows, { planDown: self.planDown, planUp: self.planUp, from: w.from, to: w.to });
			/* "All data": start the period at the first test */
			if (!w.from && A.rows.length)
				A.from = A.rows[0].ts;
			self.html = buildReport(A, {
				sub: self.sub, meta: self.meta, version: self.version,
				tz: Intl.DateTimeFormat().resolvedOptions().timeZone || _('local time'),
				generated: self.routerNow(), notes: self.notes.value.trim(), appendix: self.appendixBox.checked,
				t0: A.from, t1: w.to
			});
			self.frame.srcdoc = self.html;
			dom.content(self.msg, '');
		}).catch(function(e) {
			dom.content(self.msg, E('div', { 'class': 'alert-message error' }, [ _('Could not load the results: %s').format(e && e.message || e) ]));
		});
	},

	stamp: function() {
		return new Date(this.routerNow() * 1000).toISOString().slice(0, 10);
	},

	handlePrint: function() {
		var w = this.frame.contentWindow;
		if (w) { w.focus(); w.print(); }
	},

	handleDownload: function() {
		download('internet-performance-report-%s.html'.format(this.stamp()), 'text/html', this.html);
	},

	handleCsv: function() {
		var w = this.win || this.window();
		var lines = this.csv.split('\n').filter(function(l, i) {
			var ts = +l.split(',')[0];
			return i === 0 || (ts >= w.from && ts <= w.to);
		});
		download('speed-test-data-%s.csv'.format(this.stamp()), 'text/csv', lines.join('\n') + '\n');
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
