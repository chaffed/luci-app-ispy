'use strict';
'require view';
'require form';
'require rpc';
'require tools.widgets as widgets';

/*
 * ISPy - "I spy on my ISP"
 * Settings page (UCI config /etc/config/ispy).
 * SPDX-License-Identifier: MIT
 */

var callStatus = rpc.declare({ object: 'luci.ispy', method: 'status' });

return view.extend({
	load: function() {
		return callStatus().catch(function() { return {}; });
	},

	render: function(st) {
		var m, s, o;
		var avail = (st && st.backends) || [];
		var has = function(b) { return avail.indexOf(b) > -1; };

		m = new form.Map('ispy', _('ISPy Speed Monitor – Settings'),
			_('Configure how often speed tests run, which test engine is used and how results are stored.'));

		s = m.section(form.NamedSection, 'main', 'ispy');
		s.anonymous = true;
		s.tab('schedule', _('Schedule'));
		s.tab('engine', _('Test engine'));
		s.tab('plan', _('My plan'));
		s.tab('storage', _('Storage'));

		/* schedule */
		o = s.taboption('schedule', form.Flag, 'enabled', _('Enable scheduled tests'));
		o.rmempty = false;

		o = s.taboption('schedule', form.Value, 'interval', _('Test interval (minutes)'),
			_('Each test uses data (roughly link speed × duration × 2). Very short intervals can trigger rate limits on public test servers.'));
		o.datatype = 'range(5,10080)';
		o.default = '60';
		o.value('15', _('Every 15 minutes'));
		o.value('30', _('Every 30 minutes'));
		o.value('60', _('Every hour'));
		o.value('120', _('Every 2 hours'));
		o.value('240', _('Every 4 hours'));
		o.value('360', _('Every 6 hours'));
		o.value('720', _('Every 12 hours'));
		o.value('1440', _('Once a day'));

		o = s.taboption('schedule', form.Value, 'busy_threshold', _('Skip when the line is busy (Mbit/s)'),
			_('Before a scheduled test, measure current WAN traffic for 3 seconds. If it is above this value, wait 5 minutes and retry (up to 3 times), then record the test as skipped. Avoids disturbing your household and measuring a congested line. 0 = disabled.'));
		o.datatype = 'ufloat';
		o.default = '0';
		o.placeholder = '0';

		/* engine */
		o = s.taboption('engine', form.ListValue, 'backend', _('Speed test backend'),
			_('“Auto” prefers the Ookla CLI, then librespeed-cli, then the built-in Cloudflare test. Installed on this router: %s.')
				.format(avail.length ? avail.join(', ') : _('none detected')));
		o.value('auto', _('Auto'));
		o.value('cloudflare', _('Cloudflare (built-in, uses curl)'));
		o.value('ookla', _('Ookla speedtest CLI') + (has('ookla') ? '' : ' – ' + _('not installed')));
		o.value('librespeed', _('librespeed-cli') + (has('librespeed') ? '' : ' – ' + _('not installed')));
		o.default = 'auto';

		o = s.taboption('engine', widgets.NetworkSelect, 'interface', _('Test via interface'),
			_('Bind the test to a specific WAN (multi-WAN setups). Leave empty to use the default route.'));
		o.nocreate = true;
		o.optional = true;

		o = s.taboption('engine', form.Value, 'streams', _('Parallel streams'),
			_('Cloudflare backend: number of simultaneous connections. Use 4–8 for gigabit and faster links.'));
		o.datatype = 'range(1,16)';
		o.default = '4';
		o.depends('backend', 'cloudflare');
		o.depends('backend', 'auto');

		o = s.taboption('engine', form.Value, 'duration', _('Seconds per direction'),
			_('Cloudflare backend: how long download and upload are each measured.'));
		o.datatype = 'range(3,60)';
		o.default = '10';
		o.depends('backend', 'cloudflare');
		o.depends('backend', 'auto');

		o = s.taboption('engine', form.Value, 'ping_host', _('Latency target'),
			_('Host pinged for idle and loaded latency (Cloudflare backend).'));
		o.datatype = 'host';
		o.default = '1.1.1.1';
		o.placeholder = '1.1.1.1';

		o = s.taboption('engine', form.Value, 'ping_count', _('Idle pings'));
		o.datatype = 'range(1,50)';
		o.default = '10';

		o = s.taboption('engine', form.Value, 'ookla_server', _('Ookla server ID'),
			_('Optional. Find IDs with <code>speedtest -L</code>.'));
		o.datatype = 'uinteger';
		o.optional = true;
		o.depends('backend', 'ookla');
		o.depends('backend', 'auto');

		o = s.taboption('engine', form.Value, 'librespeed_server', _('LibreSpeed server ID'),
			_('Optional. Find IDs with <code>librespeed-cli --list</code>.'));
		o.datatype = 'uinteger';
		o.optional = true;
		o.depends('backend', 'librespeed');
		o.depends('backend', 'auto');

		/* plan */
		o = s.taboption('plan', form.Value, 'plan_down', _('Advertised download (Mbit/s)'),
			_('Drawn as a reference line and used for the “Plan delivery” score.'));
		o.datatype = 'ufloat';
		o.optional = true;

		o = s.taboption('plan', form.Value, 'plan_up', _('Advertised upload (Mbit/s)'));
		o.datatype = 'ufloat';
		o.optional = true;

		/* storage */
		o = s.taboption('storage', form.Value, 'results_file', _('Results file'),
			_('CSV file with one line per test. Keep it under /etc (or a USB drive) so history survives reboots; /tmp is lost on reboot.'));
		o.default = '/etc/ispy/results.csv';
		o.placeholder = '/etc/ispy/results.csv';
		o.datatype = 'string';

		o = s.taboption('storage', form.Value, 'max_results', _('Keep at most (tests)'),
			_('Older results are removed beyond this count. 4000 ≈ 5.5 months at an hourly interval (~0.4 MB).'));
		o.datatype = 'range(100,50000)';
		o.default = '4000';

		return m.render();
	}
});
