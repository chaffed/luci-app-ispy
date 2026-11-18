'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require poll';
'require dom';
'require ispy.common as ic';

/*
 * ISPy - "I spy on my ISP"
 * Dashboard: throughput / latency history, statistics and patterns.
 * SPDX-License-Identifier: MIT
 *
 * E() note: text that comes from the results file is always passed as an
 * array child ([ text ]); LuCI would assign a bare string via innerHTML.
 */

var callStatus = rpc.declare({ object: 'luci.ispy', method: 'status' });
var callRun = rpc.declare({ object: 'luci.ispy', method: 'run' });
var callClear = rpc.declare({ object: 'luci.ispy', method: 'clear' });

var RANGES = [
	[ '24h', _('24 hours'), 86400 ],
	[ '7d', _('7 days'), 7 * 86400 ],
	[ '30d', _('30 days'), 30 * 86400 ],
	[ '90d', _('90 days'), 90 * 86400 ],
	[ 'all', _('All'), 0 ]
];

var C = ic.C;

var CSS = [
	'.ispy-bar{display:flex;flex-wrap:wrap;gap:.5em;align-items:center;justify-content:space-between;margin:.5em 0 1em}',
	'.ispy-bar .ispy-info{opacity:.9}',
	'.ispy-bar .ispy-actions{display:flex;flex-wrap:wrap;gap:.4em;align-items:center}',
	'.ispy-ranges{display:inline-flex;border:1px solid rgba(127,127,127,.4);border-radius:6px;overflow:hidden}',
	'.ispy-ranges button{border:0;border-radius:0;margin:0;padding:.35em .9em;min-height:40px;min-width:44px;background:transparent;color:inherit;cursor:pointer}',
	'.ispy-ranges button.active{background:#2f7ed8;color:#fff}',
	'.ispy-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75em;margin-bottom:1.25em}',
	'.ispy-card{border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:.75em 1em;min-width:0}',
	'.ispy-card .k{font-size:.8em;text-transform:uppercase;letter-spacing:.04em;opacity:.8}',
	'.ispy-card .v{font-size:1.6em;font-weight:600;line-height:1.3;white-space:nowrap}',
	'.ispy-card .s{font-size:.85em;opacity:.75}',
	'.ispy-grade{display:inline-block;min-width:1.6em;text-align:center;border-radius:6px;color:#111;padding:0 .3em}',
	'.ispy-chart{position:relative;margin:.25em 0 1.5em}',
	'.ispy-chart svg{width:100%;height:auto;display:block;overflow:visible}',
	'.ispy-chart text{fill:currentColor;font-size:13px;opacity:.85}',
	'.ispy-chart .grid{stroke:currentColor;stroke-opacity:.12}',
	/* focus ring: off for mouse focus, on for keyboard focus (order matters) */
	'.ispy-chart svg:focus{outline:none}',
	'.ispy-ranges button:focus-visible,.ispy-chart svg:focus-visible{outline:2px solid #2f7ed8;outline-offset:2px}',
	'.ispy-legend{display:flex;flex-wrap:wrap;gap:1em;font-size:.9em;margin:.2em 0 .3em}',
	'.ispy-legend i{display:inline-block;width:12px;height:3px;margin-right:.35em;vertical-align:middle}',
	'.ispy-tip{position:absolute;top:4px;pointer-events:none;background:rgba(25,25,25,.92);color:#fff;padding:.45em .65em;border-radius:6px;font-size:12px;line-height:1.5;white-space:nowrap;display:none;z-index:5}',
	'.ispy-tip b{font-weight:600}',
	'.ispy-empty{padding:2em;text-align:center;opacity:.8;border:1px dashed rgba(127,127,127,.4);border-radius:8px}',
	'.ispy-ok{color:#3fa66b}.ispy-err{color:#d9534f}.ispy-skip{opacity:.7}',
	'.ispy-muted{opacity:.8;font-size:.9em}',
	'.ispy-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
	'.ispy-scroll{overflow-x:auto;max-width:100%}'
].join('\n');

function fmtIn(sec) {
	if (sec <= 0) return _('any moment');
	if (sec < 90) return _('in %d s').format(sec);
	if (sec < 5400) return _('in %d min').format(Math.round(sec / 60));
	return _('in %.1f h').format(sec / 3600);
}

