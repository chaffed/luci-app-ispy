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
- In LuCI, `E(tag, attrs, 'string')` assigns the string with `innerHTML`. Text that comes from the results file must be passed as an array child (`[ text ]`), and the report builder must `esc()` it.
- `tests/fake_speedtest_server.py` stands in for the Cloudflare endpoints at a known rate; point `cf_url` at it to check the engine in an OpenWrt container.
