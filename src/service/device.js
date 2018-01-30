"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Protocol = imports.service.protocol;
const DeviceWidget = imports.widgets.device;


var Device = new Lang.Class({
    Name: "GSConnectDevice",
    Extends: GObject.Object,
    Properties: {
        "connected": GObject.ParamSpec.boolean(
            "connected",
            "deviceConnected",
            "Whether the device is connected",
            GObject.ParamFlags.READABLE,
            false
        ),
        "fingerprint": GObject.ParamSpec.string(
            "fingerprint",
            "deviceFingerprint",
            "SHA1 fingerprint for the device certificate",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "id": GObject.ParamSpec.string(
            "id",
            "deviceId",
            "The device id/hostname",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "name": GObject.ParamSpec.string(
            "name",
            "deviceName",
            "The device name",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "paired": GObject.ParamSpec.boolean(
            "paired",
            "devicePaired",
            "Whether the device is paired",
            GObject.ParamFlags.READABLE,
            false
        ),
        "plugins": GObject.param_spec_variant(
            "plugins",
            "PluginsList",
            "A list of enabled plugins",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "incomingCapabilities": GObject.param_spec_variant(
            "incomingCapabilities",
            "IncomingCapabilitiesList",
            "A list of incoming packet types the device can receive",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "outgoingCapabilities": GObject.param_spec_variant(
            "outgoingCapabilities",
            "OutgoingCapabilitiesList",
            "A list of outgoing packet types the device can send",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "deviceType",
            "The device type",
            GObject.ParamFlags.READABLE,
            ""
        )
    },

    _init: function (params) {
        this.parent();

        this.daemon = Gio.Application.get_default();
        this._channel = null;
        this._connected = false;

        this._incomingPairRequest = 0;
        this._outgoingPairRequest = 0;

        // Plugins
        this._plugins = new Map();
        this._handlers = new Map();

        // Param parsing
        let deviceId = params.id || params.packet.body.deviceId;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: ext.gschema.lookup(
                "org.gnome.Shell.Extensions.GSConnect.Device",
                true
            ),
            path: "/org/gnome/shell/extensions/gsconnect/device/" + deviceId + "/"
        });

        if (params.packet) {
            this._handleIdentity(params.packet);
        }

        // Export DBus
        this._dbus = Gio.DBusExportedObject.wrapJSObject(
            ext.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Device"
            ),
            this
        );
        this._dbus.export(
            Gio.DBus.session,
            ext.app_path + "/Device/" + deviceId.replace(/\W+/g, "_")
        );

        // A TCP Connection
        if (params.channel) {
            this._channel = params.channel;

            this._channel.connect("connected", (channel) => this._onConnected(channel));
            this._channel.connect("disconnected", (channel) => this._onDisconnected(channel));
		    this._channel.connect("received", (channel, packet) => this._onReceived(channel, packet));

            // Verify the certificate since it was TOFU'd by the listener
            if (!this.verify()) {
                return;
            }

		    this._channel.emit("connected");
        // A UDP Connection
        } else {
            this.activate();
        }
    },

    /** Device Properties */
    get connected () { return this._connected; },
    get fingerprint () {
        if (this.connected) {
            return this._channel._peer_cert.fingerprint();
        } else if (this.paired) {
            let cert = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string("certificate-pem"),
                -1
            );
            return cert.fingerprint();
        }

        return "";
    },
    get id () { return this.settings.get_string("id"); },
    get name () { return this.settings.get_string("name"); },
    get paired () { return (this.settings.get_string("certificate-pem")); },
    get plugins () { return Array.from(this._plugins.keys()); },
    get incomingCapabilities () { return this.settings.get_strv("incoming-capabilities"); },
    get outgoingCapabilities () { return this.settings.get_strv("outgoing-capabilities"); },
    get type () { return this.settings.get_string("type"); },

    _handleIdentity: function (packet) {
        this.settings.set_string("id", packet.body.deviceId);
        this.settings.set_string("name", packet.body.deviceName);
        this.settings.set_string("type", packet.body.deviceType);

        this.settings.set_strv(
            "incoming-capabilities",
            packet.body.incomingCapabilities.sort()
        );

        this.settings.set_strv(
            "outgoing-capabilities",
            packet.body.outgoingCapabilities.sort()
        );

        this.settings.set_string("tcp-host", packet.body.tcpHost);
        this.settings.set_uint("tcp-port", packet.body.tcpPort);
    },

    activate: function () {
        debug(this.name + " (" + this.id + ")");

		if (this._channel !== null) {
			debug(this.name + " (" + this.id + ")" + " already active");
			return;
		}

        this._channel = new Protocol.LanChannel(this.daemon, this.id);

        this._channel.connect("connected", (channel) => this._onConnected(channel));
        this._channel.connect("disconnected", (channel) => this._onDisconnected(channel));
		this._channel.connect("received", (channel, packet) => this._onReceived(channel, packet));

		let addr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string(
                this.settings.get_string("tcp-host")
            ),
            port: this.settings.get_uint("tcp-port")
        });

        this._channel.open(addr);
    },

    update: function (packet, channel=null) {
        debug(this.name + " (" + this.id + ")");

        if (channel) {
            this._handleIdentity(packet);

            if (this._channel !== null) {
                GObject.signal_handlers_destroy(this._channel);
            }

            this._channel = channel;
            this._channel.connect("connected", Lang.bind(this, this._onConnected));
            this._channel.connect("disconnected", Lang.bind(this, this._onDisconnected));
            this._channel.connect("received", Lang.bind(this, this._onReceived));

            // Verify the certificate since it was TOFU'd by the listener
            if (!this.verify()) {
                return;
            }

            if (!this.connected) {
                this._channel.emit("connected");
            }
        } else {
            this._onReceived(this._channel, packet);
        }
    },

    verify: function () {
        debug(this.name + " (" + this.id + ")");

        let cert;

        if (this.settings.get_string("certificate-pem")) {
            cert = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string("certificate-pem"),
                -1
            );
        }

        if (cert) {
            log("Authenticating '" + this.name + "'");

            if (cert.verify(null, this._channel._peer_cert) > 0) {
                log("Authentication failure: '" + this.name + "'");
                this._channel.close();
                return false;
            }
        }

        return true;
    },

    /** Channel Callbacks */
    _onConnected: function (channel) {
        log("Connected to '" + this.name + "'");

        this._loadPlugins().then((values) => {
            this._connected = true;
            this.notify("connected", "b");
            this.notify("plugins", "as");
        });

        // Ensure fingerprint is available right away
        this.notify("fingerprint", "s");
    },

    _onDisconnected: function (channel) {
        log("Disconnected from '" + this.name + "'");

        if (this._channel !== null) {
            this._channel = null;
        }

        this._unloadPlugins().then((values) => {
            this.notify("plugins", "as");
            this._connected = false;
            this.notify("connected", "b");
        });
    },

    _onReceived: function (channel, packet) {
        if (packet.type === Protocol.TYPE_IDENTITY) {
            this._handleIdentity(packet);
            this.activate();
        } else if (packet.type === Protocol.TYPE_PAIR) {
	        this._handlePair(packet);
	    } else if (this._handlers.has(packet.type)) {
	        // TODO: then-able resolve()'s
	        let handler = this._handlers.get(packet.type);
            handler.handlePacket(packet).then(result => {
                debug("Packet handled successfully: " + packet.type);
            }).catch(error => {
                debug("Error handling packet: " + error);
                debug(error.stack);
            });
        } else {
            debug("Received unsupported packet type: " + packet.toString());
        }
    },

    /** Overrides & utilities */
    send_notification: function (id, notification) {
        this.daemon.send_notification(this.id + "|" + id, notification);
    },

    withdraw_notification: function (id) {
        this.daemon.withdraw_notification(this.id + "|" + id);
    },

    notify: function (name, format=null) {
        GObject.Object.prototype.notify.call(this, name);

        if (format && this._dbus) {
            this._dbus.emit_property_changed(
                name,
                new GLib.Variant(format, this[name])
            );
        }
    },

    /** Pairing Functions */
    _handlePair: function (packet) {
        // A pair has been requested
        if (packet.body.pair) {
            // The device is accepting our request
            if (this._outgoingPairRequest) {
                log("Pair accepted by " + this.name);

                this._setPaired(true);
                this._loadPlugins().then((values) => {
                    this.notify("plugins", "as");
                });
            // The device thinks we're unpaired
            } else if (this.paired) {
                this.acceptPair();
            // The device is requesting pairing
            } else {
                log("Pair request from " + this.name);
                this._notifyPair(packet);
            }
        // Device is requesting unpairing/rejecting our request
        } else {
            log("Pair rejected by " + this.name);

            this._unloadPlugins().then((values) => {
                this.notify("plugins", "as");
                this._setPaired(false);
            });
        }
    },

    _notifyPair: function (packet) {
        let notif = new Gio.Notification();
        // TRANSLATORS: eg. Pair Request from Google Pixel
        notif.set_title(_("Pair Request from %s").format(this.name));
        notif.set_body(
            // TRANSLATORS: Remote and local TLS Certificate fingerprint
            // PLEASE KEEP NEWLINE CHARACTERS (\n)
            //
            // Example:
            //
            // Google Pixel Fingerprint:
            // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
            //
            // Local Fingerprint:
            // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
            _("%s Fingerprint:\n%s\n\nLocal Fingerprint:\n%s").format(
                this.name,
                this.fingerprint,
                this.daemon.fingerprint
            )
        );
        notif.set_icon(new Gio.ThemedIcon({ name: "channel-insecure-symbolic" }));
        notif.set_priority(Gio.NotificationPriority.URGENT);

        notif.add_button(
            _("Reject"),
            "app.pairAction(('" + this._dbus.get_object_path() + "','reject'))"
        );
        notif.add_button(
            _("Accept"),
            "app.pairAction(('" + this._dbus.get_object_path() + "','accept'))"
        );

        this.send_notification("pair-request", notif);

        // Start a 30s countdown
        this._incomingPairRequest = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => this._setPaired(false)
        );
    },

    _setPaired: function (bool) {
        if (this._incomingPairRequest) {
            this.withdraw_notification("pair-request");
            GLib.source_remove(this._incomingPairRequest);
            this._incomingPairRequest = 0;
        }

        if (this._outgoingPairRequest) {
            GLib.source_remove(this._outgoingPairRequest);
            this._outgoingPairRequest = 0;
        }

        if (bool) {
            this.settings.set_string(
                "certificate-pem",
                this._channel._peer_cert.certificate_pem
            );
        } else {
            this.settings.reset("certificate-pem");
        }

        this.notify("paired", "b");
    },

    pair: function () {
        debug(this.name + " (" + this.id + ")");

        // The pair button was pressed during an incoming pair request
        if (this._incomingPairRequest) {
            this.acceptPair();
            return;
        }

        // We're initiating an outgoing request
        if (!this.paired) {
            this._outgoingPairRequest = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                30,
                () => this._setPaired(false)
            );
        }

        // Send a pair packet
        let packet = new Protocol.Packet({
            id: 0,
            type: Protocol.TYPE_PAIR,
            body: { pair: true }
        });
        this._channel.send(packet);
    },

    unpair: function () {
        debug(this.name + " (" + this.id + ")");

        // Send the unpair packet only if we're connected
        if (this._channel !== null) {
            let packet = new Protocol.Packet({
                id: 0,
                type: Protocol.TYPE_PAIR,
                body: { pair: false }
            });
            this._channel.send(packet);
        }

        this._unloadPlugins().then((values) => {
            this.notify("plugins", "as");
            this._setPaired(false);
        });
    },

    acceptPair: function () {
        debug(this.name + " (" + this.id + ")");

        this._setPaired(true);
        this.pair();
        this._loadPlugins().then((values) => {
            this.notify("plugins", "as");
        });
    },

    rejectPair: function () {
        debug(this.name + " (" + this.id + ")");

        this.unpair();
    },

    /**
     * Plugin Functions
     */

    _supportedPlugins: function () {
        let supported = [];
        let incoming = this.incomingCapabilities;
        let outgoing = this.outgoingCapabilities;

        for (let name in imports.service.plugins) {
            // Skip base.js
            if (!imports.service.plugins[name].METADATA) { continue; }

            let metadata = imports.service.plugins[name].METADATA;

            // If it sends packets we can handle
            if (metadata.incomingPackets.some(v => outgoing.indexOf(v) >= 0)) {
                supported.push(name);
            // If it handles packets we can send
            } else if (metadata.outgoingPackets.some(v => incoming.indexOf(v) >= 0)) {
                supported.push(name);
            }
        }

        return supported.sort();
    },

    _loadPlugin: function (name) {
        debug(name + " (" + this.name + ")");

        return new Promise((resolve, reject) => {
            if (!this.paired) {
                reject([name, "Device not paired"]);
            }

            // Instantiate the handler
            let module, plugin;

            try {
                module = imports.service.plugins[name];
                plugin = new module.Plugin(this);
            } catch (e) {
                debug("Error loading " + name + ": " + e.stack);
                reject(e);
            }

            // Register packet handlers
            for (let packetType of module.METADATA.incomingPackets) {
                if (!this._handlers.has(packetType)) {
                    this._handlers.set(packetType, plugin);
                }
            }

            // Register as enabled
            if (!this._plugins.has(name)) {
                this._plugins.set(name, plugin);
            }

            resolve([name, true]);
        });
    },

    _loadPlugins: function () {
        let supported = this._supportedPlugins();
        let promises = supported.map(name => this._loadPlugin(name));
        return Promise.all(promises.map(p => p.catch(() => undefined)));
    },

    _unloadPlugin: function (name) {
        debug(name + " (" + this.name + ")");

        return new Promise((resolve, reject) => {
            if (!this.paired) {
                reject([name, false]);
            }

            // Unregister handlers
            let handler = imports.service.plugins[name];

            for (let packetType of handler.METADATA.incomingPackets) {
                this._handlers.delete(packetType);
            }

            // Register as disabled
            this._plugins.get(name).destroy();
            this._plugins.delete(name);

            resolve([name, true]);
        });
    },

    _unloadPlugins: function () {
        let promises = this.plugins.map(name => this._unloadPlugin(name));
        return Promise.all(promises.map(p => p.catch(() => undefined)));
    },

    openSettings: function () {
        this.daemon.openSettings(this._dbus.get_object_path());
    },

    destroy: function () {
        if (this.connected) {
            this._channel.close();
        }

        // TODO: it would be nice not to have to do this here
        for (let [name, plugin] of this._plugins) {
            plugin.destroy();
        }

        // TODO: this is causing errors to be thrown in _onDisconnected()
        //       because it gets called before the channel fully closes
        this._dbus.flush();
        this._dbus.unexport();
        delete this._dbus;
        GObject.signal_handlers_destroy(this);
    }
});

