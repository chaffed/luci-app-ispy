/*
 * ISPy - "I spy on my ISP"
 * ISPy inside the GL.iNet admin panel.
 *
 * The panel's menu entry (/usr/share/oui/menu.d/ispy.json) loads
 * /views/gl-sdk4-ui-ispy.common.js, which shows this script in a frame of
 * its own, so nothing here can change how the panel itself looks or works.
 * The script runs the same Overview and Report views as LuCI, with a small
 * stand-in for the parts of LuCI they use, and reaches the router through
 * the panel's own login: window.$request -> RPC object "ispy"
 * (/usr/lib/oui-httpd/rpc/ispy). Settings has a form of its own here.
 *
 * As in LuCI, E() assigns a bare string child with innerHTML. Text from the
 * results file or the settings is always passed as an array child.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	var BASE = '/luci-static/resources/';
	var STAMP = Date.now();

	var host = null, frame = null;
	try {
		if (window.parent !== window && typeof window.parent.$request === 'function')
			host = window.parent;
		frame = window.frameElement;
	} catch (e) {}

	/* ---------------------------------------------------- LuCI stand-ins -- */

	window._ = function(s) { return s; };

	function escHTML(s) {
		return String(s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/* LuCI's String.prototype.format, for the conversions ISPy uses. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufsh])/g, function(m, pad, left, width, prec, type) {
			if (type === '%')
				return '%';
			if (i >= args.length)
				return m;
			var v = args[i++];
			if (type === 'd' || type === 'u')
				v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f')
				v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else if (type === 'h')
				v = escHTML(v == null ? '' : v);
			else
				v = String(v);
			while (width && v.length < +width)
				v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	function append(node, c) {
		if (c == null)
			return;
		if (Array.isArray(c)) {
			c.forEach(function(x) {
				if (x instanceof Node)
					node.appendChild(x);
				else if (x != null)
					node.appendChild(document.createTextNode(String(x)));
			});
		}
		else if (typeof c === 'function')
			append(node, c(node));
		else if (c instanceof Node)
			node.appendChild(c);
		else
			node.innerHTML = String(c);   /* LuCI semantics: see the note at the top */
	}

	window.E = function(tag, attrs, data) {
		var el = document.createElement(tag);
		if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs instanceof Node)) {
			data = attrs;
			attrs = null;
		}
		for (var k in attrs || {}) {
			var v = attrs[k];
			if (v == null)
				continue;
			if (typeof v === 'function')
				el.addEventListener(k, v);
			else if (typeof v === 'object')
				el.setAttribute(k, JSON.stringify(v));
			else
				el.setAttribute(k, v);
		}
		append(el, data);
		return el;
	};

	var dom = {
		content: function(node, c) {
			while (node.firstChild)
				node.removeChild(node.firstChild);
			append(node, c);
			return node;
		},
		append: function(node, c) {
			append(node, c);
			return node;
		}
	};

	var ROUTES = {
		'admin/services/ispy': 'overview',
		'admin/services/ispy/overview': 'overview',
		'admin/services/ispy/report': 'report',
		'admin/services/ispy/settings': 'settings'
	};

	window.L = {
		env: {},
		bind: function(fn, self) {
			var bound = Array.prototype.slice.call(arguments, 2);
			return function() { return fn.apply(self, bound.concat(Array.prototype.slice.call(arguments))); };
		},
		/* Links between ISPy's pages become "#page"; clicks on them are
		 * handled below, since the frame has no address of its own. */
		url: function() {
			return '#' + (ROUTES[Array.prototype.join.call(arguments, '/')] || 'overview');
		},
		resolveDefault: function(p, d) {
			return Promise.resolve(p).catch(function() { return d; });
		}
	};

	/* One call to the router, through the panel's login. */
	function call(method, params, seconds) {
		if (!host)
			return Promise.reject(new Error(_('This page only works inside the GL.iNet admin panel.')));
		return Promise.resolve(host.$request('call', [ 'sid', 'ispy', method, params || {} ],
			{ timeout: (seconds || 60) * 1000, isCancel: false, ignoreCoreErrTips: true })).catch(function(e) {
			var err = new Error(e && (e.message || e.type) || String(e));
			err.field = e && e.field;
			throw err;
		});
	}

	var rpc = {
		declare: function(o) {
			var names = o.params || [], expect = o.expect;
			return function() {
				var args = arguments, p = {};
				names.forEach(function(n, i) {
					if (args[i] !== undefined)
						p[n] = args[i];
				});
				return call(o.method, p, o.method === 'export' ? 180 : 60).then(function(res) {
					if (!expect)
						return res;
					var k = Object.keys(expect)[0];
					if (!k)
						return res != null ? res : expect[k];
					return res != null && res[k] != null ? res[k] : expect[k];
				});
			};
		}
	};

	var config = {}, networks = [];
	var uci = {
		load: function() {
			return call('get_config').then(function(r) {
				config = (r && r.config) || {};
				networks = (r && r.networks) || [];
			});
		},
		get: function(conf, section, option) {
			return config[option] != null ? config[option] : null;
		}
	};

	var polls = [];
	var poll = {
		add: function(fn, seconds) {
			var busy = false;
			polls.push(setInterval(function() {
				if (busy)
					return;
				busy = true;
				Promise.resolve().then(fn).catch(function() {}).then(function() { busy = false; });
			}, (seconds || 5) * 1000));
		}
	};

	function stopPolls() {
		polls.forEach(clearInterval);
		polls = [];
	}

	var modal = null, modalReturn = null, notices = null;

	/* Distance from the top of this frame to the top of the visible part of
	 * the panel, so a dialog opens where the user is looking. */
	function visibleTop() {
		try {
			return Math.max(0, -frame.getBoundingClientRect().top);
		} catch (e) {
			return 0;
		}
	}

	var ui = {
		showModal: function(title, children) {
			ui.hideModal();
			modalReturn = document.activeElement;
			var box = E('div', { 'class': 'ispy-modal', 'role': 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ispy-modal-title' }, [
				E('h4', { 'id': 'ispy-modal-title' }, [ title ]),
				E('div', {}, children)
			]);
			modal = E('div', { 'class': 'ispy-backdrop', 'keydown': function(ev) {
				if (ev.key === 'Escape')
					ui.hideModal();
			} }, [ box ]);
			document.body.appendChild(modal);
			box.style.top = (visibleTop() + 72) + 'px';
			resize();
			var first = box.querySelector('button');
			if (first)
				first.focus();
			return box;
		},
		hideModal: function() {
			if (modal && modal.parentNode)
				modal.parentNode.removeChild(modal);
			modal = null;
			if (modalReturn && modalReturn.focus && document.contains(modalReturn))
				modalReturn.focus();
			modalReturn = null;
			resize();
		},
		addNotification: function(title, children, type) {
			var n = E('div', { 'class': 'alert-message ' + (type || ''), 'role': 'alert' }, [
				title ? E('strong', {}, [ title ]) : '',
				E('div', {}, children),
				E('button', { 'class': 'cbi-button', 'click': function() { n.parentNode.removeChild(n); resize(); } }, [ _('Dismiss') ])
			]);
			notices.appendChild(n);
			resize();
			return n;
		}
	};

	var BUILTIN = {
		view: { extend: function(o) { return o; } },
		baseclass: { extend: function(o) { return o; } },
		rpc: rpc, ui: ui, uci: uci, poll: poll, dom: dom
	};

	/* LuCI-style modules ('require x.y as z' lines at the top, a "return"
	 * at the end), loaded from the same files LuCI serves. */
	var modules = {};

	function requireModule(name) {
		if (BUILTIN[name])
			return Promise.resolve(BUILTIN[name]);
		if (!/^(view\.)?ispy\.[a-z]+$/.test(name))
			return Promise.reject(new Error(_('%s is not available in the GL.iNet panel').format(name)));
		if (!modules[name]) {
			var path = BASE + name.replace(/\./g, '/') + '.js';
			modules[name] = fetch(path + '?_t=' + STAMP, { credentials: 'same-origin', cache: 'no-store' }).then(function(r) {
				if (!r.ok)
					throw new Error(_('could not load %s (HTTP %d)').format(path, r.status));
				return r.text();
			}).then(function(src) {
				return instantiate(src, path);
			});
			modules[name].catch(function() { delete modules[name]; });
		}
		return modules[name];
	}

	function instantiate(src, path) {
		var lines = src.split('\n'), reqs = [], m;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (line === '' || line === "'use strict';")
				continue;
			m = /^'require\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?'\s*;$/.exec(line);
			if (!m)
				break;
			reqs.push({ name: m[1], as: m[2] || m[1].split('.').pop() });
		}
		return Promise.all(reqs.map(function(r) { return requireModule(r.name); })).then(function(deps) {
			var fn = new Function(reqs.map(function(r) { return r.as; }).join(','), src + '\n//# sourceURL=' + path);
			return fn.apply(window, deps);
		});
	}

	/* ---------------------------------------------------------- theme -- */

	/* The panel's colours are CSS variables on its root element; copying
	 * them makes this page follow its light or dark theme. */
	var THEME = [ '--primary', '--primary-hover', '--primary-background', '--error', '--error-background',
		'--warning', '--warning-background', '--success', '--text-title', '--text-subtitle', '--text-strong',
		'--text-regular', '--text-weak', '--text-hint', '--text-disabled', '--background-card', '--background-title',
		'--background-content', '--background-disabled', '--border', '--divider', '--shadow', '--mask' ];

	function luminance(color) {
		var c = document.createElement('canvas').getContext('2d');
		c.fillStyle = '#fff';
		c.fillStyle = color;
		var hex = c.fillStyle, r, g, b;
		if (/^#[0-9a-f]{6}$/i.test(hex)) {
			r = parseInt(hex.substr(1, 2), 16); g = parseInt(hex.substr(3, 2), 16); b = parseInt(hex.substr(5, 2), 16);
		} else {
			var m = /(\d+),\s*(\d+),\s*(\d+)/.exec(hex) || [ 0, 255, 255, 255 ];
			r = +m[1]; g = +m[2]; b = +m[3];
		}
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	}

	function syncTheme() {
		if (!host)
			return;
		try {
			var cs = host.getComputedStyle(host.document.documentElement), root = document.documentElement.style;
			THEME.forEach(function(v) {
				var x = cs.getPropertyValue(v).trim();
				if (x)
					root.setProperty(v, x);
				else
					root.removeProperty(v);
			});
			var font = host.getComputedStyle(host.document.body).fontFamily;
			if (font)
				root.setProperty('--font', font);
			var card = cs.getPropertyValue('--background-card').trim();
			document.documentElement.setAttribute('data-theme', card && luminance(card) < 0.4 ? 'dark' : 'light');
		} catch (e) {}
	}

	function watchTheme() {
		if (!host || !window.MutationObserver)
			return;
		try {
			var mo = new MutationObserver(function() {
				syncTheme();
				setTimeout(syncTheme, 400);
				setTimeout(syncTheme, 1500);
			});
			mo.observe(host.document.head, { childList: true });
			window.addEventListener('pagehide', function() { mo.disconnect(); });
		} catch (e) {}
	}

	var CSS = [
		':root{--primary:#5272f7;--primary-hover:#425bc6;--primary-background:#eef1fe;--error:#e04c7e;--error-background:#fcedf2;',
		'--warning:#f5a623;--warning-background:#fef6e9;--success:#00c8b5;--text-title:#1f1f3d;--text-subtitle:#555557;--text-strong:#000;',
		'--text-regular:#141427;--text-weak:#333366;--text-hint:#b9b9bd;--text-disabled:#a0a0a3;--background-card:#fff;--background-title:#f2f2f7;',
		'--background-content:#ebebf0;--background-disabled:#ebebf0;--border:#d2d2d6;--divider:#ebebf0;--shadow:#d2d2d6;',
		'--mask:rgba(16,18,35,.24);--font:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color-scheme:light}',
		/* The panel's own control colour is white in its dark theme too
		 * (its controls are styled separately), so buttons and fields here
		 * use a colour of their own. */
		':root{--ispy-control:#fff}',
		':root[data-theme=dark]{color-scheme:dark;--ispy-control:rgba(255,255,255,.06)}',
		'html,body{margin:0;padding:0;background:transparent}',
		'body{font:14px/1.5 var(--font);color:var(--text-regular);overflow:hidden}',
		'#ispy-app{background:var(--background-card);border-radius:8px;padding:8px 24px 24px;box-sizing:border-box}',
		'.ispy-nav{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border);margin:0 0 16px}',
		'.ispy-nav button{font:inherit;font-weight:600;color:var(--text-weak);background:none;border:0;border-bottom:2px solid transparent;margin:0 0 -1px;padding:10px 14px;min-height:44px;cursor:pointer}',
		'.ispy-nav button:hover{color:var(--primary)}',
		'.ispy-nav button[aria-current=page]{color:var(--primary);border-bottom-color:var(--primary)}',
		'h2{font-size:20px;line-height:1.3;color:var(--text-title);margin:4px 0 4px}',
		'h3{font-size:16px;color:var(--text-title);margin:22px 0 8px}',
		'h4{font-size:16px;margin:0 0 10px;color:var(--text-title)}',
		'a{color:var(--primary)}',
		'.cbi-map-descr{color:var(--text-subtitle);margin:0 0 14px;max-width:72em}',
		'.cbi-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:36px;padding:6px 16px;',
		'border:1px solid var(--border);border-radius:6px;background:var(--ispy-control);color:var(--text-regular);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}',
		'.cbi-button:hover{border-color:var(--primary);color:var(--primary)}',
		'.cbi-button:disabled,.cbi-button[disabled]{opacity:.55;cursor:default}',
		'.cbi-button-action,.cbi-button-action:hover{background:var(--primary);border-color:var(--primary);color:#fff}',
		'.cbi-button-action:hover{background:var(--primary-hover);border-color:var(--primary-hover)}',
		'.cbi-button-negative{color:var(--error)}',
		'.cbi-button-negative:hover{border-color:var(--error);color:var(--error)}',
		':focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
		'input,select,textarea{font:inherit;color:var(--text-regular);background:var(--ispy-control);border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-height:36px;box-sizing:border-box;max-width:100%}',
		'input:focus,select:focus,textarea:focus{border-color:var(--primary);outline:none}',
		'input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--primary);outline-offset:1px}',
		'input[type=checkbox]{width:18px;height:18px;min-height:0;vertical-align:-3px;accent-color:var(--primary)}',
		'textarea{min-height:72px}',
		'.alert-message{border:1px solid var(--warning);background:var(--warning-background);border-radius:6px;padding:10px 14px;margin:10px 0}',
		'.alert-message.error,.alert-message.danger{border-color:var(--error);background:var(--error-background)}',
		'.alert-message ul{margin:0 0 .5em 1.2em;padding:0}',
		'.alert-message .cbi-button{margin-top:6px}',
		'table.table{border-collapse:collapse;width:100%;font-size:13px}',
		'.table th,.table td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--divider);white-space:nowrap}',
		'.table .table-titles th{background:var(--background-title);color:var(--text-subtitle);font-weight:600}',
		'.right{text-align:right}',
		'.spinning::before{content:"";display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ispy-spin .8s linear infinite}',
		'@keyframes ispy-spin{to{transform:rotate(360deg)}}',
		'@media (prefers-reduced-motion:reduce){.spinning::before{animation:none}}',
		'.ispy-backdrop{position:absolute;left:0;right:0;top:0;bottom:0;min-height:100%;background:var(--mask);z-index:50}',
		'.ispy-modal{position:absolute;left:50%;transform:translateX(-50%);width:min(480px,calc(100% - 32px));box-sizing:border-box;background:var(--background-card);border-radius:10px;padding:18px 20px;box-shadow:0 12px 32px rgba(0,0,0,.25)}',
		'.ispy-modal .right{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
		/* settings */
		'.ispy-section{margin:0 0 8px}',
		'.ispy-section h3{margin:20px 0 4px}',
		'.ispy-row{display:grid;grid-template-columns:minmax(150px,260px) minmax(0,1fr);gap:4px 20px;padding:12px 0;border-bottom:1px solid var(--divider)}',
		'.ispy-row[hidden]{display:none}',
		'.ispy-row>label{font-weight:500;color:var(--text-title);padding-top:7px}',
		'.ispy-row input[type=text]{width:28em}',
		'.ispy-row select{min-width:16em}',
		'.ispy-help{color:var(--text-subtitle);font-size:13px;margin:4px 0 0;max-width:60em}',
		'.ispy-invalid{border-color:var(--error)!important}',
		'.ispy-field-error{color:var(--error);font-size:13px;margin:4px 0 0;font-weight:500}',
		'.ispy-actions-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:18px 0 0}',
		'.ispy-saved{color:var(--text-subtitle)}',
		'@media (max-width:640px){#ispy-app{padding:8px 14px 18px}.ispy-row{grid-template-columns:1fr}.ispy-row>label{padding-top:0}.ispy-row input[type=text],.ispy-row select{width:100%;min-width:0}}'
	].join('\n');

	/* ------------------------------------------------------- settings -- */

	var DEFAULTS = {
		enabled: '0', interval: '60', busy_threshold: '0', backend: 'auto', streams: '4', duration: '10',
		ping_host: '1.1.1.1', ping_count: '10', results_file: '/etc/ispy/results.csv', max_results: '4000'
	};

	var INTERVALS = [ [ '15', _('Every 15 minutes') ], [ '30', _('Every 30 minutes') ], [ '60', _('Every hour') ],
		[ '120', _('Every 2 hours') ], [ '240', _('Every 4 hours') ], [ '360', _('Every 6 hours') ],
		[ '720', _('Every 12 hours') ], [ '1440', _('Once a day') ] ];

	/* The router counts bytes, so letters such as "é" count twice. */
	function textOk(v) {
		var bytes = window.TextEncoder ? new TextEncoder().encode(v).length : v.length;
		return bytes <= 120 && !/[\x00-\x1f\x7f]/.test(v) ? null : _('Up to 120 characters on one line.');
	}

	function pathOk(v) {
		return /^\/[A-Za-z0-9._\/-]*$/.test(v) && v.indexOf('..') < 0 && v.length <= 200 ? null
			: _('Enter a full path starting with “/”, using only letters, digits, “.”, “_”, “-” and “/”.');
	}

	function sections(st, meta) {
		var avail = (st && st.backends) || [], drives = (meta && meta.drives) || [];
		var has = function(b) { return avail.indexOf(b) > -1 ? '' : ' – ' + _('not installed'); };
		return [
			[ _('Schedule'), [
				{ key: 'enabled', type: 'flag', label: _('Enable scheduled tests'),
					help: _('Each test uses data: the Overview page shows how much per month at the current interval.') },
				{ key: 'interval', type: 'interval', label: _('Test interval'), min: 5, max: 10080,
					help: _('How often a test runs, day and night. Very short intervals can trigger rate limits on public test servers.') },
				{ key: 'busy_threshold', type: 'decimal', label: _('Skip when the line is busy (Mbit/s)'),
					help: _('Before a scheduled test, measure current WAN traffic for 3 seconds. If it is above this value, look again 5 minutes later; after three busy checks the test is recorded as skipped. 0 = disabled.') }
			] ],
			[ _('Test engine'), [
				{ key: 'backend', type: 'select', label: _('Speed test backend'),
					options: [ [ 'auto', _('Auto') ], [ 'cloudflare', _('Cloudflare (built-in, uses curl)') ],
						[ 'ookla', _('Ookla speedtest CLI') + has('ookla') ], [ 'librespeed', _('librespeed-cli') + has('librespeed') ] ],
					help: _('“Auto” prefers the Ookla CLI, then librespeed-cli, then the built-in Cloudflare test. Installed on this router: %s.')
						.format(avail.length ? avail.join(', ') : _('none detected')) },
				{ key: 'interface', type: 'network', optional: true, label: _('Test via interface'),
					help: _('Bind the test to a specific WAN (multi-WAN setups). Leave on the default route otherwise.') },
				{ key: 'streams', type: 'int', min: 1, max: 16, label: _('Parallel streams'), backends: [ 'cloudflare', 'auto' ],
					help: _('Cloudflare backend: number of simultaneous connections. Use 4–8 for gigabit and faster links.') },
				{ key: 'duration', type: 'int', min: 5, max: 60, label: _('Seconds per direction'), backends: [ 'cloudflare', 'auto' ],
					help: _('Cloudflare backend: how long download and upload are each measured (5–60).') },
				{ key: 'ping_host', type: 'text', label: _('Latency target'),
					check: function(v) { return /^[A-Za-z0-9.:_-]+$/.test(v) && v.charAt(0) !== '-' && v.length <= 253 ? null : _('Enter a host name or IP address.'); },
					help: _('Host pinged for idle and loaded latency (Cloudflare backend).') },
				{ key: 'ping_count', type: 'int', min: 1, max: 50, label: _('Idle pings') },
				{ key: 'ookla_server', type: 'int', min: 0, max: 9999999999, optional: true, label: _('Ookla server ID'), backends: [ 'ookla', 'auto' ],
					help: _('Optional. List nearby servers with “speedtest -L” over SSH.') },
				{ key: 'librespeed_server', type: 'int', min: 0, max: 9999999999, optional: true, label: _('LibreSpeed server ID'), backends: [ 'librespeed', 'auto' ],
					help: _('Optional. List servers with “librespeed-cli --list” over SSH.') }
			] ],
			[ _('My plan'), [
				{ key: 'plan_down', type: 'decimal', optional: true, label: _('Advertised download (Mbit/s)'),
					help: _('The speed your provider advertises for your plan. In the US, the plan’s Broadband Facts label states a “typical download speed”; that is the figure to use. Drawn as a reference line and used throughout the report.') },
				{ key: 'plan_up', type: 'decimal', optional: true, label: _('Advertised upload (Mbit/s)') },
				{ key: 'isp_name', type: 'text', optional: true, label: _('Provider'), check: textOk,
					help: _('This and the following details are only used on the printable report.') },
				{ key: 'plan_name', type: 'text', optional: true, label: _('Plan name'), check: textOk },
				{ key: 'subscriber', type: 'text', optional: true, label: _('Subscriber name'), check: textOk },
				{ key: 'account', type: 'text', optional: true, label: _('Account number'), check: textOk },
				{ key: 'service_address', type: 'text', optional: true, label: _('Service address'), check: textOk }
			] ],
			[ _('Storage'), [
				{ key: 'results_file', type: 'text', label: _('Results file'),
					check: function(v) { return pathOk(v) || (/\.csv$/.test(v) ? null : _('The name must end in .csv.')); },
					help: _('CSV file with one line per test. Keep it on the router (under /etc) so history survives reboots; /tmp is lost on reboot. For a copy on a USB drive use the option below.') },
				{ key: 'export_dir', type: 'text', optional: true, label: _('Copy to a USB drive (folder)'),
					suggestions: drives.map(function(d) { return d + '/ispy'; }),
					check: function(v) { return v === '/' ? _('Choose a folder on the drive.') : pathOk(v); },
					help: _('After every test, ISPy saves ispy-results.csv (all results) and ispy-report.html (the report, which opens in any browser and prints to PDF) to this folder. The router keeps the master copy; while the drive is unplugged the copy is skipped. The report file includes the details under “My plan”. Leave empty to switch this off.') + ' ' +
						(drives.length ? _('Drives found on this router: %s.').format(drives.join(', '))
							: _('No attached drive is found at the moment; plug one in and open this page again.')) },
				{ key: 'max_results', type: 'int', min: 100, max: 50000, label: _('Keep at most (tests)'),
					help: _('Older results are removed beyond this count. 4000 ≈ 5.5 months at an hourly interval (~0.6 MB).') }
			] ]
		];
	}

	function fieldError(f, v) {
		if (v === '')
			return f.optional ? null : _('Required.');
		if (f.type === 'int' || f.type === 'interval') {
			if (!/^\d+$/.test(v) || +v < f.min || +v > f.max)
				return _('Enter a whole number from %d to %d.').format(f.min, f.max);
		}
		else if (f.type === 'decimal' && !/^\d+(\.\d+)?$/.test(v))
			return _('Enter a number, for example 300 or 12.5.');
		return f.check ? f.check(v) : null;
	}

	function renderSettings() {
		return Promise.all([
			uci.load(),
			call('status').catch(function() { return {}; }),
			call('meta').catch(function() { return {}; })
		]).then(function(data) {
			var rows = {}, seq = 0, status = E('span', { 'class': 'ispy-saved', 'role': 'status' });
			var val = function(k) { return config[k] != null ? String(config[k]) : (DEFAULTS[k] || ''); };

			var control = function(f) {
				var id = 'ispy-f-' + f.key, help = f.help ? id + '-help' : null, el, extra = null;
				var a = { 'id': id, 'name': f.key, 'aria-describedby': help };
				if (f.type === 'flag') {
					a.type = 'checkbox';
					el = E('input', a);
					el.checked = val(f.key) === '1';
				}
				else if (f.type === 'select' || f.type === 'network' || f.type === 'interval') {
					var opts = f.type === 'network'
						? [ [ '', _('Default route (recommended)') ] ].concat(networks.map(function(n) { return [ n, n ]; }))
						: f.type === 'interval' ? INTERVALS.concat([ [ 'custom', _('Other (minutes)…') ] ]) : f.options;
					var cur = val(f.key);
					if (f.type === 'interval' && !INTERVALS.some(function(o) { return o[0] === cur; }))
						cur = 'custom';
					if (!opts.some(function(o) { return o[0] === cur; }))
						opts = opts.concat([ [ cur, cur ] ]);
					el = E('select', a, opts.map(function(o) { return E('option', { 'value': o[0] }, [ o[1] ]); }));
					el.value = cur;
					if (f.type === 'interval') {
						extra = E('input', { 'type': 'text', 'inputmode': 'numeric', 'aria-label': _('Interval in minutes'), 'style': 'width:8em;margin-left:8px' });
						extra.value = val(f.key);
						extra.hidden = cur !== 'custom';
						el.addEventListener('change', function() {
							extra.hidden = el.value !== 'custom';
							if (!extra.hidden)
								extra.focus();
						});
					}
				}
				else {
					a.type = 'text';
					a.autocomplete = 'off';
					if (f.type === 'int' || f.type === 'decimal')
						a.inputmode = f.type === 'int' ? 'numeric' : 'decimal';
					if (f.suggestions && f.suggestions.length) {
						a.list = id + '-list';
						extra = E('datalist', { 'id': a.list }, f.suggestions.map(function(s) { return E('option', { 'value': s }); }));
					}
					el = E('input', a);
					el.value = val(f.key);
					if (f.type === 'int' || f.type === 'decimal')
						el.style.width = '10em';
				}
				var err = E('p', { 'class': 'ispy-field-error', 'id': id + '-error', 'hidden': '' });
				var row = E('div', { 'class': 'ispy-row' }, [
					E('label', { 'for': id }, [ f.label ]),
					E('div', {}, [ el, extra, err, f.help ? E('p', { 'class': 'ispy-help', 'id': help }, [ f.help ]) : '' ])
				]);
				/* The control a message belongs to: the minutes box for a
				 * custom interval, otherwise the field itself. */
				var target = f.type === 'interval' ? extra : el;
				rows[f.key] = {
					f: f, row: row, input: target,
					value: function() {
						if (f.type === 'flag')
							return el.checked ? '1' : '0';
						if (f.type === 'interval')
							return el.value === 'custom' ? extra.value.trim() : el.value;
						return el.value.trim();
					},
					show: function(msg) {
						if (msg && f.type === 'interval') {
							el.value = 'custom';
							extra.hidden = false;
						}
						err.hidden = !msg;
						err.textContent = msg || '';
						target.classList.toggle('ispy-invalid', !!msg);
						if (msg)
							target.setAttribute('aria-invalid', 'true');
						else
							target.removeAttribute('aria-invalid');
						target.setAttribute('aria-describedby', ((msg ? id + '-error ' : '') + (target === el && help ? help : '')).trim());
					}
				};
				return row;
			};

			var form = E('form', { 'novalidate': '' }, sections(data[1], data[2]).map(function(s) {
				return E('div', { 'class': 'ispy-section' }, [ E('h3', {}, [ s[0] ]) ].concat(s[1].map(control)));
			}));

			/* Options that only apply to some engines. */
			var backendSel = rows.backend.input;
			var showFor = function() {
				Object.keys(rows).forEach(function(k) {
					var b = rows[k].f.backends;
					rows[k].row.hidden = !!b && b.indexOf(backendSel.value) < 0;
				});
				resize();
			};
			backendSel.addEventListener('change', showFor);
			showFor();

			var saveBtn = E('button', { 'type': 'submit', 'class': 'cbi-button cbi-button-action' }, [ _('Save') ]);
			form.appendChild(E('div', { 'class': 'ispy-actions-row' }, [ saveBtn, status ]));

			form.addEventListener('submit', function(ev) {
				ev.preventDefault();
				var values = {}, first = null;
				Object.keys(rows).forEach(function(k) {
					var r = rows[k], v = r.value(), msg = fieldError(r.f, v);
					r.show(msg);
					if (msg && !first)
						first = r;
					values[k] = v;
				});
				if (first) {
					status.textContent = _('Please correct the highlighted setting.');
					first.input.focus();
					resize();
					return;
				}
				var my = ++seq;
				saveBtn.disabled = true;
				status.textContent = _('Saving…');
				call('set_config', { values: values }).then(function() {
					return uci.load();
				}).then(function() {
					if (my === seq)
						status.textContent = _('Saved. The scheduler picks up the change within a minute.');
				}).catch(function(e) {
					var r = e.field && rows[e.field];
					if (r) {
						r.show(_('The router did not accept this value (%s).').format(e.message));
						r.input.focus();
					}
					status.textContent = _('Not saved: %s').format(e.message);
				}).then(function() {
					saveBtn.disabled = false;
					resize();
				});
			});

			return E('div', {}, [
				E('h2', {}, [ _('ISPy Speed Monitor – Settings') ]),
				E('p', { 'class': 'cbi-map-descr' }, [ _('How often speed tests run, which test engine is used, what your plan promises, and where results are stored.') ]),
				form
			]);
		});
	}

	/* ------------------------------------------------------------ page -- */

	var PAGES = [ [ 'overview', _('Overview') ], [ 'report', _('Report') ], [ 'settings', _('Settings') ] ];
	var app, nav, view, current = null, navSeq = 0;

	function resize() {
		if (!frame || !app)
			return;
		var h = app.offsetHeight;
		if (modal && modal.firstChild)
			h = Math.max(h, modal.firstChild.offsetTop + modal.firstChild.offsetHeight + 24);
		frame.style.height = Math.ceil(h) + 'px';
	}

	function runView(name) {
		return requireModule('view.ispy.' + name).then(function(View) {
			var v = Object.create(View);
			return Promise.resolve(v.load ? v.load() : null).then(function(d) { return v.render(d); });
		});
	}

	function show(page) {
		if (!PAGES.some(function(p) { return p[0] === page; }))
			page = 'overview';
		var my = ++navSeq;
		current = page;
		stopPolls();
		ui.hideModal();
		dom.content(notices, '');
		try { window.sessionStorage.setItem('ispy.gl.page', page); } catch (e) {}
		Array.prototype.forEach.call(nav.children, function(b) {
			if (b.getAttribute('data-page') === page)
				b.setAttribute('aria-current', 'page');
			else
				b.removeAttribute('aria-current');
		});
		dom.content(view, E('p', { 'class': 'spinning' }, [ _('Loading…') ]));
		if (visibleTop() > 0)
			try { frame.scrollIntoView({ block: 'start' }); } catch (e) {}
		return (page === 'settings' ? renderSettings() : runView(page)).then(function(node) {
			if (my === navSeq)
				dom.content(view, node);
		}).catch(function(e) {
			if (my === navSeq)
				dom.content(view, E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
					_('ISPy could not load this page: %s').format(e && e.message || e)
				]));
		}).then(resize);
	}

	function start() {
		document.head.appendChild(E('style', {}, [ CSS ]));
		syncTheme();
		watchTheme();

		nav = E('nav', { 'class': 'ispy-nav', 'aria-label': _('ISPy pages') }, PAGES.map(function(p) {
			return E('button', { 'type': 'button', 'data-page': p[0], 'click': function() { show(p[0]); } }, [ p[1] ]);
		}));
		notices = E('div');
		view = E('div', { 'id': 'ispy-view' });
		app = E('div', { 'id': 'ispy-app' }, [ nav, notices, view ]);
		document.body.appendChild(app);

		/* Links between ISPy's pages (L.url) are "#page". */
		document.addEventListener('click', function(ev) {
			var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
			if (a) {
				ev.preventDefault();
				show(a.getAttribute('href').slice(1));
			}
		});

		if (window.ResizeObserver)
			new ResizeObserver(resize).observe(app);
		else
			setInterval(resize, 1000);
		window.addEventListener('pagehide', stopPolls);

		if (!host) {
			dom.content(view, E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
				_('This page only works inside the GL.iNet admin panel: open Applications → ISPy Speed Monitor there.')
			]));
			resize();
			return;
		}
		var first = null;
		try { first = window.sessionStorage.getItem('ispy.gl.page'); } catch (e) {}
		show(first || 'overview');
	}

	start();
})();
