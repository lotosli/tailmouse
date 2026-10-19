package main

import (
	"context"
	"github.com/godbus/dbus/v5"
)

// D-Bus keeps the bearer URL out of command arguments and temporary files.
func openShareBrowser(ctx context.Context, address string) error {
	connection, e := dbus.ConnectSessionBus()
	if e != nil {
		return e
	}
	defer connection.Close()
	call := connection.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop").CallWithContext(ctx, "org.freedesktop.portal.OpenURI.OpenURI", 0, "", address, map[string]dbus.Variant{})
	return call.Err
}
