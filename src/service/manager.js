'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;
const DBus = imports.service.utils.dbus;
const Device = imports.service.device;

const DEVICE_NAME = 'org.gnome.Shell.Extensions.GSConnect.Device';
const DEVICE_PATH = '/org/gnome/Shell/Extensions/GSConnect/Device';
const DEVICE_IFACE = Config.DBUS.lookup_interface(DEVICE_NAME);


/**
 * A manager for devices.
 */
var Manager = GObject.registerClass({
    GTypeName: 'GSConnectManager',
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active',
            'Active',
            'Whether the manager is active',
            GObject.ParamFlags.READABLE,
            false
        ),
        'discoverable': GObject.ParamSpec.boolean(
            'discoverable',
            'Discoverable',
            'Whether the service responds to discovery requests',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'Id',
            'The hostname or other network unique id',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The name announced to the network',
            GObject.ParamFlags.READWRITE,
            'GSConnect'
        ),
    },
}, class Manager extends Gio.DBusObjectManagerServer {

    _init(params = {}) {
        super._init(params);

        this._exported = new WeakMap();
        this._reconnectId = 0;

        this._settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
        });
        this._initSettings();
    }

    get active() {
        if (this._active === undefined)
            this._active = false;

        return this._active;
    }

    get backends() {
        if (this._backends === undefined)
            this._backends = new Map();

        return this._backends;
    }

    get devices() {
        if (this._devices === undefined)
            this._devices = new Map();

        return this._devices;
    }

    get discoverable() {
        if (this._discoverable === undefined)
            this._discoverable = this.settings.get_boolean('discoverable');

        return this._discoverable;
    }

    set discoverable(value) {
        if (this.discoverable === value)
            return;

        this._discoverable = value;
        this.notify('discoverable');

        // FIXME: This whole thing just keeps getting uglier
        let application = Gio.Application.get_default();

        if (application === null)
            return;

        if (this.discoverable) {
            Gio.Application.prototype.withdraw_notification.call(
                application,
                'discovery-warning'
            );
        } else {
            let notif = new Gio.Notification();
            notif.set_title(_('Discovery Disabled'));
            notif.set_body(_('Discovery has been disabled due to the number of devices on this network.'));
            notif.set_icon(new Gio.ThemedIcon({name: 'dialog-warning'}));
            notif.set_priority(Gio.NotificationPriority.HIGH);
            notif.set_default_action('app.preferences');

            Gio.Application.prototype.withdraw_notification.call(
                application,
                'discovery-warning',
                notif
            );
        }
    }

    get id() {
        if (this._id === undefined)
            this._id = this.settings.get_string('id');

        return this._id;
    }

    set id(value) {
        if (this.id === value)
            return;

        this._id = value;
        this.notify('id');
    }

    get name() {
        if (this._name === undefined)
            this._name = this.settings.get_string('name');

        return this._name;
    }

    set name(value) {
        if (this.name === value)
            return;

        this._name = value;
        this.notify('name');

        // Broadcast changes to the network
        for (let backend of this.backends.values()) {
            backend.name = this.name;
            backend.buildIdentity();
        }

        this.identify();
    }

    get settings() {
        if (this._settings === undefined) {
            this._settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
            });
        }

        return this._settings;
    }

    vfunc_notify(pspec) {
        if (pspec.name !== 'connection')
            return;

        if (this.connection !== null)
            this._exportDevices();
        else
            this._unexportDevices();
    }

    /*
     * GSettings
     */
    _initSettings() {
        // Initialize the ID and name of the service
        if (this.settings.get_string('id').length === 0)
            this.settings.set_string('id', GLib.uuid_string_random());

        if (this.settings.get_string('name').length === 0)
            this.settings.set_string('name', GLib.get_host_name());

        // Bound Properties
        this.settings.bind('discoverable', this, 'discoverable', 0);
        this.settings.bind('id', this, 'id', 0);
        this.settings.bind('name', this, 'name', 0);
    }

    /*
     * Backends
     */
    _onChannel(backend, channel) {
        try {
            let device = this.devices.get(channel.identity.body.deviceId);

            switch (true) {
                // Proceed if this is an existing device...
                case (device !== undefined):
                    break;

                // Or the connection is allowed...
                case this.discoverable || channel.allowed:
                    device = this._ensureDevice(channel.identity);
                    break;

                // ...otherwise bail
                default:
                    debug(`${channel.identity.body.deviceName}: not allowed`);
                    return false;
            }

            device.setChannel(channel);
            return true;
        } catch (e) {
            logError(e, backend.name);
            return false;
        }
    }

    _loadBackends() {
        for (let name in imports.service.backends) {
            try {
                // Try to create the backend and track it if successful
                let module = imports.service.backends[name];
                let backend = new module.ChannelService({
                    id: this.id,
                    name: this.name,
                });
                this.backends.set(name, backend);

                // Connect to the backend
                backend.__channelId = backend.connect(
                    'channel',
                    this._onChannel.bind(this)
                );

                // Now try to start the backend, allowing us to retry if we fail
                backend.start();
            } catch (e) {
                if (Gio.Application.get_default())
                    Gio.Application.get_default().notify_error(e);
            }
        }
    }

    /*
     * Devices
     */
    _loadDevices() {
        // Load cached devices
        for (let id of this.settings.get_strv('devices')) {
            let device = new Device.Device({body: {deviceId: id}});
            this._exportDevice(device);
            this.devices.set(id, device);
        }
    }

    _exportDevice(device) {
        if (this.connection === null)
            return;

        let info = {
            object: null,
            interface: null,
            actions: 0,
            menu: 0,
        };

        let objectPath = `${DEVICE_PATH}/${device.id.replace(/\W+/g, '_')}`;

        // Export an object path for the device
        info.object = new Gio.DBusObjectSkeleton({
            g_object_path: objectPath,
        });
        this.export(info.object);

        // Export GActions & GMenu
        info.actions = Gio.DBus.session.export_action_group(objectPath, device);
        info.menu = Gio.DBus.session.export_menu_model(objectPath, device.menu);

        // Export the Device interface
        info.interface = new DBus.Interface({
            g_instance: device,
            g_interface_info: DEVICE_IFACE,
        });
        info.object.add_interface(info.interface);

        this._exported.set(device, info);
    }

    _exportDevices() {
        if (this.connection === null)
            return;

        for (let device of this.devices.values())
            this._exportDevice(device);
    }

    _unexportDevice(device) {
        let info = this._exported.get(device);

        if (info === undefined)
            return;

        // Unexport GActions and GMenu
        Gio.DBus.session.unexport_action_group(info.actions);
        Gio.DBus.session.unexport_menu_model(info.menu);

        // Unexport the Device interface and object
        info.interface.flush();
        info.object.remove_interface(info.interface);
        info.object.flush();
        this.unexport(info.object.g_object_path);

        this._exported.delete(device);
    }

    _unexportDevices() {
        for (let device of this.devices.values())
            this._unexportDevice(device);
    }

    /**
     * Return a device for @packet, creating it and adding it to the list of
     * of known devices if it doesn't exist.
     *
     * @param {Core.Packet} packet - An identity packet for the device
     * @return {Device.Device} A device object
     */
    _ensureDevice(packet) {
        let device = this.devices.get(packet.body.deviceId);

        if (device === undefined) {
            debug(`Adding ${packet.body.deviceName}`);

            // TODO: Remove when all clients support bluetooth-like discovery
            //
            // If this is the third unpaired device to connect, we disable
            // discovery to avoid choking on networks with many devices
            let unpaired = Array.from(this.devices.values()).filter(dev => {
                return !dev.paired;
            });

            if (unpaired.length === 3)
                this.discoverable = false;

            device = new Device.Device(packet);
            this._exportDevice(device);
            this.devices.set(device.id, device);

            // Notify
            this.settings.set_strv('devices', Array.from(this.devices.keys()));
        }

        return device;
    }

    /**
     * Permanently remove a device.
     *
     * Removes the device from the list of known devices, deletes all GSettings
     * and files.
     *
     * @param {string} id - The id of the device to delete
     */
    _removeDevice(id) {
        // Delete all GSettings
        let settings_path = `/org/gnome/shell/extensions/gsconnect/${id}/`;
        GLib.spawn_command_line_async(`dconf reset -f ${settings_path}`);

        // Delete the cache
        let cache = GLib.build_filenamev([Config.CACHEDIR, id]);
        Gio.File.rm_rf(cache);

        // Forget the device
        this.devices.delete(id);
        this.settings.set_strv('devices', Array.from(this.devices.keys()));
    }

    /**
     * A GSourceFunc that tries to reconnect to each paired device, while
     * pruning unpaired devices that have disconnected.
     *
     * @return {boolean} Always %true
     */
    _reconnect() {
        for (let [id, device] of this.devices) {
            if (device.connected)
                continue;

            if (device.paired) {
                this.identify(device.settings.get_string('last-connection'));
                continue;
            }

            this._unexportDevice(device);
            this._removeDevice(id);
            device.destroy();
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Identify to an address or broadcast to the network.
     *
     * @param {string} [uri] - An address URI or %null to broadcast
     */
    identify(uri = null) {
        try {
            // If we're passed a parameter, try and find a backend for it
            if (uri !== null) {
                let [scheme, address] = uri.split('://');

                let backend = this.backends.get(scheme);

                if (backend !== undefined)
                    backend.broadcast(address);

            // If we're not discoverable, only try to reconnect known devices
            } else if (!this.discoverable) {
                this._reconnect();

            // Otherwise have each backend broadcast to it's network
            } else {
                this.backends.forEach(backend => backend.broadcast());
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Start managing devices.
     */
    start() {
        if (this.active)
            return;

        this._loadDevices();
        this._loadBackends();

        if (this._reconnectId === 0) {
            this._reconnectId = GLib.timeout_add_seconds(
                GLib.PRIORITY_LOW,
                5,
                this._reconnect.bind(this)
            );
        }

        this._active = true;
        this.notify('active');
    }

    /**
     * Stop managing devices.
     */
    stop() {
        if (!this.active)
            return;

        if (this._reconnectId > 0) {
            GLib.Source.remove(this._reconnectId);
            this._reconnectId = 0;
        }

        this._unexportDevices();

        this.backends.forEach(backend => backend.destroy());
        this.backends.clear();

        this.devices.forEach(device => device.destroy());
        this.devices.clear();

        this._active = false;
        this.notify('active');
    }

    /**
     * Stop managing devices and free any resources.
     */
    destroy() {
        this.stop();
        this.set_connection(null);
    }
});

