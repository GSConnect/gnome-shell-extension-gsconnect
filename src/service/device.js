"use strict";

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const DBus = imports.modules.dbus;
const Protocol = imports.service.protocol;


/**
 * A device notification.
 *
 * TODO...
 */
var Notification = new Lang.Class({
    Name: "GSConnectDeviceNotification",
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
        )
    },

    _init: function (params) {
    },

    send: function () {
        let notif = new Gio.Notification();

        notif.set_title(this.title);
        notif.set_body(this.body);
        notif.set_icon(this.icon);

        for (let button of this.buttons) {
            // TODO
            notif.add_button();
        }

        if (this.action) {
            // TODO
            notif.set_default_action();
        }
    }
});


/**
 * An object representing a remote device.
 *
 * Device class is subclassed from Gio.SimpleActionGroup so it implements the
 * GActionGroup and GActionMap interfaces, like Gio.Application.
 *
 * TODO...
 */
var Device = new Lang.Class({
    Name: "GSConnectDevice",
    Extends: Gio.SimpleActionGroup,
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
        "icon-name": GObject.ParamSpec.string(
            "icon-name",
            "IconName",
            "Icon name representing the service device",
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
        "symbolic-icon-name": GObject.ParamSpec.string(
            "symbolic-icon-name",
            "ServiceIconName",
            "Symbolic icon name representing the service device",
            GObject.ParamFlags.READABLE,
            ""
        ),
        "type": GObject.ParamSpec.string(
            "type",
            "deviceType",
            "The device type",
            GObject.ParamFlags.READABLE,
            "unknown"
        )
    },
    Signals: {
        "destroy": {
            flags: GObject.SignalFlags.NO_HOOKS
        }
    },

    _init: function (params) {
        this.parent();

        this.service = Gio.Application.get_default();
        this._channel = null;
        this._connected = false;

        // GLib.Source timeout id's for pairing requests
        this._incomingPairRequest = 0;
        this._outgoingPairRequest = 0;

        // Maps of pluginName->pluginObject & packetType->pluginObject
        this._plugins = new Map();
        this._handlers = new Map();

        // We at least need the device Id for GSettings and the DBus interface
        let deviceId = params.id || params.packet.body.deviceId;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                "org.gnome.Shell.Extensions.GSConnect.Device",
                true
            ),
            path: "/org/gnome/shell/extensions/gsconnect/device/" + deviceId + "/"
        });

        // This relies on GSettings
        if (params.packet) {
            this._handleIdentity(params.packet);
        }

        // Export an object path for the device via the ObjectManager
        this._dbus_object = new Gio.DBusObjectSkeleton({
            g_object_path: gsconnect.app_path + "/Device/" + deviceId.replace(/\W+/g, "_")
        });
        this.service.objectManager.export(this._dbus_object);

        // Export org.gnome.Shell.Extensions.GSConnect.Device on that path
        this._dbus = new DBus.ProxyServer({
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(
                "org.gnome.Shell.Extensions.GSConnect.Device"
            )
        });
        this._dbus_object.add_interface(this._dbus);

        // GActions/GMenu
        this._actionsId = Gio.DBus.session.export_action_group(
            this._dbus.get_object_path(),
            this
        );

        this.menu = new Menu(this);
        this._menuId = this._dbus.get_connection().export_menu_model(
            this._dbus.get_object_path(),
            this.menu
        );

        // Created for an incoming TCP Connection
        if (params.channel) {
            this.update(params.channel.identity, params.channel);
        // Created for an identity packet over UDP or from cache
        } else {
            this.activate();
        }
    },

    /** Device Properties */
    get connected () { return this._connected; },
    get fingerprint () {
        if (this.connected) {
            return this._channel.certificate.fingerprint();
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
    get icon_name() {
        return (this.type === "desktop") ? "computer" : this.type;
    },
    get symbolic_icon_name() {
        let icon = (this.type === "phone") ? "smartphone" : this.type;
        icon = (this.type === "unknown") ? "desktop" : icon;

        if (this.paired && this.connected) {
            return icon + "connected";
        } else if (this.paired) {
            return icon + "trusted";
        } else {
            return icon + "disconnected";
        }
    },
    get type () { return this.settings.get_string("type"); },

    _handleIdentity: function (packet) {
        this.settings.set_string("id", packet.body.deviceId);
        this.settings.set_string("name", packet.body.deviceName);
        this.settings.set_string("type", packet.body.deviceType);
        this.settings.set_string("tcp-host", packet.body.tcpHost);
        this.settings.set_uint("tcp-port", packet.body.tcpPort);

        this.settings.set_strv(
            "incoming-capabilities",
            packet.body.incomingCapabilities.sort()
        );

        this.settings.set_strv(
            "outgoing-capabilities",
            packet.body.outgoingCapabilities.sort()
        );
    },

    /**
     * Open a new Protocol.Channel and try to connect to the device
     */
    activate: function () {
        debug(this.name + " (" + this.id + ")");

        // Already connected
		if (this._channel !== null) {
			debug(this.name + " (" + this.id + ")" + " already active");
			return;
		}

        // Create a new channel
        this._channel = new Protocol.Channel(this.id);
        this._channel.connect("connected", this._onConnected.bind(this));
        this._channel.connect("disconnected", this._onDisconnected.bind(this));
		this._channel.connect("received", this._onReceived.bind(this));

		let addr = new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string(
                this.settings.get_string("tcp-host")
            ),
            port: this.settings.get_uint("tcp-port")
        });

        this._channel.open(addr);
    },

    /**
     * Update the device with a UDP packet or replacement Protocol.Channel
     */
    update: function (packet, channel=null) {
        debug(this.name + " (" + this.id + ")");

        if (channel) {
            this._handleIdentity(channel.identity);

            // Disconnect from the current channel
            if (this._channel !== null) {
                GObject.signal_handlers_destroy(this._channel);
                this._channel.close();
            }

            // Connect to the new channel
            this._channel = channel;
            this._channel.connect("connected", Lang.bind(this, this._onConnected));
            this._channel.connect("disconnected", Lang.bind(this, this._onDisconnected));
            this._channel.connect("received", Lang.bind(this, this._onReceived));

            // Verify the certificate since it was TOFU'd by the listener
            if (!this.verify()) {
                this._channel.emit("disconnected");
            } else if (!this.connected) {
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

            if (cert.verify(null, this._channel.certificate) > 0) {
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

        this._connected = true;
        this.notify("connected");
        this.notify("symbolic-icon-name");

        // Ensure fingerprint is available right away
        this.notify("fingerprint");

        this._loadPlugins().then(values => this.notify("plugins"));
    },

    _onDisconnected: function (channel) {
        log("Disconnected from '" + this.name + "'");

        if (this._channel !== null) {
            this._channel = null;
        }

        this._unloadPlugins().then(values => {
            this.notify("plugins");
            this._connected = false;
            this.notify("connected");
            this.notify("symbolic-icon-name");
        });
    },

    _onReceived: function (channel, packet) {
        if (packet.type === Protocol.TYPE_IDENTITY) {
            this._handleIdentity(packet);
            this.activate();
        } else if (packet.type === Protocol.TYPE_PAIR) {
	        this._handlePair(packet);
	    } else if (this._handlers.has(packet.type)) {
	        let handler = this._handlers.get(packet.type);

            handler.handlePacket(packet).then(result => {
                debug("'" + packet.type + "' handled successfully: " + result);
            }).catch(e => debug(e));
        } else {
            debug("Received unsupported packet type: " + packet.toString());
        }
    },

    /** Overrides & utilities */
    send_notification: function (id, notification) {
        this.service.send_notification(this.id + "|" + id, notification);
    },

    withdraw_notification: function (id) {
        this.service.withdraw_notification(this.id + "|" + id);
    },

    /**
     * Pairing Functions
     */
    _handlePair: function (packet) {
        // A pair has been requested
        if (packet.body.pair) {
            // The device is accepting our request
            if (this._outgoingPairRequest) {
                log("Pair accepted by " + this.name);

                this._setPaired(true);
                this._loadPlugins().then((values) => {
                    this.notify("plugins");
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
                this.notify("plugins");
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
                this.service.fingerprint
            )
        );
        notif.set_icon(new Gio.ThemedIcon({ name: "channel-insecure-symbolic" }));
        notif.set_priority(Gio.NotificationPriority.URGENT);

        notif.add_device_button(
            _("Reject"),
            this._dbus.get_object_path(),
            "rejectPair"
        );
        notif.add_device_button(
            _("Accept"),
            this._dbus.get_object_path(),
            "acceptPair"
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
                this._channel.certificate.certificate_pem
            );
        } else {
            this.settings.reset("certificate-pem");
        }

        this.notify("paired");
        this.notify("symbolic-icon-name");
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
            this.notify("plugins");
            this._setPaired(false);
        });
    },

    acceptPair: function () {
        debug(this.name + " (" + this.id + ")");

        this._setPaired(true);
        this.pair();
        this._loadPlugins().then((values) => {
            this.notify("plugins");
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
            let meta = imports.service.plugins[name].Metadata;

            // Skip base.js
            if (!meta) { continue; }

            // If it sends packets we can handle
            if (meta.incomingCapabilities.some(v => outgoing.indexOf(v) > -1)) {
                supported.push(name);
            // Or handles packets we can send
            } else if (meta.outgoingCapabilities.some(v => incoming.indexOf(v) > -1)) {
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
            let handler, plugin;

            try {
                handler = imports.service.plugins[name];
                plugin = new handler.Plugin(this);
            } catch (e) {
                debug("Error loading " + name + ": " + e.message + "\n" + e.stack);
                reject(e);
            }

            // Register packet handlers
            for (let packetType of handler.Metadata.incomingCapabilities) {
                if (!this._handlers.has(packetType)) {
                    this._handlers.set(packetType, plugin);
                }
            }

            // Register plugin
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

            try {
                // Unregister handlers
                let handler = imports.service.plugins[name];

                for (let packetType of handler.Metadata.incomingCapabilities) {
                    this._handlers.delete(packetType);
                }

                // Unregister plugin
                this._plugins.get(name).destroy();
                this._plugins.delete(name);
            } catch (e) {
                reject(e);
            }

            resolve([name, true]);
        });
    },

    _unloadPlugins: function () {
        let promises = this.plugins.map(name => this._unloadPlugin(name));
        return Promise.all(promises.map(p => p.catch(() => undefined)));
    },

    openSettings: function () {
        this.service.openSettings(this._dbus.get_object_path());
    },

    destroy: function () {
        this.emit("destroy");

        Gio.DBus.session.unexport_action_group(this._actionsId);
        Gio.DBus.session.unexport_menu_model(this._menuId);

        let path = this._dbus.get_object_path();

        if (this.connected) {
            this.connect("notify::connected", () => {
                if (!this.connected) {
                    this._dbus_object.remove_interface(this._dbus);
                    this.service.objectManager.unexport(path);
                    GObject.signal_handlers_destroy(this);
                }
            });
            this._channel.close();
        } else {
            this._dbus_object.remove_interface(this._dbus);
            this.service.objectManager.unexport(path);
            GObject.signal_handlers_destroy(this);
        }
    }
});

