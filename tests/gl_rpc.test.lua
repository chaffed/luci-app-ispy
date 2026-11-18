--[[
    Checks ISPy's module for the GL.iNet admin panel
    (luci-app-ispy/root/usr/lib/oui-httpd/rpc/ispy) with stand-ins for the
    panel's web server (ngx.pipe) and for UCI. Needs Lua 5.1 and lua-cjson.
    Run: lua tests/gl_rpc.test.lua [path/to/module]
--]]

local here = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local module_path = arg and arg[1] or (here .. "/../luci-app-ispy/root/usr/lib/oui-httpd/rpc/ispy")

-- ------------------------------------------------------------ stand-ins --

local spawned, spawn_opts = {}, {}
local outputs = {
    status = '{"version":"1.2.0","running":false,"count":3}',
    meta = '{"drives":["/tmp/mountd/disk1_part1"]}',
    ["results-json"] = '{"csv":"ts,backend\\n1,ookla\\n"}',
    ["export-status"] = '{"dir":"/mnt/usb/ispy","ok":true}',
}

-- Like the panel's own ngx.pipe (/usr/share/gl-ngx/oui-init.lua): spawn(args,
-- opts) and a process with stdout_read_all() and wait(), nothing else.
ngx = {
    pipe = {
        spawn = function(cmd, opts)
            spawned[#spawned + 1] = cmd
            spawn_opts[#spawn_opts + 1] = opts or {}
            local proc = {
                stdout_read_all = function() return outputs[cmd[2]] or "" end,
                wait = function() return outputs[cmd[2]] or "" end,
            }
            return setmetatable(proc, { __index = function(_, k)
                error("the panel's ngx.pipe has no method " .. tostring(k), 2)
            end })
        end,
    },
}

local store, committed
local function reset_store()
    store = {
        ispy = { main = { [".type"] = "ispy", enabled = "1", interval = "60", backend = "auto",
            subscriber = "Old Name", secret = "not a setting" } },
        network = {
            loopback = { [".type"] = "interface", proto = "static" },
            wan = { [".type"] = "interface", proto = "dhcp" },
            lan = { [".type"] = "interface", proto = "static" },
            unused = { [".type"] = "interface", proto = "none" },
            wwan = { [".type"] = "interface", proto = "dhcp" },
        },
    }
    committed = 0
end

package.loaded.uci = {
    cursor = function()
        return {
            get = function(_, conf, sec, opt)
                local s = store[conf] and store[conf][sec]
                if not s then return nil end
                if opt == nil then return s[".type"] end
                return s[opt]
            end,
            set = function(_, conf, sec, a, b)
                store[conf] = store[conf] or {}
                if b == nil then
                    store[conf][sec] = store[conf][sec] or { [".type"] = a }
                else
                    store[conf][sec][a] = b
                end
                return true
            end,
            delete = function(_, conf, sec, opt) store[conf][sec][opt] = nil return true end,
            commit = function() committed = committed + 1 return true end,
            foreach = function(_, conf, typ, fn)
                local names = {}
                for name in pairs(store[conf] or {}) do names[#names + 1] = name end
                table.sort(names)
                for _, name in ipairs(names) do
                    local s = store[conf][name]
                    if s[".type"] == typ then
                        local copy = { [".name"] = name }
                        for k, v in pairs(s) do copy[k] = v end
                        fn(copy)
                    end
                end
            end,
        }
    end,
}

reset_store()
local M = dofile(module_path)

-- ---------------------------------------------------------------- checks --

local fail = 0
local function ok(name, cond, detail)
    if not cond then fail = fail + 1 end
    print((cond and "ok   " or "FAIL ") .. name .. ((cond or detail == nil) and "" or (": " .. tostring(detail))))
end

local function last_cmd() return table.concat(spawned[#spawned] or {}, " ") end

-- commands
local st = M.status()
ok("status decodes what ispy prints", st.version == "1.2.0" and st.count == 3)
ok("status runs ispy status", last_cmd() == "/usr/bin/ispy status", last_cmd())

M.results({ since = 1700000000, limit = 1500, offset = 3000 })
ok("results passes whole numbers", last_cmd() == "/usr/bin/ispy results-json 1700000000 1500 3000", last_cmd())
M.results({ since = -5, limit = 999999, offset = "abc" })
ok("results clamps out-of-range numbers", last_cmd() == "/usr/bin/ispy results-json 0 5000 0", last_cmd())
M.results({ since = "1; reboot", limit = 2.7 })
ok("results ignores text where a number belongs", last_cmd() == "/usr/bin/ispy results-json 0 2 0", last_cmd())
M.results(nil)
ok("results works without arguments", last_cmd() == "/usr/bin/ispy results-json 0 1500 0", last_cmd())
local cmd = spawned[#spawned]
ok("commands are argument lists, never a shell line", type(cmd) == "table" and #cmd == 5)
ok("a time limit is passed the way the panel expects", spawn_opts[#spawn_opts].stdout_read_timeout == 60000, spawn_opts[#spawn_opts].stdout_read_timeout)

ok("run starts a test", M.run().started == true and last_cmd() == "/usr/bin/ispy start")
ok("clear clears", M.clear().cleared == true and last_cmd() == "/usr/bin/ispy clear")
local ex = M.export()
ok("export saves, then reports the state", ex.ok == true and spawned[#spawned - 1][2] == "export" and last_cmd() == "/usr/bin/ispy export-status")

outputs.status = "not json"
local bad = M.status()
ok("an unreadable answer becomes an error", bad.err_code == -1 and bad.err_msg ~= nil)

-- settings: reading
local cfg = M.get_config()
ok("get_config returns the settings", cfg.config.interval == "60" and cfg.config.subscriber == "Old Name")
ok("get_config leaves out options that are not settings", cfg.config.secret == nil)
ok("networks: usable interfaces only, sorted", table.concat(cfg.networks, ",") == "lan,wan,wwan", table.concat(cfg.networks, ","))

-- settings: writing
local function try(values)
    reset_store()
    return M.set_config({ values = values })
end

local r = try({ enabled = true, interval = 120, plan_down = 300.5, plan_up = "40",
    service_address = "100 Example Street, Apt #4, Springfield", subscriber = "Zoë O'Brien",
    export_dir = "/tmp/mountd/disk1_part1/ispy", interface = "", ookla_server = "" })
local m = store.ispy.main
ok("valid settings are saved", r.saved == true and committed == 1, r.err_msg)
ok("true is stored as 1", m.enabled == "1")
ok("numbers are stored as text", m.interval == "120" and m.plan_down == "300.5" and m.plan_up == "40")
ok("text with commas, apostrophes and accents is kept", m.service_address == "100 Example Street, Apt #4, Springfield" and m.subscriber == "Zoë O'Brien")
ok("empty optional settings are removed", m.interface == nil and m.ookla_server == nil)
ok("settings not sent are left alone", m.backend == "auto" and m.secret == "not a setting")

r = try({ ookla_server = 9999999999 })
ok("large whole numbers are stored exactly", r.saved and store.ispy.main.ookla_server == "9999999999", store.ispy.main.ookla_server)

r = try({ interval = "  240  " })
ok("surrounding spaces are trimmed", r.saved and store.ispy.main.interval == "240")

local refused = {
    { "interval below 5", { interval = "4" }, "interval" },
    { "interval above a week", { interval = "10081" }, "interval" },
    { "interval not a number", { interval = "1h" }, "interval" },
    { "required setting left empty", { interval = "" }, "interval" },
    { "unknown engine", { backend = "evil" }, "backend" },
    { "streams above 16", { streams = "17" }, "streams" },
    { "duration below 5", { duration = "4" }, "duration" },
    { "ping host that is an option", { ping_host = "-c" }, "ping_host" },
    { "ping host with a space", { ping_host = "1.1.1.1 ; reboot" }, "ping_host" },
    { "interface with a slash", { interface = "../wan" }, "interface" },
    { "negative advertised speed", { plan_down = "-1" }, "plan_down" },
    { "text over 120 bytes", { isp_name = string.rep("x", 121) }, "isp_name" },
    { "text with a line break", { subscriber = "A\nB" }, "subscriber" },
    { "text with a control character", { account = "12\0273" }, "account" },
    { "results file not ending in .csv", { results_file = "/etc/ispy/results.txt" }, "results_file" },
    { "results file going up a folder", { results_file = "/etc/../tmp/x.csv" }, "results_file" },
    { "relative results file", { results_file = "results.csv" }, "results_file" },
    { "drive folder that is the root", { export_dir = "/" }, "export_dir" },
    { "drive folder with a space", { export_dir = "/mnt/my drive" }, "export_dir" },
    { "keep-at-most below 100", { max_results = "99" }, "max_results" },
    { "a setting that does not exist", { cf_url = "http://evil" }, "cf_url" },
    { "a table where text belongs", { subscriber = { "x" } }, "subscriber" },
}
for _, t in ipairs(refused) do
    local res = try(t[2])
    ok("refused: " .. t[1], res.err_code == -1 and res.field == t[3] and committed == 0, res.field or res.saved)
end

r = try({ interval = "120", backend = "evil" })
ok("nothing is stored when one value is refused", store.ispy.main.interval == "60" and committed == 0)
ok("no settings sent: refused", try(nil).err_code == -1 and M.set_config({ values = "x" }).err_code == -1)

-- every setting the LuCI page offers can be set from the panel
local luci = { "enabled", "interval", "busy_threshold", "backend", "interface", "streams", "duration",
    "ping_host", "ping_count", "ookla_server", "librespeed_server", "plan_down", "plan_up", "isp_name",
    "plan_name", "subscriber", "account", "service_address", "results_file", "max_results", "export_dir" }
local missing = {}
for _, k in ipairs(luci) do if not M.FIELDS[k] then missing[#missing + 1] = k end end
ok("every LuCI setting is known (" .. #luci .. ")", #missing == 0, table.concat(missing, ","))

print(fail == 0 and "all passed" or (fail .. " FAILED"))
os.exit(fail == 0 and 0 or 1)