function chartBox(svg) {
	return E('div', { 'class': 'ispy-chart' }, [ svg ]);
}

return view.extend({
	range: '7d',
	csv: '',
	status: {},
	skew: 0,
	seq: 0,
	seen: null,
	statusText: null,

	load: function() {
		try {
			var r = window.localStorage.getItem('ispy.range');
			if (r && RANGES.some(function(x) { return x[0] === r }))
				this.range = r;
		} catch (e) {}
		var self = this;
		return Promise.all([ callStatus(), uci.load('ispy') ]).then(function(data) {
			self.setStatus(data[0]);
			return self.fetchResults().then(function() { return data; });
		});
	},

	setStatus: function(st) {
		this.status = st || {};
		/* The router's clock stamps the results, so it is the reference for
		 * "now"; the browser's clock only measures elapsed time. */
		if (this.status.now)
			this.skew = this.status.now - Date.now() / 1000;
	},

	routerNow: function() {
		return Math.floor(Date.now() / 1000 + this.skew);
	},

	rangeSeconds: function() {
		var r = RANGES.filter(L.bind(function(x) { return x[0] === this.range }, this))[0];
		return r ? r[2] : 0;
	},

	/* Resolves to true if this is still the latest request when it lands. */
	fetchResults: function() {
		var secs = this.rangeSeconds(), my = ++this.seq, self = this;
		var since = secs ? this.routerNow() - secs : 0;
		return ic.loadResults(since).then(function(csv) {
			if (my !== self.seq)
				return false;
			self.csv = csv || '';
			self.seen = self.status.count + '|' + self.status.last;
			return true;
		});
	},

	reload: function() {
		return this.fetchResults().then(L.bind(function(latest) {
			if (latest)
				this.renderBody();
		}, this));
	},

	render: function() {
		this.statusNode = E('span', { 'role': 'status', 'aria-live': 'polite' });
		this.nextNode = E('span', { 'class': 'ispy-muted' });
		this.runBtn = E('button', { 'class': 'cbi-button cbi-button-action', 'click': L.bind(this.handleRun, this) }, [ _('Run test now') ]);
		this.rangeNode = E('div', { 'class': 'ispy-ranges', 'role': 'group', 'aria-label': _('Time range') });
		this.body = E('div');

		var root = E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('ISPy Speed Monitor') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('Scheduled speed tests of your internet connection, so you can see what your ISP really delivers – and when.') ]),
			E('div', { 'class': 'ispy-bar' }, [
				E('div', { 'class': 'ispy-info' }, [ this.statusNode, this.nextNode ]),
				E('div', { 'class': 'ispy-actions' }, [
					this.rangeNode,
					this.runBtn,
					E('a', { 'class': 'cbi-button', 'href': L.url('admin/services/ispy/report') }, [ _('Report') ]),
					E('button', { 'class': 'cbi-button', 'click': L.bind(this.handleExport, this) }, [ _('Export CSV') ]),
					E('button', { 'class': 'cbi-button cbi-button-negative', 'click': L.bind(this.handleClear, this) }, [ _('Clear history') ])
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
				'aria-pressed': r[0] === this.range ? 'true' : 'false',
				'click': L.bind(this.setRange, this, r[0])
			}, [ r[1] ]);
		}, this)));
	},

	setRange: function(r) {
		this.range = r;
		try { window.localStorage.setItem('ispy.range', r); } catch (e) {}
		this.renderRanges();
		return this.reload();
	},

	renderStatus: function() {
		var st = this.status, text, next = '';
		if (st.running) {
			var phase = { ping: _('measuring latency'), download: _('testing download'), upload: _('testing upload'),
				waiting: _('waiting for the line to go quiet'), running: _('running') }[st.phase] || _('starting');
			text = _('Test in progress: %s…').format(phase);
		} else if (st.synced === false) {
			text = _('Waiting for the router’s clock to synchronise before testing.');
		} else if (st.scheduler) {
			text = _('Testing every %s via %s').format(
				st.interval >= 60 && st.interval % 60 === 0 ? _('%d h').format(st.interval / 60) : _('%d min').format(st.interval),
				st.resolved_backend);
			if (st.next_run)
				next = ' · ' + _('next test %s').format(fmtIn(st.next_run - this.routerNow()));
		} else {
			text = st.enabled ? _('Scheduler is not running.') : _('Scheduled testing is disabled.');
		}
		/* The live region is only touched when its text changes, so screen
		 * readers are not interrupted by every poll; the countdown sits
		 * outside it. */
		if (text !== this.statusText) {
			this.statusText = text;
			dom.content(this.statusNode, [
				E('span', { 'class': st.running ? 'spinning' : ((st.scheduler || st.synced === false) ? '' : 'ispy-err') }, [ text ]),
				(!st.running && !st.scheduler && st.synced !== false) ? ' ' : '',
				(!st.running && !st.scheduler && st.synced !== false) ? E('a', { 'href': L.url('admin/services/ispy/settings') }, [ _('Settings') ]) : ''
			]);
		}
		this.nextNode.textContent = next;
		this.runBtn.disabled = !!st.running || st.synced === false;
		this.runBtn.textContent = st.running ? _('Testing…') : _('Run test now');
	},

	pollStatus: function() {
		return callStatus().then(L.bind(function(st) {
			this.setStatus(st);
			this.renderStatus();
			/* New rows are detected from the status itself, so nothing is
			 * missed while the tab was in the background. */
			if (this.seen !== null && this.seen !== this.status.count + '|' + this.status.last && !this.status.running)
				return this.reload();
		}, this));
	},

	handleRun: function() {
		this.runBtn.disabled = true;
		return callRun().then(L.bind(function() {
			this.status.running = true;
			this.status.phase = '';
			this.renderStatus();
		}, this));
	},

	handleExport: function() {
		var blob = new Blob([ this.csv ], { type: 'text/csv' });
		var a = E('a', { 'href': URL.createObjectURL(blob), 'download': 'ispy-%s-%s.csv'.format(this.range, new Date(this.routerNow() * 1000).toISOString().slice(0, 10)) });
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	},

	handleClear: function() {
		var self = this;
		ui.showModal(_('Clear history'), [
			E('p', {}, [ _('Delete all stored speed test results? This cannot be undone.') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': function() {
					ui.hideModal();
					return callClear().then(function() { return self.reload(); });
				} }, [ _('Delete') ])
			])
		]);
	},

	renderBody: function() {
		var rows = ic.parseCSV(this.csv);
		var nowTs = this.routerNow(), secs = this.rangeSeconds();

		if (!rows.length) {
			dom.content(this.body, E('div', { 'class': 'ispy-empty' }, [
				E('p', {}, [ _('No results in this time range yet.') ]),
				E('p', {}, [ _('Press “Run test now”, or wait for the next scheduled test.') ])
			]));
			return;
		}

		var t0 = secs ? nowTs - secs : rows[0].ts, t1 = Math.max(nowTs, rows[rows.length - 1].ts);
		var planDown = ic.num(uci.get('ispy', 'main', 'plan_down'));
		var planUp = ic.num(uci.get('ispy', 'main', 'plan_up'));
		var interval = ic.num(this.status.interval) || ic.num(uci.get('ispy', 'main', 'interval')) || 60;

		var A = ic.analyze(rows, { planDown: planDown, planUp: planUp, from: 0, to: t1 });
		var ok = A.ok, sd = A.down, su = A.up, q = A.quality, c = A.counts;
		var sp = q.ping, sj = q.jitter, sld = q.ldown, slu = q.lup, sl = q.loss;
		var last = ok[ok.length - 1];
		var bytes = rows.reduce(function(a, r) { return a + r.bytes }, 0);
		var perMonth = ok.length ? bytes / ok.length * (30 * 1440 / interval) : 0;
		var grade = ic.bloatGrade(sp && sp.median, Math.max(sld ? sld.median : 0, slu ? slu.median : 0) || null);
		var fM = ic.fmtMbps, fMs = ic.fmtMs;

		var card = function(k, v, s, color) {
			return E('div', { 'class': 'ispy-card' }, [
				E('div', { 'class': 'k' }, [ k ]),
				E('div', { 'class': 'v', 'style': color ? 'color:' + color : '' }, [ v ]),
				E('div', { 'class': 's' }, [ s || ' ' ])
			]);
		};

		var cards = [
			card(_('Download'), sd ? fM(sd.median) : '–', last ? _('median · last %s').format(fM(last.down)) : '', C.down),
			card(_('Upload'), su ? fM(su.median) : '–', last ? _('median · last %s').format(fM(last.up)) : '', C.up),
			card(_('Latency'), sp ? fMs(sp.median) : '–',
				sj ? _('jitter %s · loss %s%%').format(fMs(sj.median), sl ? sl.avg.toFixed(1) : '0') : '', C.ping),
			card(_('Bufferbloat'), grade ? E('span', { 'class': 'ispy-grade', 'style': 'background:' + grade.color }, [ grade.grade ]) : '–',
				grade ? _('+%s under load').format(fMs(grade.delta)) : _('needs loaded latency'))
		];
		if (planDown && sd)
			cards.push(card(_('Plan delivery'), ic.fmtPct(sd.pct),
				_('%s of tests ≥ 80%% of %s').format(ic.fmtPct(sd.share80), fM(planDown))));
		cards.push(card(_('Consistency'), sd && sd.avg ? Math.max(0, Math.round((1 - sd.sd / sd.avg) * 100)) + '%' : '–',
			sd ? _('worst 5%% below %s').format(fM(sd.p5)) : ''));
		cards.push(card(_('Tests'), String(rows.length), _('%d ok · %d failed · %d skipped').format(c.ok, c.failed, c.skipped)));
		cards.push(card(_('Test data used'), ic.fmtBytes(bytes), _('≈ %s / month at this interval').format(ic.fmtBytes(perMonth))));

		/* charts */
		var refs = [];
		if (planDown) refs.push({ value: planDown, color: C.down });
		if (planUp) refs.push({ value: planUp, color: C.up });

		/* Asymmetric links (e.g. cable/DSL): upload would be a flat line on the
		 * download scale, so give it a chart of its own. */
		var split = sd && su && su.max < sd.max * 0.25;
		var sDown = { label: _('Download'), color: C.down, get: function(r) { return r.down } };
		var sUp = { label: _('Upload'), color: C.up, get: function(r) { return r.up } };
		var tput = ic.lineChart({
			rows: rows, t0: t0, t1: t1, marks: true, height: 260,
			label: sd ? _('Download speed over time: median %s, range %s to %s').format(fM(sd.median), fM(sd.min), fM(sd.max)) : _('Download speed over time'),
			refs: split ? refs.slice(0, planDown ? 1 : 0) : refs,
			fmt: fM, axisFmt: ic.axisMbps,
			series: split ? [ sDown ] : [ sDown, sUp ]
		});
		var upChart = split ? ic.lineChart({
			rows: rows, t0: t0, t1: t1, height: 170,
			label: su ? _('Upload speed over time: median %s, range %s to %s').format(fM(su.median), fM(su.min), fM(su.max)) : _('Upload speed over time'),
			refs: planUp ? [ { value: planUp, color: C.up } ] : [],
			fmt: fM, axisFmt: ic.axisMbps, series: [ sUp ]
		}) : null;
		var lat = ic.lineChart({
			rows: rows, t0: t0, t1: t1, height: 200,
			label: sp ? _('Latency over time: idle median %s, under download load %s, under upload load %s').format(fMs(sp.median), fMs(sld && sld.median), fMs(slu && slu.median)) : _('Latency over time'),
			fmt: fMs, axisFmt: function(v) { return String(Math.round(v)) },
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
		if (c.failed) tputLegend.push({ label: '▲ ' + _('Failed test'), color: C.bad, text: true });
		if (c.skipped) tputLegend.push({ label: '○ ' + _('Skipped test'), color: '#888', text: true });

		var hours = ic.hourChart(A.hours, { up: true });
		var worst = hours.worst != null ? A.hours[hours.worst] : null;
		var spanDays = (ok.length ? ok[ok.length - 1].ts - ok[0].ts : 0) / 86400;
		var heat = spanDays >= 3 ? ic.heatmap(ok) : null;

		/* stats table */
		var td = function(t) { return E('td', { 'class': 'td' }, [ t ]); };
		var th = function(t) { return E('th', { 'class': 'th' }, [ t ]); };
		var statRow = function(label, s, fmt, lastV, worstIsLow) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ E('b', {}, [ label ]) ]),
				td(fmt(lastV)), td(s ? fmt(s.min) : '–'), td(s ? fmt(s.median) : '–'),
				td(s ? fmt(s.avg) : '–'), td(s ? fmt(s.max) : '–'), td(s ? fmt(worstIsLow ? s.p5 : s.p95) : '–')
			]);
		};
		var fPct = function(v) { return v == null ? '–' : Math.round(v) + '%'; };
		var k = A.controls;
		var statsTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ th(''), th(_('Last')), th(_('Min')), th(_('Median')), th(_('Average')), th(_('Max')), th(_('Worst 5%')) ]),
			statRow(_('Download'), sd, fM, last && last.down, true),
			statRow(_('Upload'), su, fM, last && last.up, true),
			statRow(_('Idle latency'), sp, fMs, last && last.ping, false),
			statRow(_('Jitter'), sj, fMs, last && last.jitter, false),
			statRow(_('Latency, download load'), sld, fMs, last && last.ldown, false),
			statRow(_('Latency, upload load'), slu, fMs, last && last.lup, false),
			statRow(_('Other traffic before test ↓'), k.bg, fM, last && last.bgDown, false),
			statRow(_('Router CPU during download (busiest core)'), k.cpu, fPct, last && last.cpuDown, false)
		]);

		/* recent results */
		var recentTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ th(_('Time')), th(_('Download')), th(_('Upload')), th(_('Ping')),
				th(_('Jitter')), th(_('Loaded ↓ / ↑')), th(_('Server')), th(_('Status')) ])
		].concat(rows.slice(-25).reverse().map(function(r) {
			var cls = r.status === 'ok' ? 'ispy-ok' : r.status === 'skipped' ? 'ispy-skip' : 'ispy-err';
			var word = r.status === 'ok' ? _('ok') : r.status === 'skipped' ? _('skipped') : _('failed');
			return E('tr', { 'class': 'tr' }, [
				td(ic.fmtTime(r.ts, true)), td(fM(r.down)), td(fM(r.up)), td(fMs(r.ping)), td(fMs(r.jitter)),
				td(fMs(r.ldown) + ' / ' + fMs(r.lup)), td(r.server || r.backend),
				E('td', { 'class': 'td' }, [ E('span', { 'class': cls }, [ word + (r.message ? ' – ' + r.message : '') ]) ])
			]);
		})));

		dom.content(this.body, [
			E('div', { 'class': 'ispy-cards' }, cards),
			E('h3', {}, [ _('Throughput') ]),
			ic.legend(tputLegend),
			tput,
			upChart ? ic.legend([ { label: _('Upload'), color: C.up } ].concat(planUp ? [ { label: _('Plan ↑'), color: C.up, dash: true } ] : [])) : '',
			upChart || '',
			E('h3', {}, [ _('Latency') ]),
			ic.legend([ { label: _('Idle'), color: C.ping }, { label: _('Under download load'), color: C.ldown }, { label: _('Under upload load'), color: C.lup } ]),
			lat,
			E('h3', {}, [ _('Speed by time of day') ]),
			ic.legend([ { label: _('Median download'), color: C.down }, { label: _('Median upload'), color: C.up } ]),
			chartBox(hours.svg),
			worst && ok.length >= 24
				? E('p', { 'class': 'ispy-muted' }, [ _('Slowest hour: %02d:00 (median %s, %d%% of the overall median).').format(
					hours.worst, fM(worst.down.median), sd ? Math.round(worst.down.median / sd.median * 100) : 0) ])
				: E('p', { 'class': 'ispy-muted' }, [ _('Patterns get meaningful after a day or two of tests.') ]),
			heat ? E('h3', {}, [ _('Weekly pattern (download)') ]) : '',
			heat ? E('p', { 'class': 'ispy-muted' }, [ _('Blue = faster than usual, red = slower. Hover a cell for details.') ]) : '',
			heat ? chartBox(heat.svg) : '',
			heat ? E('p', { 'class': 'ispy-muted' }, [ heat.summary ]) : '',
			E('h3', {}, [ _('Statistics') ]),
			E('div', { 'class': 'ispy-scroll' }, [ statsTable ]),
			E('p', { 'class': 'ispy-muted' }, [ _('Download and upload are the higher of the test’s own figure and the total traffic the router registered on its WAN port during the test, so that other devices using the connection count toward the result rather than against it.') ]),
			E('h3', {}, [ _('Recent tests') ]),
			E('div', { 'class': 'ispy-scroll' }, [ recentTable ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
