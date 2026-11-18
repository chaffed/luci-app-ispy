-- ISPy for the GL.iNet admin panel (luci-app-ispy).
-- set_config checks every value itself (/usr/lib/oui-httpd/rpc/ispy). The
-- panel's default check only allows letters, digits and " .-_:#/", which
-- would refuse ordinary text such as the comma in a service address.
-- The other ISPy methods only take numbers and keep the default check.
-- SPDX-License-Identifier: MIT
return { set_config = true }
