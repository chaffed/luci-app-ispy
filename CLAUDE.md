# luci-app-ispy

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `chaffed/luci-app-ispy`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.

## Working on this repo

- The results are meant to stand up as evidence in a complaint to an ISP or the FCC. A test that can't be trusted (server refused it, router clock not synced) is stored as *failed*, never as a slow result, and measurement ambiguity is resolved in the ISP's favour (the reported speed is the higher of the test figure and the WAN-port total).
- Run `node tests/analysis.test.js` after touching `luci-app-ispy/htdocs/luci-static/resources/ispy/common.js`; it checks the report's statistics against an independent calculation.
- `ispy/report.js` builds the report for both the LuCI Report page and the file `ispy export` saves to a USB drive (`root/usr/share/ispy/standalone.*` plus the two `ispy/*.js` modules pasted into one HTML file). Run `node tests/report.test.js` after touching any of them.
- LuCI's `String.prototype.format` treats a `%` followed by a space or by `b c o q t m u x X j` as a conversion, so `'below 80% of …'.format(n)` prints garbage. Write a literal percent as `%%` in every string that is passed to `.format()`; the report test checks this.
- The copy on a USB drive must only ever be written to a mounted drive: `on_drive` is checked before anything is created, because an unplugged drive's mount point is a folder in the router's RAM or flash.
- In LuCI, `E(tag, attrs, 'string')` assigns the string with `innerHTML`. Text that comes from the results file must be passed as an array child (`[ text ]`), and the report builder must `esc()` it.
- `tests/fake_speedtest_server.py` stands in for the Cloudflare endpoints at a known rate; point `cf_url` at it to check the engine in an OpenWrt container.
