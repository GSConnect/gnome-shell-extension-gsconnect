'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Bluetooth = imports.service.protocol.bluetooth;
const Lan = imports.service.protocol.lan;
const DBus = imports.service.components.dbus;

const UUID = 'org.gnome.Shell.Extensions.GSConnect.Device';
const INTERFACE_INFO = gsconnect.dbusinfo.lookup_interface(UUID);


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
            'Connected',
            'Whether the device is connected',
            GObject.ParamFlags.READABLE,
            null
        ),
        'contacts': GObject.ParamSpec.object(
            'contacts',
            'Contacts',
            'The contacts store for this device',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'encryption-info': GObject.ParamSpec.string(
            'encryption-info',
            'Encryption Info',
            'A formatted string with the local and remote fingerprints',
            GObject.ParamFlags.READABLE,
            null
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'Icon Name',
            'Icon name representing the device',
            GObject.ParamFlags.READABLE,
            null
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'deviceId',
            'The device hostname or other unique id',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'deviceName',
            'The device name',
            GObject.ParamFlags.READABLE,
            null
        ),
        'paired': GObject.ParamSpec.boolean(
            'paired',
            'Paired',
            'Whether the device is paired',
            GObject.ParamFlags.READABLE,
            null
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'deviceType',
            'The device type',
            GObject.ParamFlags.READABLE,
            null
        )
    }
}, class Device extends Gio.SimpleActionGroup {

    _init(identity) {
        super._init();

        this._channel = null;
        this._connected = false;

        // GLib.Source timeout id's for pairing requests
        this._incomingPairRequest = 0;
        this._outgoingPairRequest = 0;

        // Maps of name->Plugin, packet->Plugin, uuid->Transfer
        this._plugins = new Map();
        this._handlers = new Map();
        this._transfers = new Map();

        // We at least need the device Id for GSettings and the DBus interface
        let deviceId = identity.body.deviceId;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(UUID, true),
            path: '/org/gnome/shell/extensions/gsconnect/device/' + deviceId + '/'
        });

        // Watch for plugins changes
        this._disabledPluginsId = this.settings.connect(
            'changed::disabled-plugins',
            this._onDisabledPlugins.bind(this)
        );

        // Parse identity if initialized with a proper packet
        if (identity.id !== undefined) {
            this._handleIdentity(identity);
        }

        // Export an object path for the device
        this._dbus_object = new Gio.DBusObjectSkeleton({
            g_object_path: this.object_path
        });
        this.service.objectManager.export(this._dbus_object);

        // Export GActions
        this._actionsId = Gio.DBus.session.export_action_group(
            this.object_path,
            this
        );
        this._registerActions();

        // Export GMenu
        this.menu = new Gio.Menu();
        this._menuId = Gio.DBus.session.export_menu_model(
            this.object_path,
            this.menu
        );

        // Export the Device interface
        this._dbus = new DBus.Interface({
            g_instance: this,
            g_interface_info: INTERFACE_INFO
        });
        this._dbus_object.add_interface(this._dbus);
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

    get contacts() {
        let contacts = this.lookup_plugin('contacts');

        if (contacts && contacts.settings.get_boolean('contacts-source')) {
            return contacts._store;
        } else {
            return this.service.contacts;
        }
    }

    // TODO: should we just store the fingerprint instead of the pem?
    get encryption_info() {
        let fingerprint = _('Not available');

        // Bluetooth connections have no certificate so we use the host address
        if (this.connection_type === 'bluetooth') {
            // TRANSLATORS: Bluetooth address for remote device
            return _('Bluetooth device at %s').format(
                this.settings.get_string('bluetooth-host')
            );

        // If the device is connected use the certificate from the connection
        } else if (this.connected) {
            fingerprint = this._channel.certificate.fingerprint();

        // Otherwise pull it out of the settings
        } else if (this.paired) {
            fingerprint = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string('certificate-pem'),
                -1
            ).fingerprint();
        }

        // TRANSLATORS: Label for TLS Certificate fingerprint
        //
        // Example:
        //
        // Google Pixel Fingerprint:
        // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
        return _('%s Fingerprint:').format(this.name) + '\n' +
            fingerprint + '\n\n' +
            _('%s Fingerprint:').format(this.service.name) + '\n' +
            this.service.fingerprint;
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
        let supported = this.settings.get_strv('supported-plugins');

        // Preempt clipboard and mousepad plugins on Wayland
        if (_WAYLAND) {
            supported = supported.filter(name => {
                return (name !== 'clipboard' && name !== 'mousepad');
            });
        }

        return supported;
    }

    get allowed_plugins() {
        let disabled = this.settings.get_strv('disabled-plugins');
        return this.supported_plugins.filter(name => !disabled.includes(name));
    }

    get icon_name() {
        switch (this.type) {
            case 'laptop':
                return 'laptop';
            case 'phone':
                return 'smartphone';
            case 'tablet':
                return 'tablet';
            default:
                return 'computer';
        }
    }

    get service() {
        return Gio.Application.get_default();
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
     * This is invoked by Core.Channel.attach() which also sets this._channel
     */
    _setConnected() {
        debug(`Connected to ${this.name} (${this.id})`);

        this.settings.set_string('last-connection', this._channel.type);

        this._connected = true;
        this.notify('connected');

        this._plugins.forEach(async (plugin) => plugin.connected());
    }

    /**
     * This is the callback for the Core.Channel's cancellable object
     */
    _setDisconnected() {
        debug(`Disconnected from ${this.name} (${this.id})`);

        this._channel = null;
        this._connected = false;
        this.notify('connected');

        this._plugins.forEach(async (plugin) => plugin.disconnected());
    }

    /**
     * Request a connection from the device
     */
    activate() {
        let lastConnection = this.settings.get_string('last-connection');

        // If the same channel type is currently open bail...
        if (this._channel !== null && this.connection_type === lastConnection) {
            debug(`${this.name}: ${lastConnection} connection already active`);
            return;

        } else if (lastConnection === 'bluetooth') {
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
            warning(e, this.name);
        }
    }

    /**
     * Send a packet to the device
     * @param {Object} packet - An object of packet data...
     * @param {Gio.Stream} payload - A payload stream // TODO
     */
    sendPacket(packet, payload = null) {
        try {
            if (this.connected && (this.paired || packet.type === 'kdeconnect.pair')) {
                this._channel.send(packet);
            }
        } catch (e) {
            logError(e, this.name);
        }
    }

    /**
     * Actions
     */
    _registerActions() {
        // Stock device actions
        let activate = new Gio.SimpleAction({
            name: 'activate',
            state: new GLib.Variant('(ss)', [_('Reconnect'), 'view-refresh-symbolic']),
        });
        activate.connect('activate', this.activate.bind(this));
        this.add_action(activate);

        let openSettings = new Gio.SimpleAction({
            name: 'openSettings',
            state: new GLib.Variant('(ss)', [_('Settings'), 'preferences-system-symbolic'])
        });
        openSettings.connect('activate', this.openSettings.bind(this));
        this.add_action(openSettings);

        // Pairing notification actions
        let acceptPair = new Gio.SimpleAction({name: 'pair'});
        acceptPair.connect('activate', this.pair.bind(this));
        this.add_action(acceptPair);

        let rejectPair = new Gio.SimpleAction({name: 'unpair'});
        rejectPair.connect('activate', this.unpair.bind(this));
        this.add_action(rejectPair);

        // Transfer notification actions
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
        openPath.connect('activate', this.openPath);
        this.add_action(openPath);
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
            id: Date.now(),
            title: this.name,
            body: '',
            icon: new Gio.ThemedIcon({name: this.icon_name}),
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
                'app.device',
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
                'app.device',
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
     * File Transfers
     */
    cancelTransfer(action, parameter) {
        let uuid = parameter.unpack();
        let transfer = this._transfers.get(uuid);

        if (transfer !== undefined) {
            this._transfers.delete(uuid);
            transfer.close();
        }
    }

    createTransfer(params) {
        params.device = this;

        switch (this.connection_type) {
            case 'tcp':
                return new Lan.Transfer(params);

            case 'bluetooth':
                return new Bluetooth.Transfer(params);

            // Fallback to returning a mock transfer that always appears to fail
            default:
                return {
                    uuid: 'mock-transfer',
                    download: () => false,
                    upload: () => false
                };
        }
    }

    openPath(action, parameter) {
        let path = parameter.unpack();

        // Normalize paths to URIs, assuming local file
        path = path.includes('://') ? path : `file://${path}`;
        open_uri(path);
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
                debug(`Pair accepted by ${this.name}`);

                this._setPaired(true);
                this.loadPlugins();
            // The device thinks we're unpaired
            } else if (this.paired) {
                this._setPaired(true);
                this.pair();
                this.loadPlugins();
            // The device is requesting pairing
            } else {
                debug(`Pair request from ${this.name}`);
                this._notifyPairRequest();
            }
        // Device is requesting unpairing/rejecting our request
        } else {
            debug(`Pair rejected by ${this.name}`);

            this._setPaired(false);
            this.unloadPlugins();
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
            icon: new Gio.ThemedIcon({name: 'channel-insecure-symbolic'}),
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
            this.loadPlugins();
            return;
        }

        // Send a pair packet
        this.sendPacket({
            id: 0,
            type: 'kdeconnect.pair',
            body: {pair: true}
        });

        // We're initiating an outgoing pair request
        if (!this.paired) {
            this._resetPairRequest();

            this._outgoingPairRequest = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                30,
                this._setPaired.bind(this, false)
            );

            debug(`Pair request sent to ${this.name}`);
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
                body: {pair: false}
            });
        }

        this._setPaired(false);
        this.unloadPlugins();
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

    _onDisabledPlugins(settings) {
        let disabled = this.settings.get_strv('disabled-plugins');
        disabled.map(name => this.unloadPlugin(name));
        this.allowed_plugins.map(name => this.loadPlugin(name));

        // Make sure we're change the contacts store if the plugin was disabled
        if (!this.get_plugin_allowed('contacts')) {
            this.notify('contacts');
        }
    }

    loadPlugin(name) {
        let handler, plugin;

        try {
            if (this.paired && !this._plugins.has(name)) {
                debug(`loading '${name}' plugin`, this.name);

                // Instantiate the handler
                handler = imports.service.plugins[name];
                plugin = new handler.Plugin(this);

                // Register packet handlers
                for (let packetType of handler.Metadata.incomingCapabilities) {
                    this._handlers.set(packetType, plugin);
                }

                // Register plugin
                this._plugins.set(name, plugin);

                // Run the connected()/disconnected() handler
                this.connected ? plugin.connected() : plugin.disconnected();
            }
        } catch (e) {
            e.name = (e.name === 'Error') ? 'PluginError' : e.name;
            e.plugin = handler.Metadata.label;
            this.service.notify_error(e);
        }
    }

    async loadPlugins() {
        for (let name of this.allowed_plugins) {
            await this.loadPlugin(name);
        }
    }

    unloadPlugin(name) {
        let handler, plugin;

        try {
            if (this._plugins.has(name)) {
                debug(`unloading '${name}' plugin`, this.name);

                // Unregister packet handlers
                handler = imports.service.plugins[name];
                plugin = this._plugins.get(name);

                for (let type of handler.Metadata.incomingCapabilities) {
                    this._handlers.delete(type);
                }

                // Unregister plugin
                this._plugins.delete(name);
                plugin.destroy();
            }
        } catch (e) {
            logError(e, `${this.name}: unloading ${name}`);
        }
    }

    async unloadPlugins() {
        for (let name of this._plugins.keys()) {
            await this.unloadPlugin(name);
        }
    }

    openSettings() {
        this.service._settings(this.id);
    }

    destroy() {
        //
        this.settings.disconnect(this._disabledPluginsId);

        // Close the channel if still connected
        if (this._channel !== null) {
            this._channel.close();
        }

        // Synchronously destroy plugins
        this._plugins.forEach(plugin => plugin.destroy());

        // Unexport GActions and GMenu
        Gio.DBus.session.unexport_action_group(this._actionsId);
        Gio.DBus.session.unexport_menu_model(this._menuId);

        // Unexport the Device interface and object
        this._dbus.flush();
        this._dbus_object.remove_interface(this._dbus);
        this._dbus_object.flush();
        this.service.objectManager.unexport(this._dbus_object.g_object_path);
    }
});

