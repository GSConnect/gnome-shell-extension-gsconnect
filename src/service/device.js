'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Core = imports.service.core;
const DBus = imports.modules.dbus;
const Bluetooth = imports.service.bluetooth;


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

        this.summary = params.summary;
        this.description = params.description;
        this.icon_name = params.icon_name;
        this.incoming = params.incoming;
        this.outgoing = params.outgoing;
        this.allow = params.allow;
    }
});


var Menu = GObject.registerClass({
    GTypeName: 'GSConnectDeviceMenu'
}, class Menu extends Gio.Menu {

    _init() {
        super._init();
    }

    /**
     * Return the index of an item in the menu by attribute and value
     * @param {String} name - The attribute name (eg. 'label', 'action')
     * @param {*} - The value of the attribute
     * @return {Number} - The index of the item or %-1 if not found
     */
    _get(name, value) {
        let len = this.get_n_items();

        for (let i = 0; i < len; i++) {
            try {
                let item = this.get_item_attribute_value(i, name, null).unpack();

                if (item === value) {
                    return i;
                }
            } catch (e) {
                continue;
            }
        }

        return -1;
    }

    /**
     * Remove an item from the menu by attribute and value
     * @param {String} name - The attribute name (eg. 'label', 'action')
     * @param {*} - The value of the attribute
     * @return {Number} - The index of the removed item or %-1 if not found
     */
    _remove(name, value) {
        let index = this._get(name, value);

        if (index > -1) {
            this.remove(index);
        }

        return index;
    }

    /**
     * Return the index of the first GMenuItem found with @action
     * @param {String} name - The action name (without scope)
     * @return {Number} - The index of the action
     */
    get_action(name) {
        return this._get('action', `device.${name}`);
    }

    /**
     * Add a GMenuItem for a plugin action
     * @param {String} name - The action name (without scope)
     * @param {Object} action - The action meta
     * @return {Number} - The index of the added item
     */
    add_action(action, index=-1) {
        let item = new Gio.MenuItem();
        item.set_label(action.summary);
        item.set_icon(
            new Gio.ThemedIcon({
                name: action.icon_name || 'application-x-executable-symbolic'
            })
        );
        item.set_detailed_action(`device.${action.name}`);

        if (index === -1) {
            this.append_item(item);
        } else {
            this.insert_item(index, item);
        }

        return this.get_n_items();
    }

    /**
     * Remove a GMenuItem by action name, with or without group prefix
     * @param {String} name - Action name of the item to remove
     * @return {Number} - The index of the removed item or -1 if not found
     */
    remove_action(name) {
        let index = this._remove('action', name);

        if (index < 0) {
            return this._remove('action', `device.${name}`);
        }

        return index;
    }

    /**
     * Replace the item with the action name @name with @item
     * @param {String} name - Action name of the item to remove
     * @param {Gio.MenuItem} item - The replacement menu item
     * @return {Number} - The index of the replaced item or -1 if not found
     */
    replace_action(name, item) {
        let index = this.remove_action(name);

        if (index > -1) {
            this.insert_item(index, item);
        }

        return index;
    }

    /**
     * Remove a GMenuItem by label
     * @param {String} name - Label of the item to remove
     * @return {Number} - The index of the removed item or -1 if not found
     */
    remove_named(name) {
        return this._remove('label', name);
    }

    /**
     * Replace a GMenuItem by label with another. If @name is not found @item
     * will be appended to the end of the menu.
     * @param {String} name - Label of the item to replace
     * @param {Gio.MenuItem} item - Menu item to replace the removed item
     */
    replace_named(name, item) {
        let index = this.remove_named(name);

        if (index > -1) {
            this.insert_item(index, item);
        } else {
            this.append_item(item);
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
        'fingerprint': GObject.ParamSpec.string(
            'fingerprint',
            'deviceFingerprint',
            'SHA1 fingerprint for the device certificate',
            GObject.ParamFlags.READABLE,
            ''
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
        'plugins': GObject.param_spec_variant(
            'plugins',
            'PluginsList',
            'A list of enabled plugins',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        ),
        'symbolic-icon-name': GObject.ParamSpec.string(
            'symbolic-icon-name',
            'ServiceIconName',
            'Symbolic icon name representing the service device',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'deviceType',
            'The device type',
            GObject.ParamFlags.READABLE,
            'unknown'
        ),
        'display-type': GObject.ParamSpec.string(
            'display-type',
            'Display Type',
            'The device type, formatted for display',
            GObject.ParamFlags.READABLE,
            'Desktop'
        )
    },
    Signals: {
        'event': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_STRING, GObject.TYPE_VARIANT ]
        },
        'destroy': {
            flags: GObject.SignalFlags.NO_HOOKS
        }
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

        // Maps of pluginName->pluginObject & packetType->pluginObject
        this._plugins = new Map();
        this._handlers = new Map();

        // We at least need the device Id for GSettings and the DBus interface
        let deviceId = identity.body.deviceId;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${deviceId}/`
        });

        // Parse identity if initialized with a proper packet
        if (identity.type) {
            this._handleIdentity(identity);
        }

        // Export an object path for the device
        this._dbus_object = new Gio.DBusObjectSkeleton({
            g_object_path: `${gsconnect.app_path}/Device/${deviceId.replace(/\W+/g, '_')}`
        });
        this.service.objectManager.export(this._dbus_object);

        // Export org.gnome.Shell.Extensions.GSConnect.Device interface
        this._dbus = new DBus.Interface({
            g_instance: this,
            g_interface_info: gsconnect.dbusinfo.lookup_interface(
                'org.gnome.Shell.Extensions.GSConnect.Device'
            )
        });
        this._dbus_object.add_interface(this._dbus);

        // GActions/GMenu
        this._actionsId = Gio.DBus.session.export_action_group(
            this._dbus.get_object_path(),
            this
        );

        this.menu = new Menu();
        this._menuId = this._dbus.get_connection().export_menu_model(
            this._dbus.get_object_path(),
            this.menu
        );

        this._registerActions();
    }

    /** Device Properties */
    get connected () { return this._connected && this._channel; }
    get fingerprint () {
        // TODO: this isn't really useful, and kind of misleading since it looks
        // like a fingerprint when it's actually a MAC Address
        if (this.connected && this._channel.type === 'bluetooth') {
            return this._channel.identity.body.bluetoothHost;
        } else if (this.connected && this._channel.type === 'tcp') {
            return this._channel.certificate.fingerprint();
        } else if (this.paired) {
            let cert = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string('certificate-pem'),
                -1
            );
            return cert.fingerprint();
        }

        return '';
    }

    get id() { return this.settings.get_string('id'); }
    get name() { return this.settings.get_string('name'); }

    // TODO: This will have to be revisited when upstream makes a decision on
    //       how pairing will work with bluetooth connections
    get paired() {
        return (this.settings.get_string('certificate-pem'));
    }
    get plugins() { return Array.from(this._plugins.keys()) || []; }

    get incomingCapabilities() {
        return this.settings.get_strv('incoming-capabilities');
    }
    get outgoingCapabilities() {
        return this.settings.get_strv('outgoing-capabilities');
    }

    get icon_name() {
        let icon = (this.type === 'desktop') ? 'computer' : this.type;
        return (icon === 'phone') ? 'smartphone' : icon;
    }
    get symbolic_icon_name() {
        let icon = (this.type === 'phone') ? 'smartphone' : this.type;
        icon = (this.type === 'unknown') ? 'desktop' : icon;

        if (this.paired && this.connected) {
            return icon + 'connected';
        } else if (this.paired) {
            return icon + 'trusted';
        } else {
            return icon + 'disconnected';
        }
    }
    get type() { return this.settings.get_string('type'); }
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
        return this._dbus.get_object_path();
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
    }

    /**
     * Open a new Channel and try to connect to the device
     */
    activate() {
        debug(`${this.name} (${this.id})`);

        // Already connected
		if (this._channel !== null) {
			debug(`${this.name} (${this.id}) already active`);
			return;
		}

		// FIXME: There's no contingency for falling back to another connection
		//        type if one fails
		if (this.settings.get_string('last-connection') === 'bluetooth') {
            let bluezDevice = this.service.bluetoothService.devices.get(
		        this.settings.get_string('bluetooth-path')
		    );

		    if (bluezDevice) {
		        bluezDevice.ConnectProfile(Bluetooth.SERVICE_UUID).catch(debug);
		    }
		} else {
            // Create a new channel
            this._channel = new Core.Channel(this.id);
            this._channel.connect('connected', this._onConnected.bind(this));
            this._channel.connect('disconnected', this._onDisconnected.bind(this));
		    this._channel.connect('received', this._onReceived.bind(this));

		    let addr = new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(
                    this.settings.get_string('tcp-host')
                ),
                port: this.settings.get_uint('tcp-port')
            });

            this._channel.open(addr);
        }
    }

    /**
     * Update the device with a UDP packet or replacement Core.Channel
     */
    update(packet, channel=null) {
        debug(`${this.name} (${this.id})`);

        if (channel) {
            this._handleIdentity(channel.identity);

            // Disconnect from the current channel
            if (this._channel !== null) {
                GObject.signal_handlers_destroy(this._channel);
                this._channel.close();
            }

            // Connect to the new channel
            this._channel = channel;
            this._channel.connect('connected', this._onConnected.bind(this));
            this._channel.connect('disconnected', this._onDisconnected.bind(this));
            this._channel.connect('received', this._onReceived.bind(this));

            // Verify the certificate since it was TOFU'd by the listener
            if (!this.verify()) {
                this._channel.emit('disconnected');
            } else if (!this.connected) {
                this._channel.emit('connected');
            }
        } else {
            this._onReceived(this._channel, packet);
        }
    }

    verify() {
        log(`Authenticating ${this.name}`);

        // Consider paired bluetooth connections verified
        if (this._channel.type === 'bluetooth') {
            debug(`Allowing paired Bluetooth connection for ${this.name}`);
            return true;
        }

        let cert;

        if (this.settings.get_string('certificate-pem')) {
            cert = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string('certificate-pem'),
                -1
            );
        }

        if (cert) {
            debug(`Authenticating TLS certificate for ${this.name}`);

            if (cert.verify(null, this._channel.certificate) > 0) {
                log(`Failed to authenticate ${this.name}`);
                this._channel.close();
                return false;
            }
        }

        return true;
    }

    /**
     * Send a packet to the device
     * @param {Object} packet - An object of packet data...
     * @param {Gio.Stream} payload - A payload stream // TODO
     */
    sendPacket(packet, payload=null) {
        debug(`${this.name} (${this.id}): ${JSON.stringify(packet, null, 2)}`);

        if (this.connected && this.paired) {
            packet = new Core.Packet(packet);
            this._channel.send(packet);
        }
    }

    /** Channel Callbacks */
    _onConnected(channel) {
        log(`Connected to ${this.name} (${this.id})`);

        this.settings.set_string('last-connection', channel.type);

        this._connected = true;
        this.notify('connected');
        this.notify('symbolic-icon-name');

        // Ensure fingerprint is available right away
        this.notify('fingerprint');

        this._loadPlugins().then(values => this.notify('plugins'));
    }

    _onDisconnected(channel) {
        log(`Disconnected from ${this.name} (${this.id})`);

        this._channel = null;

        this._unloadPlugins().then(values => {
            this.notify('plugins');
            this._connected = false;
            this.notify('connected');
            this.notify('symbolic-icon-name');
        });
    }

    _onReceived(channel, packet) {
        debug(`Received ${packet.type} from ${this.name} (${this.id})`);

        if (packet.type === 'kdeconnect.identity') {
            this._handleIdentity(packet);
            this.activate();
        } else if (packet.type === 'kdeconnect.pair') {
	        this._handlePair(packet);
	    } else if (this._handlers.has(packet.type)) {
	        let handler = this._handlers.get(packet.type);
            handler.handlePacket(packet);
        } else {
            debug(`Received unsupported packet type: ${packet.type}`);
        }
    }

    /**
     * Stock device actions
     */
    _registerActions() {
        let acceptPair = new Action({
            name: 'acceptPair',
            parameter_type: null,
            summary: _('Accept Pair'),
            description: _('Accept an incoming pair request'),
            icon_name: 'channel-insecure-symbolic'
        });
        acceptPair.connect('activate', this.acceptPair.bind(this));
        this.add_action(acceptPair);

        let rejectPair = new Action({
            name: 'rejectPair',
            parameter_type: null,
            summary: _('Reject Pair'),
            description: _('Reject an incoming pair request'),
            icon_name: 'channel-insecure-symbolic'
        });
        rejectPair.connect('activate', this.rejectPair.bind(this));
        this.add_action(rejectPair);

        let viewFolder = new Action({
            name: 'viewFolder',
            parameter_type: new GLib.VariantType('s'),
            summary: _('View Folder'),
            description: _('Open a folder for viewing'),
            icon_name: 'folder-open-symbolic'
        });
        viewFolder.connect('activate', this.viewFolder.bind(this));
        this.add_action(viewFolder);
    }

    viewFolder(action, parameter) {
        let path = gsconnect.full_unpack(parameter);
        Gio.AppInfo.launch_default_for_uri(`file://${path}`, null);
    }

    /**
     * Device notifications
     */
    send_notification(id, notification) {
        this.service.send_notification(this.id + '|' + id, notification);
    }

    withdraw_notification(id) {
        this.service.withdraw_notification(this.id + '|' + id);
    }

    showNotification(params) {
        params = Object.assign({
            id: GLib.DateTime.new_now_local().to_unix(),
            title: this.name,
            body: '',
            icon: new Gio.ThemedIcon({ name: this.symbolic_icon_name }),
            priority: Gio.NotificationPriority.NORMAL,
            action: null,
            buttons: []
        }, params);

        let notif = new Gio.Notification();
        notif.set_title(params.title);
        notif.set_body(params.body);
        notif.set_icon(params.icon);
        notif.set_priority(params.priority);

        if (params.action) {
            notif.set_default_action_and_target(
                'app.deviceAction',
                new GLib.Variant('(osv)', [
                    this._dbus.get_object_path(),
                    params.action.name,
                    params.action.parameter
                ])
            );
        }

        for (let button of params.buttons) {
            notif.add_button_with_target(
                button.label,
                'app.deviceAction',
                new GLib.Variant('(osv)', [
                    this._dbus.get_object_path(),
                    button.action,
                    button.parameter
                ])
            );
        }

        this.send_notification(params.id, notif);
    }

    /**
     * Pairing Functions
     */
    _handlePair(packet) {
        // A pair has been requested
        if (packet.body.pair) {
            // The device is accepting our request
            if (this._outgoingPairRequest) {
                log(`Pair accepted by ${this.name}`);

                this._setPaired(true);
                return this._loadPlugins().then(values => this.notify('plugins'));
            // The device thinks we're unpaired
            } else if (this.paired) {
                this.acceptPair();
            // The device is requesting pairing
            } else {
                log(`Pair request from ${this.name}`);
                this._notifyPair(packet);
            }
        // Device is requesting unpairing/rejecting our request
        } else {
            log(`Pair rejected by ${this.name}`);

            this._unloadPlugins().then((values) => {
                this.notify('plugins');
                this._setPaired(false);
            });
        }
    }

    _notifyPair(packet) {
        this.showNotification({
            id: 'pair-request',
            // TRANSLATORS: eg. Pair Request from Google Pixel
            title: _('Pair Request from %s').format(this.name),
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
            body: _('%s Fingerprint:\n%s\n\nLocal Fingerprint:\n%s').format(
                this.name,
                this.fingerprint,
                this.service.fingerprint
            ),
            icon: new Gio.ThemedIcon({ name: 'channel-insecure-symbolic' }),
            priority: Gio.NotificationPriority.URGENT,
            buttons: [
                {
                    action: 'rejectPair',
                    label: _('Reject'),
                    parameter: new GLib.Variant('mv', null)
                },
                {
                    action: 'acceptPair',
                    label: _('Accept'),
                    parameter: new GLib.Variant('mv', null)
                }
            ]
        });

        // Start a 30s countdown
        this._incomingPairRequest = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => this._setPaired(false)
        );
    }

    _setPaired(bool) {
        if (this._incomingPairRequest) {
            this.withdraw_notification('pair-request');
            GLib.source_remove(this._incomingPairRequest);
            this._incomingPairRequest = 0;
        }

        if (this._outgoingPairRequest) {
            GLib.source_remove(this._outgoingPairRequest);
            this._outgoingPairRequest = 0;
        }

        if (bool) {
            this.settings.set_string(
                'certificate-pem',
                this._channel.certificate.certificate_pem
            );
        } else {
            this.settings.reset('certificate-pem');
        }

        this.notify('paired');
        this.notify('symbolic-icon-name');
    }

    pair() {
        debug(`${this.name} (${this.id})`);

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
        this.sendPacket({
            id: 0,
            type: 'kdeconnect.pair',
            body: { pair: true }
        });
    }

    unpair() {
        debug(`${this.name} (${this.id})`);

        // Send the unpair packet only if we're connected
        if (this._channel !== null) {
            this.sendPacket({
                id: 0,
                type: 'kdeconnect.pair',
                body: { pair: false }
            });
        }

        this._unloadPlugins().then(values => {
            this.notify('plugins');
            this._setPaired(false);
        });
    }

    acceptPair() {
        debug(`${this.name} (${this.id})`);

        this._setPaired(true);
        this.pair();
        this._loadPlugins().then(values => this.notify('plugins'));
    }

    rejectPair() {
        debug(`${this.name} (${this.id})`);

        this.unpair();
    }

    /**
     * Plugin Functions
     */
    supportedPlugins() {
        let supported = [];

        for (let name in imports.service.plugins) {
            let meta = imports.service.plugins[name].Metadata;

            // Skip base.js
            if (!meta) { continue; }

            // If it sends packets we can handle
            if (meta.incomingCapabilities.some(v => this.outgoingCapabilities.indexOf(v) > -1)) {
                supported.push(name);
            // Or handles packets we can send
            } else if (meta.outgoingCapabilities.some(v => this.incomingCapabilities.indexOf(v) > -1)) {
                supported.push(name);
            }
        }

        return supported.sort();
    }

    _loadPlugin(name) {
        debug(`${name} (${this.name})`);

        return new Promise((resolve, reject) => {
            if (!this.paired) {
                reject();
            }

            // Instantiate the handler
            if (!this._plugins.has(name)) {
                let handler, plugin;

                // TODO: Plugins already throw errors in _init() for known
                // problems, but nothing is really done with them. They should
                // be reported to the user, preferrably by way of some device
                // log that can be reviewed.
                try {
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
                } catch (e) {
                    logError(e);
                    reject(e);
                }
            }

            resolve();
        });
    }

    _loadPlugins() {
        let promises = this.supportedPlugins().map(name => this._loadPlugin(name));
        return Promise.all(promises.map(p => p.catch(() => undefined)));
    }

    _unloadPlugin(name) {
        debug(`${name} (${this.name})`);

        return new Promise((resolve, reject) => {
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
                logError(e);
                reject(e);
            }

            resolve([name, true]);
        });
    }

    _unloadPlugins() {
        let promises = this.plugins.map(name => this._unloadPlugin(name));
        return Promise.all(promises.map(p => p.catch(() => undefined)));
    }

    openSettings() {
        this.service.openSettings(this._dbus.get_object_path());
    }

    destroy() {
        this.emit('destroy');

        Gio.DBus.session.unexport_action_group(this._actionsId);
        Gio.DBus.session.unexport_menu_model(this._menuId);

        this._dbus.flush();
        this._dbus_object.remove_interface(this._dbus);
        this.service.objectManager.unexport(this._dbus_object.g_object_path);

        if (this.connected) {
            this._channel.close();
        }

        GObject.signal_handlers_destroy(this);
    }
});

