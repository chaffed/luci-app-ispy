# ISPy - scheduled ISP speed tests for LuCI
# Drop this directory into an OpenWrt/LuCI feed (feeds/luci/applications/)
# or build a standalone .ipk with scripts/build-ipk.sh.
#
# SPDX-License-Identifier: MIT

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ispy
PKG_VERSION:=1.1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

LUCI_TITLE:=ISPy - scheduled speed tests with statistics and graphs
LUCI_DESCRIPTION:=Runs internet speed tests on a schedule (Cloudflare built-in, \
	Ookla CLI or librespeed-cli), shows throughput, latency, bufferbloat and \
	time-of-day statistics in LuCI, and builds a printable report comparing \
	measured with advertised speeds.
LUCI_DEPENDS:=+luci-base +curl +jsonfilter
LUCI_PKGARCH:=all

define Package/luci-app-ispy/conffiles
/etc/config/ispy
endef

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
