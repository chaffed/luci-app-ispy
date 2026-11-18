/*
 * Checks the statistics behind the dashboard and the report against an
 * independent calculation done straight from the CSV text.
 * Run: node tests/analysis.test.js
 */
var fs = require('fs'), path = require('path'), gen = require('./gen.js');
gen.installFormat();
global._ = function(s) { return s; };

var store = [];   /* rows served by the fake "results" RPC */
var calls = 0;
var rpc = { declare: function() {
	return function(since, limit, offset) {
		calls++;
		var rows = store.filter(function(l) { return +l.split(',')[0] >= since; }).slice(offset, offset + limit);
		return Promise.resolve([ gen.HEADER ].concat(rows).join('\n') + '\n');
	};
} };
var src = fs.readFileSync(path.join(__dirname, '../luci-app-ispy/htdocs/luci-static/resources/ispy/common.js'), 'utf8');
var ic = new Function('baseclass', 'rpc', 'dom', src)({ extend: function(o) { return o; } }, rpc, {});

var fail = 0;
function eq(name, got, want, tol) {
	var ok = Math.abs(got - want) <= (tol || 1e-9);
	if (!ok) fail++;
	console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + got + (ok ? '' : ' (expected ' + want + ')'));
}
function med(a) { var n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
function asc(a, b) { return a - b; }

var now = Math.floor(new Date(2026, 10, 17, 12, 0, 0).getTime() / 1000);
var csv = gen.make(now, 30);
var rows = ic.parseCSV(csv);
var A = ic.analyze(rows, { planDown: 1000, planUp: 40, from: now - 30 * 86400, to: now });

var raw = csv.trim().split('\n').slice(1).map(function(l) { return l.split(','); });
var okRaw = raw.filter(function(f) { return f[11] === 'ok'; });
var eff = okRaw.map(function(f) { return Math.max(+f[8], +f[13]); }).sort(asc);

eq('valid tests', A.counts.ok, okRaw.length);
eq('failed tests', A.counts.failed, raw.filter(function(f) { return f[11] === 'error'; }).length);
eq('skipped tests', A.counts.skipped, raw.filter(function(f) { return f[11] === 'skipped'; }).length);
eq('median download', A.down.median, med(eff));
eq('median as share of advertised', A.down.pct, med(eff) / 1000);
eq('share below 80%', A.down.shareLow, eff.filter(function(v) { return v < 800; }).length / eff.length);
eq('share at 95% or more', A.down.shareHigh, eff.filter(function(v) { return v >= 950; }).length / eff.length);
eq('bands sum to 1', A.down.shareLow + A.down.shareMid + A.down.shareHigh, 1, 1e-12);
var pk = okRaw.filter(function(f) { var d = new Date(f[0] * 1000); return d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 19 && d.getHours() < 23; });
eq('peak-hour tests', A.peak.n, pk.length);
eq('peak-hour median', A.peak.down.median, med(pk.map(function(f) { return Math.max(+f[8], +f[13]); }).sort(asc)));
eq('peak + off-peak = all', A.peak.n + A.offpeak.n, okRaw.length);
var days = {};
okRaw.forEach(function(f) { days[new Date(f[0] * 1000).toDateString()] = 1; });
eq('days with data', A.days, Object.keys(days).length);
eq('daily counts sum to tests', A.daily.reduce(function(a, d) { return a + d.n; }, 0), okRaw.length);
eq('histogram sums to tests', A.hist.reduce(function(a, b) { return a + b.n; }, 0), okRaw.length);
eq('hourly counts sum to tests', A.hours.reduce(function(a, h) { return a + h.n; }, 0), okRaw.length);
eq('highest download', A.down.max, eff[eff.length - 1]);

/* shortfall runs really are all below 80%, and are not bridged across the outage */
var okRows = rows.filter(function(r) { return r.status === 'ok'; }), badRun = 0;
A.episodes.forEach(function(e) {
	var inside = okRows.filter(function(r) { return r.ts >= e.start && r.ts <= e.end; });
	if (inside.length !== e.n || inside.some(function(r) { return r.down >= 800; })) badRun++;
});
eq('shortfall runs are consistent', badRun, 0);
eq('failed tests carry no speed', rows.filter(function(r) { return r.status !== 'ok' && (r.down != null || r.up != null); }).length, 0);
eq('reported = higher of test and WAN figure', rows.filter(function(r) { return r.status === 'ok' && (r.down !== Math.max(r.downTest, r.downWan) || r.up !== Math.max(r.upTest, r.upWan)); }).length, 0);
eq('verdict: well below', +(A.verdict.down === 'well_below'), 1);

/* a line that delivers must be reported as such */
var good = ic.analyze(ic.parseCSV(gen.make(now, 30, { good: true })), { planDown: 1000, planUp: 40, from: now - 30 * 86400, to: now });
eq('verdict for a good line: met', +(good.verdict.down === 'met' && good.verdict.up === 'met'), 1);
eq('good line has no shortfall runs', good.episodes.length, 0);

/* too little data gives no verdict */
var few = ic.analyze(ic.parseCSV(gen.make(now, 0.5)), { planDown: 1000, planUp: 40, from: now - 86400, to: now });
eq('verdict with half a day of data: insufficient', +(few.verdict.down === 'insufficient' && few.preliminary), 1);

/* files written by v1.0 (13 columns) still load */
var old = ic.parseCSV('h\n1700000000,cloudflare,X,10,1,0,20,30,500,20,1000,ok,\n');
eq('v1.0 row parses', +(old.length === 1 && old[0].down === 500 && old[0].downWan === null), 1);

/* shares never round to 0% / 100% unless exact */
eq('fmtPct(0.004) is <1%', +(ic.fmtPct(0.004) === '<1%'), 1);
eq('fmtPct(0.998) is >99%', +(ic.fmtPct(0.998) === '>99%'), 1);

/* paging: every row arrives exactly once */
store = [];
for (var i = 0; i < 3200; i++) store.push((1700000000 + i * 600) + ',cloudflare,X,10,1,0,20,30,500,20,1000,ok,');
calls = 0;
ic.loadResults(0).then(function(text) {
	var got = ic.parseCSV(text), seen = {};
	got.forEach(function(r) { seen[r.ts] = 1; });
	eq('paged load returns all rows', got.length, 3200);
	eq('paged load has no duplicates', Object.keys(seen).length, 3200);
	eq('paged load used 3 requests', calls, 3);
	console.log(fail ? fail + ' FAILED' : 'all passed');
	process.exit(fail ? 1 : 0);
});
