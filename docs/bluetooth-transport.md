# Bluetooth Transport (Experimental)

This document describes the initial GSConnect Bluetooth transport implementation
for KDE Connect compatibility.

## Scope

The current implementation adds a new `bluetooth` backend that:

- Registers an RFCOMM profile with BlueZ using the KDE Connect UUID
  (`185f3df4-3268-4e3f-9fca-d4d5059915bd`).
- Discovers paired BlueZ devices that advertise KDE Connect service UUIDs.
- Initiates `ConnectProfile()` calls and accepts incoming profile connections.
- Exchanges `kdeconnect.identity` packets over the Bluetooth socket.
- Verifies and persists remote certificates from identity packets.
- Integrates with existing manager/device pairing and reconnect flows through
  `bluetooth://<MAC>` URIs.

## Files

Main backend:

- `src/service/backends/bluetooth.js`

Integration points:

- `src/service/manager.js`
- `src/service/device.js`
- `src/preferences/service.js`
- `data/ui/connect-dialog.ui`
- `data/org.gnome.Shell.Extensions.GSConnect.sdp.xml`

## Runtime Behavior

1. On service startup, the backend opens a system bus connection and creates a
   BlueZ object manager (`org.bluez`).
2. It registers `org.bluez.Profile1` at
   `/org/gnome/Shell/Extensions/GSConnect/BluetoothProfile`.
3. It registers the profile with BlueZ `ProfileManager1.RegisterProfile()` and
   includes the bundled KDE Connect SDP record.
4. It periodically scans paired BlueZ devices and connects to those advertising
   KDE Connect UUIDs.
5. On `NewConnection`, the backend wraps the socket file descriptor with
   `Gio.SocketConnection` and creates a GSConnect channel.
6. The channel exchanges identity packets and verifies the peer certificate
   against the trusted device certificate if one is already stored.

## Security Model

Bluetooth links do not use GSConnect's LAN TLS channel.

For Bluetooth, trust is established with the identity certificate and GSConnect
pairing state:

- If a known `certificate-pem` exists for the device and does not match the
  incoming identity certificate, the device is unpaired and certificate trust is
  reset.
- On pairing acceptance, the device certificate from the identity packet is
  saved to `certificate-pem`.

## Current Limitations

- Payload transfers (`upload`/`download`) are not implemented for Bluetooth in
  this iteration. Packet-only plugins should work; plugins requiring payload
  channels still rely on LAN transport.
- The connect dialog currently supports manual Bluetooth MAC entry, while scan
  and auto-connect are backend-driven.
- This backend depends on BlueZ `ProfileManager1` support and RFCOMM profile
  behavior on the host.

## Manual Test Checklist

1. Open GSConnect preferences and use `Connect to...`.
2. Enter a Bluetooth MAC address (`XX:XX:XX:XX:XX:XX`) and click `Connect`.
3. Ensure the device appears and pairing works.
4. Validate packet-based plugin functionality (for example ping and clipboard
   metadata sync).
5. Confirm reconnect after service restart using saved `last-connection`.
6. Verify LAN pairing/discovery behavior remains unchanged.
