/* Synthetic results for tests and demo screenshots: a 1000/40 Mbit/s plan
 * that delivers about 65% off-peak and about 40% in the evening. */
exports.HEADER = 'ts,backend,server,ping_ms,jitter_ms,loss_pct,loaded_down_ms,loaded_up_ms,down_mbps,up_mbps,bytes,status,message,wan_down_mbps,wan_up_mbps,bg_down_mbps,bg_up_mbps,cpu_down_pct,cpu_up_pct,link_mbps,dev';

exports.make = function(now, days, opts) {
	opts = opts || {};
	var rows = [], seed = 11;
	var rnd = function() { return (seed = (seed * 16807) % 2147483647) / 2147483647; };
	for (var t = now - days * 86400 + 600; t < now; t += 3600 + Math.floor(rnd() * 180)) {
		if (t > now - 9 * 86400 && t < now - 8.7 * 86400) continue;      /* router off for a while */
		var d = new Date(t * 1000), h = d.getHours(), dow = d.getDay();
		if (rnd() < 0.012) { rows.push(t + ',cloudflare,Cloudflare PDX,12.4,1.1,0.0,,,,,0,error,test server refused the test: rate limit (HTTP 429),,,0.31,0.05,,,2500,eth0'); continue; }
		if (rnd() < 0.008) { rows.push(t + ',cloudflare,,,,,,,,,0,skipped,line busy (312.4 Mbit/s > 100),,,,,,,,eth0'); continue; }
		var f = (h >= 18 && h <= 23) ? 0.36 + rnd() * 0.12 : 0.6 + rnd() * 0.12;
		if (dow === 6 && h >= 13 && h <= 23) f = 0.3 + rnd() * 0.08;       /* bad Saturdays */
		if (rnd() < 0.01) f = 0.88 + rnd() * 0.04;                         /* rare good result */
		if (opts.good) f = 0.97 + rnd() * 0.06;                            /* a line that delivers */
		var test = 1000 * f, wan = test * (1.015 + rnd() * 0.01);
		var up = (opts.good ? 39 : 31) + rnd() * 5, upw = up * (1.01 + rnd() * 0.01);
		var ping = 11 + rnd() * 3, bg = rnd() < 0.04 ? 60 + rnd() * 80 : rnd() * 1.2;
		rows.push([ t, 'cloudflare', 'Cloudflare PDX', ping.toFixed(2), (rnd() * 2).toFixed(2), rnd() < 0.03 ? '10.0' : '0.0',
			(ping + 20 + rnd() * 40).toFixed(2), (ping + 90 + rnd() * 120).toFixed(2), test.toFixed(2), up.toFixed(2),
			Math.round(test * 1.25e6 + up * 1.25e6), 'ok', '', wan.toFixed(2), upw.toFixed(2), bg.toFixed(2), (rnd() * 0.3).toFixed(2),
			Math.round(22 + f * 30 + rnd() * 6), Math.round(4 + rnd() * 3), 2500, 'eth0' ].join(','));
	}
	/* a row whose text fields contain markup, to prove nothing renders it */
	if (opts.hostile)
		rows.push((now - 120) + ',cloudflare,<img src=x onerror=window.__xss=1>,12.0,1.0,0.0,40,150,640.00,33.00,1,ok,<b onmouseover=window.__xss=2>hi</b>,650.00,33.50,0.2,0.1,35,5,2500,eth0');
	return exports.HEADER + '\n' + rows.join('\n') + '\n';
};

/* LuCI's String.prototype.format, as far as these modules use it. */
exports.installFormat = function() {
	String.prototype.format = function() {
		var a = arguments, i = 0;
		return this.replace(/%(0?)(\d*)(?:\.(\d+))?([sdf%])/g, function(m, z, w, p, c) {
			if (c === '%') return '%';
			var v = a[i++];
			if (c === 'd') v = String(Math.round(v)); else if (c === 'f') v = (+v).toFixed(p ? +p : 6); else v = String(v);
			if (w) while (v.length < +w) v = (z ? '0' : ' ') + v;
			return v;
		});
	};
};
