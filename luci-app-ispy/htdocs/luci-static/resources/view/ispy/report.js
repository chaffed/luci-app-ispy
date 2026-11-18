'use strict';
'require view';
'require rpc';
'require ui';
'require uci';
'require dom';
'require ispy.common as ic';
'require ispy.report as rb';

/*
 * ISPy - "I spy on my ISP"
 * Report: a self-contained, printable document comparing measured speeds
 * with the advertised ones, written for a provider's support team or a
 * regulator. The document itself is built by ispy/report.js and shown here
 * as a standalone HTML page (in an iframe, printable to PDF, downloadable)
 * so it looks the same everywhere.
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.ispy', method: 'status' });
var callMeta = rpc.declare({ object: 'luci.ispy', method: 'meta' });
var callExport = rpc.declare({ object: 'luci.ispy', method: 'export' });

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
		return rb.periodWindow(this.period, this.routerNow(), this.fromInput.value, this.toInput.value);
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
		} }, rb.PERIODS.map(function(p) { return E('option', { 'value': p[0], 'selected': p[0] === self.period ? '' : null }, [ p[1] ]); }));
		this.fromInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('From date') });
		this.toInput = E('input', { 'type': 'date', 'class': 'cbi-input-text', 'change': changed, 'aria-label': _('To date') });
		this.customBox = E('span', { 'style': 'display:none' }, [ ' ', this.fromInput, ' – ', this.toInput ]);
		this.appendixBox = E('input', { 'type': 'checkbox', 'id': 'ispy-appendix', 'change': changed });
		this.notes = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 3, 'style': 'width:100%',
			'placeholder': _('Optional: anything you want the reader to know, in your own words – for example when you first reported the problem and any ticket numbers. It is printed as “Subscriber’s statement”.'),
			'change': changed });
		this.msg = E('div');
		this.driveBox = E('div', { 'role': 'status', 'style': 'margin:.5em 0' });
		this.frame = E('iframe', { 'title': _('Report preview'),
			'style': 'width:100%;min-height:640px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:#fff' });
		this.frame.addEventListener('load', function() {
			try { self.frame.style.height = (self.frame.contentDocument.documentElement.scrollHeight + 24) + 'px'; } catch (e) {}
		});

		var hints = rb.hints({ planDown: this.planDown, sub: this.sub, meta: this.meta });

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
			this.driveBox,
			this.msg,
			this.frame
		]);

		this.showDrive(st['export']);
		this.refresh();
		return root;
	},

	/* The automatic copy on an attached drive: where it goes and whether the
	 * last attempt worked. ex = { dir, mounted, ts, ok, message } */
	showDrive: function(ex) {
		var self = this;
		if (!ex || !ex.dir) {
			dom.content(this.driveBox, E('small', {}, [
				_('ISPy can also save the data and this report to a USB drive after every test.') + ' ',
				E('a', { 'href': L.url('admin/services/ispy/settings') }, [ _('Settings → Storage') ])
			]));
			return;
		}
		var bad = !ex.mounted
			? _('No drive is connected at %s, so the automatic copy is not being saved. The history on the router is not affected.').format(ex.dir)
			: (ex.ok === false ? _('The automatic copy to %s failed: %s. The history on the router is not affected.').format(ex.dir, ex.message || _('unknown error')) : null);
		this.saveBtn = E('button', { 'class': 'cbi-button', 'click': function() { self.handleSaveToDrive(); } }, [ _('Save to the drive now') ]);
		if (bad) {
			dom.content(this.driveBox, E('div', { 'class': 'alert-message warning' }, [ E('p', {}, [ bad ]), this.saveBtn ]));
			return;
		}
		dom.content(this.driveBox, E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.5em 1em;align-items:center' }, [
			E('span', {}, [ (ex.ts
				? _('After every test the data and a copy of this report are saved to %s. Last saved: %s.').format(ex.dir, ic.fmtTime(ex.ts))
				: _('After every test the data and a copy of this report are saved to %s. Nothing has been saved yet since the router started.').format(ex.dir)) ]),
			this.saveBtn
		]));
	},

	handleSaveToDrive: function() {
		var self = this;
		this.saveBtn.disabled = true;
		this.saveBtn.classList.add('spinning');
		return callExport().then(function(ex) {
			self.showDrive(ex);
		}).catch(function(e) {
			self.saveBtn.disabled = false;
			self.saveBtn.classList.remove('spinning');
			ui.addNotification(null, E('p', {}, [ _('Could not save to the drive: %s').format(e && e.message || e) ]), 'error');
		});
	},

	refresh: function() {
		var self = this, w = this.window(), my = ++this.seq;
		dom.content(this.msg, E('em', { 'class': 'spinning' }, [ _('Loading results…') ]));
		return ic.loadResults(w.from).then(function(csv) {
			if (my !== self.seq)
				return; /* a newer request has been made since */
			self.csv = csv;
			self.win = w;
			self.html = rb.build(ic.parseCSV(csv), {
				planDown: self.planDown, planUp: self.planUp, from: w.from, to: w.to,
				sub: self.sub, meta: self.meta, version: self.version, generated: self.routerNow(),
				notes: self.notes.value, appendix: self.appendixBox.checked
			}).page();
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
