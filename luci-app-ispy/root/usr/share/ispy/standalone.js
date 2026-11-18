/*
 * ISPy - "I spy on my ISP"
 * Script for the self-contained report file that `ispy export` saves to an
 * attached drive. That file carries the results, the settings and the same
 * two modules the Report view in LuCI uses (ISPY_MODULES, added by the
 * router); this script stands in for the few LuCI facilities those modules
 * expect and draws the report, so the file works in any browser without
 * the router.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	function $(id) { return document.getElementById(id); }

	function problem(text) {
		var p = document.createElement('p');
		p.id = 'ispy-problem';
		p.textContent = text + ' The measurements themselves are in the file ispy-results.csv next to this one.';
		$('ispy-report').textContent = '';
		$('ispy-report').appendChild(p);
	}

	/* ---- what the shared modules expect from LuCI ---- */

	window._ = function(s) { return s; };

	/* Same results as LuCI's String.prototype.format for the conversions used. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufs])/g, function(m, pad, left, width, prec, type) {
			if (type === '%')
				return '%';
			if (i >= args.length)
				return m;
			var v = args[i++];
			if (type === 'd' || type === 'u')
				v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f')
				v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else
				v = String(v);
			while (width && v.length < +width)
				v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	/* Element builder. Unlike LuCI's, children are only ever nodes or text. */
	function add(el, c) {
		if (c == null)
			return;
		if (Array.isArray(c))
			c.forEach(function(x) { add(el, x); });
		else
			el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	window.E = function(tag, attrs, children) {
		var el = document.createElement(tag);
		for (var k in attrs || {})
			if (typeof attrs[k] === 'function')
				el.addEventListener(k, attrs[k]);
			else if (attrs[k] != null)
				el.setAttribute(k, attrs[k]);
		add(el, children);
		return el;
	};

	var baseclass = { extend: function(o) { return o; } };
	var rpc = { declare: function() { return function() { return Promise.reject(new Error('not connected to the router')); }; } };
	var dom = { content: function(el, c) { el.textContent = ''; add(el, c); } };

	/* ---- the report ---- */

	var ic, rb, ctx, rows;
	try {
		ic = window.ISPY_MODULES.common(baseclass, rpc, dom);
		rb = window.ISPY_MODULES.report(baseclass, ic);
		ctx = JSON.parse($('ispy-ctx').textContent);
		rows = ic.parseCSV($('ispy-data').textContent);
	} catch (e) {
		problem('This report file is incomplete and cannot be displayed (' + (e && e.message || e) + ').');
		return;
	}

	var style = document.createElement('style');
	style.textContent = rb.css;
	document.head.insertBefore(style, document.head.querySelector('style'));

	var now = +ctx.exported || Math.floor(Date.now() / 1000);
	var planDown = ic.num(ctx.plan_down), planUp = ic.num(ctx.plan_up);
	var period = $('ispy-period'), from = $('ispy-from'), to = $('ispy-to');
	var appendix = $('ispy-appendix'), notes = $('ispy-notes');

	rb.PERIODS.forEach(function(p) {
		var o = E('option', { value: p[0] }, [ p[1] ]);
		o.selected = p[0] === '30';
		period.appendChild(o);
	});

	function draw() {
		$('ispy-custom').hidden = period.value !== 'custom';
		var w = rb.periodWindow(period.value, now, from.value, to.value);
		try {
			$('ispy-report').innerHTML = rb.build(rows, {
				planDown: planDown, planUp: planUp, from: w.from, to: w.to,
				sub: ctx.sub, meta: ctx.meta, version: ctx.version, generated: now,
				notes: notes.value, appendix: appendix.checked
			}).body;
		} catch (e) {
			problem('This report could not be drawn (' + (e && e.message || e) + ').');
		}
	}

	[ period, from, to, appendix, notes ].forEach(function(el) { el.addEventListener('change', draw); });
	$('ispy-print').addEventListener('click', function() { window.print(); });

	$('ispy-saved').textContent = 'saved by the router on %s, with %d tests'.format(
		new Date(now * 1000).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }), rows.length);

	var hints = rb.hints({ planDown: planDown, sub: ctx.sub, meta: ctx.meta });
	hints.forEach(function(h) { $('ispy-hints').appendChild(E('li', {}, [ h ])); });
	$('ispy-hints').hidden = !hints.length;

	$('ispy-bar').hidden = false;
	draw();
})();
