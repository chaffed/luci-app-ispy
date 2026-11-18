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
- GL.iNet admin panel (firmware 4.x, undocumented interface, learned from the firmware): the panel `eval`s `/www/views/gl-sdk4-ui-<view>.common.js` as a Vue 2 component, takes menu entries from `/usr/share/oui/menu.d/*.json` (label `menu_<view>` from `/www/i18n/gl-sdk4-ui-<view>.<lang>.json`), and runs Lua RPC modules from `/usr/lib/oui-httpd/rpc/<object>`. Its `ngx.pipe` is GL's own (`spawn(args, opts)`, then `stdout_read_all()`/`wait()` only), its default argument check refuses commas and similar (hence `/usr/share/gl-validator.d/ispy.lua`), and nginx keeps a module in memory once used, so the package reloads nginx on install. Run `lua tests/gl_rpc.test.lua` after touching the module.
- `ispy/gl.js` runs the LuCI Overview and Report views inside the GL panel with stand-ins for `view`, `rpc`, `ui` (showModal, hideModal, addNotification), `uci` (load, get), `poll.add`, `dom`, `L.bind`/`L.url`, `E` and `_`. A view that starts using any other LuCI API must get a stand-in there too. Settings in the panel is a separate form in `gl.js`, so a new UCI option needs adding in `settings.js`, `gl.js` and the Lua module's `FIELDS`.
- The copy on a USB drive must only ever be written to a mounted drive: `on_drive` is checked before anything is created, because an unplugged drive's mount point is a folder in the router's RAM or flash.
- In LuCI, `E(tag, attrs, 'string')` assigns the string with `innerHTML`. Text that comes from the results file must be passed as an array child (`[ text ]`), and the report builder must `esc()` it.
- `tests/fake_speedtest_server.py` stands in for the Cloudflare endpoints at a known rate; point `cf_url` at it to check the engine in an OpenWrt container.
