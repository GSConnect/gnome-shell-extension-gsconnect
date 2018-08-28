'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Core = imports.service.core;
const DBus = imports.service.components.dbus;
const Bluetooth = imports.service.bluetooth;

const UUID = 'org.gnome.Shell.Extensions.GSConnect.Device';
const INTERFACE_INFO = gsconnect.dbusinfo.lookup_interface(UUID);


/**
 * Base class for plugin actions
 */
var Action = GObject.registerClass({
    GTypeName: 'GSConnectDeviceAction'
}, class Action extends Gio.SimpleAction {

    _init(params) {
        super._init({
            name: params.name,
            parameter_type: params.parameter_type
        });

        this.label = params.label;
        this.icon_name = params.icon_name;
        this.icon = new Gio.ThemedIcon({ name: params.icon_name });
        this.incoming = params.incoming;
        this.outgoing = params.outgoing;
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
var Device = GObject.registerClass({
    GTypeName: 'GSConnectDevice',
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'deviceConnected',
            'Whether the device is connected',
            GObject.ParamFlags.READABLE,
            false
        ),
        'encryption-info': GObject.ParamSpec.string(
            'encryption-info',
            'Encryption Info',
            'A formatted string with the local and remote fingerprints',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'errors': GObject.param_spec_variant(
            'errors',
            'Device Errors',
            'A list of device errors',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'IconName',
            'Icon name representing the service device',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'deviceId',
            'The device id/hostname',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'deviceName',
            'The device name',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'paired': GObject.ParamSpec.boolean(
            'paired',
            'devicePaired',
            'Whether the device is paired',
            GObject.ParamFlags.READABLE,
            false
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'deviceType',
            'The device type',
            GObject.ParamFlags.READABLE,
            'unknown'
        )
    }
}, class Device extends Gio.SimpleActionGroup {

    _init(identity) {
        super._init();

        this.service = Gio.Application.get_default();
        this._channel = null;
        this._connected = false;

        // GLib.Source timeout id's for pairing requests
        this._incomingPairRequest = 0;
        this._outgoingPairRequest = 0;

        // Maps of name->plugin, packet->plugin, name->Error
        this._plugins = new Map();
        this._handlers = new Map();
        this._errors = new Map();
        this._transfers = new Map();

        // We at least need the device Id for GSettings and the DBus interface
        let deviceId = identity.body.deviceId;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(UUID, true),
            path: `/org/gnome/shell/extensions/gsconnect/device/${deviceId}/`
        });

        // TODO: Backwards compatibility <= v12; remove after a few releases
        if (this.settings.get_string('certificate-pem') !== '') {
            this.settings.set_boolean('paired', true);
        }

        // Parse identity if initialized with a proper packet
        if (identity.id !== undefined) {
            this._handleIdentity(identity);
        }

        // Export an object path for the device
        this._dbus_object = new Gio.DBusObjectSkeleton({
            g_object_path: this.object_path
        });
        this.service.objectManager.export(this._dbus_object);

        // Export the Device interface
        this._dbus = new DBus.Interface({
            g_instance: this,
            g_interface_info: INTERFACE_INFO
        });
        this._dbus_object.add_interface(this._dbus);

        // GActions/GMenu
        this._actionsId = Gio.DBus.session.export_action_group(
            this.object_path,
            this
        );

        this.menu = new Gio.Menu();
        this._menuId = Gio.DBus.session.export_menu_model(
            this.object_path,
            this.menu
        );

        // Register default actions and load plugins
        this._registerActions();
        this._loadPlugins();
    }

    /** Device Properties */
    get connected () {
        return this._connected;
    }

    get connection_type() {
        if (this._channel !== null) {
            return this._channel.type;
        }

        return this.settings.get_string('last-connection');
    }

    get encryption_info() {
        let fingerprint = _('Not available');

        if (this.connection_type === 'bluetooth') {
            // TRANSLATORS: Bluetooth address for remote device
            return _('Bluetooth device at %s').format(
                this.settings.get_string('bluetooth-host')
            );
        } else if (this.connected) {
            fingerprint = this._channel.certificate.fingerprint();
        } else if (this.paired) {
            fingerprint = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string('certificate-pem'),
                -1
            ).fingerprint();
        }

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
        return _('%s Fingerprint:\n%s\n\nLocal Fingerprint:\n%s').format(
            this.name,
            fingerprint,
            this.service.fingerprint
        );
    }

    get errors() {
        return this._errors;
    }

    get id() {
        return this.settings.get_string('id');
    }

    get name() {
        return this.settings.get_string('name');
    }

    get paired() {
        return this.settings.get_boolean('paired');
    }

    get supported_plugins() {
        return this.settings.get_strv('supported-plugins');
    }

    get allowed_plugins() {
        let disabled = this.settings.get_strv('disabled-plugins');

        return this.supported_plugins.filter(name => {
            return !disabled.includes(name);
        });
    }

    get icon_name() {
        switch (this.type) {
            case 'phone':
                return 'smartphone';
            case 'tablet':
                return 'tablet';
            default:
                return 'computer';
        }
    }

    get type() {
        return this.settings.get_string('type');
    }

    get display_type() {
        switch (this.type) {
            case 'laptop':
                return _('Laptop');
            case 'phone':
                return _('Smartphone');
            case 'tablet':
                return _('Tablet');
            default:
                return _('Desktop');
        }
    }

    get object_path() {
        return `${gsconnect.app_path}/Device/${this.id.replace(/\W+/g, '_')}`;
    }

    _handleIdentity(packet) {
        this.settings.set_string('id', packet.body.deviceId);
        this.settings.set_string('name', packet.body.deviceName);
        this.settings.set_string('type', packet.body.deviceType);

        if (packet.body.hasOwnProperty('bluetoothHost')) {
            this.settings.set_string('bluetooth-host', packet.body.bluetoothHost);
            this.settings.set_string('bluetooth-path', packet.body.bluetoothPath);
            this.settings.set_string('last-connection', 'bluetooth');
        } else if (packet.body.hasOwnProperty('tcpHost')) {
            this.settings.set_string('tcp-host', packet.body.tcpHost);
            this.settings.set_uint('tcp-port', packet.body.tcpPort);
            this.settings.set_string('last-connection', 'tcp');
        }

        this.settings.set_strv(
            'incoming-capabilities',
            packet.body.incomingCapabilities.sort()
        );

        this.settings.set_strv(
            'outgoing-capabilities',
            packet.body.outgoingCapabilities.sort()
        );

        let supported = [];

        for (let name in imports.service.plugins) {
            let meta = imports.service.plugins[name].Metadata;

            if (!meta) continue;

            // If we can handle packets it sends...
            if (meta.incomingCapabilities.some(t => packet.body.outgoingCapabilities.includes(t))) {
                supported.push(name);
            // ...or we send packets it can handle
            } else if (meta.outgoingCapabilities.some(t => packet.body.incomingCapabilities.includes(t))) {
                supported.push(name);
            }
        }

        this.settings.set_strv('supported-plugins', supported.sort());
    }

    /**
     * Request a connection from the device
     */
    activate() {
        let lastConnection = this.settings.get_string('last-connection');

        // If a channel is currently open...
        if (this._channel !== null) {
            // Bail if it's the same type as requested
		    if (this.connection_type === lastConnection) {
			    debug(`${this.name}: ${lastConnection} connection already active`);
			    return;
			}

		    // Otherwise disconnect it first
		    // TODO: let the channel service do it and just reload plugins
		    this._channel.close();
		}

		debug(`${this.name}: requesting ${lastConnection} connection`);

		if (lastConnection === 'bluetooth') {
		    this.service.broadcast(this.settings.get_string('bluetooth-path'));
		} else {
		    let tcpAddress = Gio.InetSocketAddress.new_from_string(
                this.settings.get_string('tcp-host'),
                this.settings.get_uint('tcp-port')
            );

		    this.service.broadcast(tcpAddress);
	    }
    }

    /**
     * Receive a packet from the attached channel and route it to its handler
     *
     * @param {Core.Packet} packet - The incoming packet object
     */
    receivePacket(packet) {
        try {
            let handler = this._handlers.get(packet.type);

            switch (true) {
                // We handle pair requests
                case (packet.type === 'kdeconnect.pair'):
                    this._handlePair(packet);
                    break;

                // The device must think we're paired; inform it we are not
                case !this.paired:
                    this.unpair();
                    break;

                // This is a supported packet
                case (handler !== undefined):
                    handler.handlePacket(packet);
                    break;

                // This is an unsupported packet or disabled plugin
                default:
                    throw new Error(`Unsupported packet type (${packet.type})`);
            }
        } catch (e) {
            logError(e, this.name);
        }
    }

    /**
     * Send a packet to the device
     * @param {Object} packet - An object of packet data...
     * @param {Gio.Stream} payload - A payload stream // TODO
     */
    sendPacket(packet, payload=null) {
        try {
            if (this.connected && (this.paired || packet.type === 'kdeconnect.pair')) {
                this._channel.send(packet);
            }
        } catch (e) {
            logError(e, this.name);
        }
    }

    /** Channel Callbacks */
    _onConnected(channel) {
        log(`Connected to ${this.name} (${this.id})`);

        this.settings.set_string('last-connection', channel.type);

        this._connected = true;
        this.notify('connected');

        this._plugins.forEach(plugin => plugin.connected());
    }

    _onDisconnected(channel) {
        log(`Disconnected from ${this.name} (${this.id})`);

        GObject.signal_handlers_destroy(channel);
        this._channel = null;

        this._connected = false;
        this.notify('connected');

        this._plugins.forEach(plugin => plugin.disconnected());
    }

    /**
     * Actions
     */
    _registerActions() {
        // Stock device actions
        let activate = new Action({
            name: 'activate',
            parameter_type: null,
            label: _('Reconnect'),
            icon_name: 'view-refresh-symbolic'
        });
        activate.connect('activate', this.activate.bind(this));
        this.add_action(activate);

        let openSettings = new Action({
            name: 'openSettings',
            parameter_type: null,
            label: _('Open Settings'),
            icon_name: 'preferences-system-symbolic'
        });
        openSettings.connect('activate', this.openSettings.bind(this));
        this.add_action(openSettings);

        let acceptPair = new Action({
            name: 'pair',
            parameter_type: null,
            label: _('Pair'),
            icon_name: 'channel-secure-symbolic'
        });
        acceptPair.connect('activate', this.pair.bind(this));
        this.add_action(acceptPair);

        let rejectPair = new Action({
            name: 'unpair',
            parameter_type: null,
            label: _('Unpair'),
            icon_name: 'channel-insecure-symbolic'
        });
        rejectPair.connect('activate', this.unpair.bind(this));
        this.add_action(rejectPair);

        // Some general utility actions
        let cancelTransfer = new Gio.SimpleAction({
            name: 'cancelTransfer',
            parameter_type: new GLib.VariantType('s')
        });
        cancelTransfer.connect('activate', this.cancelTransfer.bind(this));
        this.add_action(cancelTransfer);

        let openPath = new Gio.SimpleAction({
            name: 'openPath',
            parameter_type: new GLib.VariantType('s')
        });
        openPath.connect('activate', this.openPath.bind(this));
        this.add_action(openPath);
    }

    cancelTransfer(action, parameter) {
        let uuid = parameter.unpack();
        let transfer = this._transfers.get(uuid);

        if (transfer !== undefined) {
            this._transfers.delete(uuid);
            transfer.cancel();
        }
    }

    openPath(action, parameter) {
        let path = parameter.unpack();
        path = path.startsWith('file://') ? path : `file://${path}`;

        Gio.AppInfo.launch_default_for_uri_async(path, null, null, (src, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                logError(e);
            }
        });
    }

    /**
     * Hide a notification, device analog for GApplication.withdraw_notification()
     *
     * @param {string} id - Id for the notification to withdraw
     */
    hideNotification(id) {
        this.service.withdraw_notification(`${this.id}|${id}`);
    }

    /**
     * Show a notification, device analog for GApplication.send_notification()
     */
    showNotification(params) {
        params = Object.assign({
            id: GLib.DateTime.new_now_local().to_unix(),
            title: this.name,
            body: '',
            icon: new Gio.ThemedIcon({ name: `${this.icon_name}-symbolic` }),
            priority: Gio.NotificationPriority.NORMAL,
            action: null,
            buttons: []
        }, params);

        let notif = new Gio.Notification();
        notif.set_title(params.title);
        notif.set_body(params.body);
        notif.set_icon(params.icon);
        notif.set_priority(params.priority);

        // Default Action
        if (params.action) {
            let hasParameter = (params.action.parameter !== null);

            if (!hasParameter) {
                params.action.parameter = new GLib.Variant('s', '');
            }

            notif.set_default_action_and_target(
                'app.deviceAction',
                new GLib.Variant('(ssbv)', [
                    this.id,
                    params.action.name,
                    hasParameter,
                    params.action.parameter
                ])
            );
        }

        // Buttons
        for (let button of params.buttons) {
            let hasParameter = (button.parameter !== null);

            if (!hasParameter) {
                button.parameter = new GLib.Variant('s', '');
            }

            notif.add_button_with_target(
                button.label,
                'app.deviceAction',
                new GLib.Variant('(ssbv)', [
                    this.id,
                    button.action,
                    hasParameter,
                    button.parameter
                ])
            );
        }

        this.service.send_notification(`${this.id}|${params.id}`, notif);
    }

    /**
     * Pair request handler
     *
     * @param {Core.Packet} packet - A complete kdeconnect.pair packet
     */
    _handlePair(packet) {
        // A pair has been requested/confirmed
        if (packet.body.pair) {
            // The device is accepting our request
            if (this._outgoingPairRequest) {
                log(`Pair accepted by ${this.name}`);

                this._setPaired(true);
                this._loadPlugins();
            // The device thinks we're unpaired
            } else if (this.paired) {
                this._setPaired(true);
                this.pair();
                this._loadPlugins();
            // The device is requesting pairing
            } else {
                log(`Pair request from ${this.name}`);
                this._notifyPairRequest();
            }
        // Device is requesting unpairing/rejecting our request
        } else {
            log(`Pair rejected by ${this.name}`);

            this._setPaired(false);
            this._unloadPlugins();
        }
    }

    /**
     * Notify the user of an incoming pair request and set a 30s timeout
     */
    _notifyPairRequest() {
        this.showNotification({
            id: 'pair-request',
            // TRANSLATORS: eg. Pair Request from Google Pixel
            title: _('Pair Request from %s').format(this.name),
            body: this.encryption_info,
            icon: new Gio.ThemedIcon({ name: 'channel-insecure-symbolic' }),
            priority: Gio.NotificationPriority.URGENT,
            buttons: [
                {
                    action: 'unpair',
                    label: _('Reject'),
                    parameter: null
                },
                {
                    action: 'pair',
                    label: _('Accept'),
                    parameter: null
                }
            ]
        });

        // Start a 30s countdown
        this._resetPairRequest();

        this._incomingPairRequest = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            this._setPaired.bind(this, false)
        );
    }

    /**
     * Reset pair request timeouts and withdraw any notifications
     */
    _resetPairRequest() {
        if (this._incomingPairRequest) {
            this.hideNotification('pair-request');
            GLib.source_remove(this._incomingPairRequest);
            this._incomingPairRequest = 0;
        }

        if (this._outgoingPairRequest) {
            GLib.source_remove(this._outgoingPairRequest);
            this._outgoingPairRequest = 0;
        }
    }

    /**
     * Set the internal paired state of the device and emit ::notify
     *
     * @param {Boolean} bool - The paired state to set
     */
    _setPaired(bool) {
        this._resetPairRequest();

        // For TCP connections we store or reset the TLS Certificate
        if (this.connection_type === 'tcp') {
            if (bool) {
                this.settings.set_string(
                    'certificate-pem',
                    this._channel.certificate.certificate_pem
                );
            } else {
                this.settings.reset('certificate-pem');
            }
        }

        this.settings.set_boolean('paired', bool);
        this.notify('paired');
    }

    /**
     * Send or accept an incoming pair request; also exported as a GAction
     */
    pair() {
        // We're accepting an incoming pair request...
        if (this._incomingPairRequest) {
            // so set the paired state to true...
            this._setPaired(true);
            // then loop back around to send confirmation...
            this.pair();
            // ...before loading plugins
            this._loadPlugins();
            return;
        }

        // Send a pair packet
        this.sendPacket({
            id: 0,
            type: 'kdeconnect.pair',
            body: { pair: true }
        });

        // We're initiating an outgoing pair request
        if (!this.paired) {
            this._resetPairRequest();

            this._outgoingPairRequest = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                30,
                this._setPaired.bind(this, false)
            );

            log(`Pair request sent to ${this.name}`);
        }
    }

    /**
     * Unpair or reject an incoming pair request; also exported as a GAction
     */
    unpair() {
        debug(`${this.name} (${this.id})`);

        // Send the unpair packet only if we're connected
        if (this.connected) {
            this.sendPacket({
                id: 0,
                type: 'kdeconnect.pair',
                body: { pair: false }
            });
        }

        this._setPaired(false);
        this._unloadPlugins();
    }

    /**
     * Plugin Functions
     */
    get_incoming_supported(type) {
        let incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    get_outgoing_supported(type) {
        let outgoing = this.settings.get_strv('outgoing-capabilities');
        return outgoing.includes(`kdeconnect.${type}`);
    }

    get_plugin_supported(name) {
        return this.supported_plugins.includes(name);
    }

    get_plugin_allowed(name) {
        return this.allowed_plugins.includes(name);
    }

    lookup_plugin(name) {
        return this._plugins.get(name) || null;
    }

    async loadPlugin(name) {
        debug(`loading '${name}' plugin`, this.name);

        let handler, plugin;

        try {
            if (this.paired && !this._plugins.has(name)) {
                // Instantiate the handler
                handler = imports.service.plugins[name];
                plugin = new handler.Plugin(this);

                // Register packet handlers
                for (let packetType of handler.Metadata.incomingCapabilities) {
                    if (!this._handlers.has(packetType)) {
                        this._handlers.set(packetType, plugin);
                    }
                }

                // Register plugin
                this._plugins.set(name, plugin);
                this.errors.delete(name);

                // Run the connected() handler
                if (this.connected) {
                    plugin.connected();
                }
            }
        } catch (e) {
            logWarning(`loading ${name}: ${e.message}`, this.name);
            this.errors.set(name, e);
        } finally {
            this.notify('errors');
        }
    }

    async _loadPlugins() {
        this.allowed_plugins.map(name => this.loadPlugin(name));
    }

    async unloadPlugin(name) {
        debug(`unloading '${name}' plugin`, this.name);

        try {
            // Unregister packet handlers
            let handler = imports.service.plugins[name];

            for (let packetType of handler.Metadata.incomingCapabilities) {
                this._handlers.delete(packetType);
            }

            // Unregister plugin
            this._plugins.get(name).destroy();
            this._plugins.delete(name);
        } catch (e) {
            logWarning(`unloading ${name}: ${e.message}`, this.name);
        }
    }

    async _unloadPlugins() {
        this._plugins.forEach((plugin, name) => this.unloadPlugin(name));
    }

    async reloadPlugin(name) {
        await this.unloadPlugin(name);
        await this.loadPlugin(name);
    }

    async reloadPlugins() {
        this.allowed_plugins.map(name => this.reloadPlugin(name));
    }

    openSettings() {
        this.service._preferencesAction(this.id);
    }

    destroy() {
        // Close the channel if still connected
        if (this.connected) {
            this._channel.close();
        }

        // Synchronously destroy plugins
        this._plugins.forEach(plugin => plugin.destroy());

        // Unexport the GActions and GMenu
        Gio.DBus.session.unexport_action_group(this._actionsId);
        Gio.DBus.session.unexport_menu_model(this._menuId);

        // Unexport the Device interface
        this._dbus.flush();
        this._dbus_object.remove_interface(this._dbus);
        this._dbus_object.flush();
        this.service.objectManager.unexport(this._dbus_object.g_object_path);

        // Try to avoid any cyclic references from signal handlers
        GObject.signal_handlers_destroy(this);
        GObject.signal_handlers_destroy(this.settings);
    }
});

