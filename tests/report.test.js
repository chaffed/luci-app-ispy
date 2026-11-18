/*
 * Runs the script of the self-contained report file (the one `ispy export`
 * saves to an attached drive) against a small stand-in for the browser, with
 * the two modules wrapped exactly as the router wraps them, and checks what
 * it draws.
 * Run: node tests/report.test.js
 */
process.env.TZ = 'America/Los_Angeles';   /* the same answers on every machine */
var fs = require('fs'), path = require('path'), gen = require('./gen.js');
var PKG = path.join(__dirname, '../luci-app-ispy');
var FILES = {
	common: path.join(PKG, 'htdocs/luci-static/resources/ispy/common.js'),
	report: path.join(PKG, 'htdocs/luci-static/resources/ispy/report.js'),
	standalone: path.join(PKG, 'root/usr/share/ispy/standalone.js'),
	page: path.join(PKG, 'root/usr/share/ispy/standalone.html')
};
var src = {};
Object.keys(FILES).forEach(function(k) { src[k] = fs.readFileSync(FILES[k], 'utf8'); });

var fail = 0;
function ok(name, cond, detail) {
	if (!cond) fail++;
	console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail == null ? '' : ': ' + detail));
}

/* ---- just enough of a browser ---- */

function esc(s, attr) {
	return String(s).replace(/[&<>"]/g, function(c) {
		return c === '"' && !attr ? c : { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
	});
}
function Node() {}
function Text(t) { this.text = String(t); }
Text.prototype = Object.create(Node.prototype);
Object.defineProperty(Text.prototype, 'textContent', { get: function() { return this.text; } });
Object.defineProperty(Text.prototype, 'outerHTML', { get: function() { return esc(this.text); } });

function El(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.hidden = false; this.checked = false; this.html = null; }
El.prototype = Object.create(Node.prototype);
El.prototype.setAttribute = function(k, v) { this.attrs[k] = String(v); };
El.prototype.appendChild = function(c) { this.kids.push(c); return c; };
El.prototype.insertBefore = function(c) { this.kids.unshift(c); return c; };
El.prototype.querySelector = function() { return null; };
El.prototype.addEventListener = function(t, f) { (this.on[t] = this.on[t] || []).push(f); };
El.prototype.fire = function(t) { var self = this; (this.on[t] || []).forEach(function(f) { f({ target: self }); }); };
Object.defineProperty(El.prototype, 'textContent', {
	get: function() { return this.kids.map(function(k) { return k.textContent; }).join(''); },
	set: function(v) { this.html = null; this.kids = v === '' ? [] : [ new Text(v) ]; }
});
Object.defineProperty(El.prototype, 'innerHTML', {
	get: function() { return this.html != null ? this.html : this.kids.map(function(k) { return k.outerHTML; }).join(''); },
	set: function(v) { this.html = v; this.kids = []; }
});
Object.defineProperty(El.prototype, 'outerHTML', { get: function() {
	var a = this.attrs;
	return '<' + this.tag + Object.keys(a).map(function(k) { return ' ' + k + '="' + esc(a[k], true) + '"'; }).join('') + '>' + this.innerHTML + '</' + this.tag + '>';
} });
/* a <select> reports the value of its selected <option> until one is chosen */
Object.defineProperty(El.prototype, 'value', {
	get: function() {
		if (this.chosen != null) return this.chosen;
		var sel = this.kids.filter(function(k) { return k.selected; })[0];
		return sel ? sel.attrs.value : '';
	},
	set: function(v) { this.chosen = v; }
});

/* A fresh page holding the data the router would have put into it. */
function open(csv, ctx) {
	var byId = {}, printed = 0;
	[ 'ispy-bar', 'ispy-saved', 'ispy-period', 'ispy-custom', 'ispy-from', 'ispy-to', 'ispy-appendix', 'ispy-notes',
		'ispy-print', 'ispy-hints', 'ispy-report', 'ispy-data', 'ispy-ctx' ].forEach(function(id) {
		byId[id] = new El('div');
	});
	byId['ispy-bar'].hidden = true;
	byId['ispy-data'].textContent = csv;
	byId['ispy-ctx'].textContent = JSON.stringify(ctx);
	var head = new El('head');
	global.window = global;
	global.Node = Node;
	global.document = {
		head: head,
		getElementById: function(id) { return byId[id]; },
		createElement: function(t) { return new El(t); },
		createElementNS: function(ns, t) { return new El(t); },
		createTextNode: function(t) { return new Text(t); }
	};
	global.print = function() { printed++; };
	global.ISPY_MODULES = {
		common: new Function('baseclass', 'rpc', 'dom', src.common),
		report: new Function('baseclass', 'ic', src.report)
	};
	new Function(src.standalone)();
	return {
		el: byId, head: head,
		html: function() { return byId['ispy-report'].innerHTML; },
		set: function(id, prop, v) { byId[id][prop] = v; byId[id].fire('change'); },
		printed: function() { return printed; }
	};
}

function validTests(html) {
	var m = /(\d+) valid speed tests were recorded/.exec(html);
	return m ? +m[1] : 0;
}

/* every element the script looks up exists in the page template (the
 * router adds the two data elements itself) */
var wanted = (src.standalone.match(/\$\('ispy-[a-z]+'\)/g) || []).map(function(m) { return m.slice(3, -2); })
	.filter(function(id, i, a) { return a.indexOf(id) === i && id !== 'ispy-data' && id !== 'ispy-ctx'; });
ok('the page template has every element the script uses (' + wanted.length + ')',
	wanted.length > 8 && wanted.every(function(id) { return src.page.indexOf('id="' + id + '"') > -1; }));

/* ---- a line that falls short, with markup in every text field ---- */

var now = Math.floor(new Date(2026, 10, 17, 12, 0, 0).getTime() / 1000);
var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
var ctx = {
	exported: now, version: '9.9.9', plan_down: '1000', plan_up: '40',
	sub: { isp: 'Cable & <i>Co</i>', plan: 'Gigabit', subscriber: 'A "Sub" O\'Scriber', account: '0000', address: '1 Example St' },
	meta: { model: 'Test Router', zonename: zone, streams: 4, duration: 10 }
};
var csv = gen.make(now, 30, { hostile: true });
var p = open(csv, ctx), html = p.html();
var okRows = csv.trim().split('\n').slice(1).filter(function(l) { return l.split(',')[11] === 'ok'; });

ok('the report is drawn', /1\. Summary of findings/.test(html) && /8\. How the measurements were made/.test(html), html.slice(0, 200));
ok('no error box', !/ispy-problem/.test(html) && p.el['ispy-report'].kids.length === 0);
ok('the controls are shown once the report is ready', p.el['ispy-bar'].hidden === false);
ok('the report style sheet is added', p.head.kids.length === 1 && /@page/.test(p.head.kids[0].textContent));
ok('charts are drawn', (html.match(/<svg/g) || []).length >= 4, (html.match(/<svg/g) || []).length);
ok('default period is 30 days: every valid test counted', validTests(html) === okRows.length, validTests(html) + ' vs ' + okRows.length);
ok('shortfall is stated', /Measured download speeds were substantially below the advertised speed\./.test(html));
ok('markup in the results is not passed through', !/<img|<b onmouseover/.test(html));
ok('markup in the results is shown as text', html.indexOf('&lt;img src=x onerror=window.__xss=1&gt;') > -1);
ok('markup in the settings is shown as text', html.indexOf('Cable &amp; &lt;i&gt;Co&lt;/i&gt;') > -1 && html.indexOf('A &quot;Sub&quot; O&#39;Scriber') > -1);
ok('no hints when the settings are complete', p.el['ispy-hints'].hidden === true && p.el['ispy-hints'].kids.length === 0);
ok('saved line names the export time and the number of tests', new RegExp('with ' + (csv.trim().split('\n').length - 1) + ' tests$').test(p.el['ispy-saved'].textContent), p.el['ispy-saved'].textContent);
ok('version comes from the router', html.indexOf('ISPy 9.9.9') > -1);

p.set('ispy-period', 'value', '7');
var week = okRows.filter(function(l) { return +l.split(',')[0] >= now - 7 * 86400; }).length;
ok('period "7" counts back from the export time, not from today', validTests(p.html()) === week, validTests(p.html()) + ' vs ' + week);

p.set('ispy-period', 'value', 'all');
ok('"All data" covers every valid test', validTests(p.html()) === okRows.length);

ok('custom dates stay hidden until chosen', p.el['ispy-custom'].hidden === true);
p.set('ispy-period', 'value', 'custom');
ok('custom dates appear when chosen', p.el['ispy-custom'].hidden === false);
var d = new Date((now - 3 * 86400) * 1000), day = '%04d-%02d-%02d'.format(d.getFullYear(), d.getMonth() + 1, d.getDate());
p.el['ispy-from'].value = day;
p.set('ispy-to', 'value', day);
var start = new Date(day + 'T00:00:00').getTime() / 1000;
var oneDay = okRows.filter(function(l) { var t = +l.split(',')[0]; return t >= start && t <= start + 86399; }).length;
ok('custom dates select one calendar day', validTests(p.html()) === oneDay && oneDay > 0, validTests(p.html()) + ' vs ' + oneDay);

p.set('ispy-period', 'value', '30');
ok('no appendix unless asked for', !/Appendix: every test in the period/.test(p.html()));
p.set('ispy-appendix', 'checked', true);
ok('appendix on request', /Appendix: every test in the period/.test(p.html()) && !/<img|<b onmouseover/.test(p.html()));
p.set('ispy-notes', 'value', '  Reported on 1 Nov, ticket <123> & no fix.  ');
ok('statement is printed, as text', p.html().indexOf('<div class="statement">Reported on 1 Nov, ticket &lt;123&gt; &amp; no fix.</div>') > -1);
p.el['ispy-print'].fire('click');
ok('print button prints', p.printed() === 1);

/* ---- LuCI's format(), as far as the modules use it ---- */

ok('%d truncates like LuCI', '%d'.format(2.9) === '2' && '%d'.format('x') === '0');
ok('%02d and %04d pad with zeros', '%04d-%02d'.format(2026, 7) === '2026-07');
ok('%.2f rounds to two places', '%.2f'.format(3.14159) === '3.14');
ok('%s and %% ', '%s of %d%%'.format('half', 50) === 'half of 50%');
ok('%f without precision prints the number', 'M%f,%f'.format(1.5, 2) === 'M1.5,2');

/* ---- a line that delivers; settings missing; other time zone ---- */

var p2 = open(gen.make(now, 30, { good: true }), {
	exported: now, version: '9.9.9', plan_down: '1000', plan_up: '40', sub: {},
	meta: { zonename: zone === 'Asia/Tokyo' ? 'Europe/Berlin' : 'Asia/Tokyo' }
});
ok('a line that delivers is reported as such', /Measured download speeds were consistent with the advertised speed\./.test(p2.html()));
var hints = p2.el['ispy-hints'].textContent;
ok('hint: details missing', p2.el['ispy-hints'].hidden === false && /Provider and subscriber details are empty/.test(hints));
ok('hint: time zone differs from the router', /differs from the router/.test(hints), hints);

/* the router spells zone names with spaces, and may use an alias */
function zoneHint(name) {
	var q = open(gen.HEADER + '\n', { exported: now, version: '9.9.9', plan_down: '1000', plan_up: '40',
		sub: { isp: 'x', subscriber: 'y' }, meta: { zonename: name } });
	return /differs from the router/.test(q.el['ispy-hints'].textContent);
}
ok('this test runs in a known time zone', zone === 'America/Los_Angeles', zone);
ok('no time zone hint for the router\'s spelling with a space', zoneHint('America/Los Angeles') === false);
ok('no time zone hint for an alias of the same zone', zoneHint('US/Pacific') === false);
ok('time zone hint for a zone with another clock', zoneHint('America/Denver') === true);
ok('time zone hint for a zone that matches only in summer', zoneHint('America/Phoenix') === true);
ok('time zone hint for a zone that matches only in winter', zoneHint('Pacific/Pitcairn') === true);
ok('no time zone hint for another name with the same clock all year', zoneHint('America/Vancouver') === false);
ok('no time zone hint for a name the browser does not know', zoneHint('Nowhere/Special') === false);

var p3 = open(gen.HEADER + '\n', { exported: now, version: '9.9.9', plan_down: '', plan_up: '', sub: {}, meta: {} });
ok('no results: says so instead of failing', /No completed speed tests were recorded in this period\./.test(p3.html()));
ok('hint: advertised speeds missing', /advertised speeds are not set/.test(p3.el['ispy-hints'].textContent));

var p4 = open('', {});
p4.el['ispy-ctx'].textContent = '{';
new Function(src.standalone)();
ok('damaged file: explains and points to the CSV', /cannot be displayed/.test(p4.el['ispy-report'].textContent) && /ispy-results\.csv/.test(p4.el['ispy-report'].textContent));

/* ---- the router pastes these files into <script> elements ---- */

[ 'common', 'report', 'standalone' ].forEach(function(k) {
	ok(k + '.js can be embedded in a <script> element', !/<\/script|<!--/i.test(src[k]));
});

/* ---- LuCI's format() reads more than %s and %d ---- */

/* In LuCI a "%" followed by a space or by one of b c o q t m u x X j is a
 * conversion too, so "below 80% of" swallows an argument and prints
 * garbage. Every "%" in a formatted string must be %s, %d, %f, %h (with
 * zero padding or a precision) or a doubled "%%". */
var views = path.join(PKG, 'htdocs/luci-static/resources/view/ispy');
var sources = [ FILES.common, FILES.report, FILES.standalone ].concat(
	fs.readdirSync(views).map(function(f) { return path.join(views, f); }));
var stray = [];
sources.forEach(function(f) {
	var text = fs.readFileSync(f, 'utf8'), re = /'((?:[^'\\\n]|\\.)*)'\)?\s*\.format\(/g, m;
	while ((m = re.exec(text)))
		if (/%(?!(?:0\d+|\.\d+)?[sdfh])/.test(m[1].replace(/%%/g, '')))
			stray.push(path.basename(f) + ':' + text.slice(0, m.index).split('\n').length);
});
ok('no formatted string has a "%" that LuCI would misread', stray.length === 0, stray.join(', '));
ok('formatted strings were found to check (' + sources.length + ' files)', sources.length === 6);

console.log(fail ? fail + ' FAILED' : 'all passed');
process.exit(fail ? 1 : 0);
