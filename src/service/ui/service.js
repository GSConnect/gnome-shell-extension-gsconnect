'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lan = imports.service.lan;


/**
 * A ComboBox for KDE Connect enabled bluez devices
 */
var BluetoothComboBox = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothComboBox',
    Properties: {
        'has-devices': GObject.ParamSpec.boolean(
            'has-devices',
            'Has Devices',
            'Whether any KDE Connect enabled bluetooth devices are present',
            GObject.ParamFlags.READABLE,
            false
        )
    }
}, class BluetoothComboBox extends Gtk.ComboBox {

    _init(params) {
        super._init(params);

        this.bluetoothService = Gio.Application.get_default().bluetoothService;

        this._theme = Gtk.IconTheme.get_default();

        let model = new Gtk.ListStore();
        model.set_column_types([
            GdkPixbuf.Pixbuf,       // Icon
            GObject.TYPE_STRING,    // Alias (Name/Address)
            GObject.TYPE_STRING,    // DBus Object Path
        ]);
        this.model = model;

        // ID
        this.set_id_column(2);

        // Type Icon
        let iconCell = new Gtk.CellRendererPixbuf();
        this.pack_start(iconCell, false);
        this.add_attribute(iconCell, 'pixbuf', 0);

        // Title
        let nameCell = new Gtk.CellRendererText();
        this.pack_start(nameCell, true);
        this.add_attribute(nameCell, 'text', 1);

        this.populate();

        this._devicesId = this.bluetoothService.connect(
            'notify::devices',
            this.populate.bind(this)
        );

        this._destroyId = this.connect(
            'destroy',
            this._onDestroy.bind(this)
        );
    }

    get devices() {
        return this.bluetoothService.devices;
    }

    get has_devices() {
        return this.bluetoothService.devices.length > 0;
    }

    _onDestroy() {
        this.disconnect(this._destroyId);
        this.bluetoothService.disconnect(this._devicesId);
    }

    populate() {
        this.model.clear();

        if (this.has_devices) {
            for (let device of this.bluetoothService.devices) {
                let pixbuf = this._theme.load_icon(
                    device.Icon,
                    16,
                    Gtk.IconLookupFlags.FORCE_SIZE
                );

                this.model.set(
                    this.model.append(),
                    [0, 1, 2],
                    [pixbuf, `${device.Alias} (${device.Adapter})`, device.g_object_path]
                );
            }

            this.active_id = this.bluetoothService.devices[0].g_object_path;
        } else {
            this.model.set(this.model.append(), [1, 2], _('No Devices'), '0');
            this.active_id = '0';
        }

        this.notify('has-devices');
    }
});


/**
 * A dialog for requesting a connection from a specific device (Lan/Bluetooth)
 */
var DeviceConnectDialog = GObject.registerClass({
    GTypeName: 'GSConnectDeviceConnectDialog'
}, class DeviceConnectDialog extends Gtk.Dialog {

    _init() {
        this.service = Gio.Application.get_default();
        let modal = (this.service._window && this.service._window.visible);
        let parent = modal ? this.service._window : null;

        super._init({
            title: _('Connect to…'),
            modal: modal,
            transient_for: parent,
            use_header_bar: true
        });

        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this.add_button(_('Connect'), Gtk.ResponseType.OK);
        this.set_default_response(Gtk.ResponseType.OK);

        let grid = new Gtk.Grid({
            margin: 18,
            column_spacing: 12,
            row_spacing: 6
        });
        this.get_content_area().add(grid);

        // Lan Devices
        this.lan_radio = new Gtk.RadioButton({
            valign: Gtk.Align.CENTER,
            no_show_all: true
        });
        grid.attach(this.lan_radio, 0, 0, 1, 1);

        let lanBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            visible: true
        });
        this.lan_radio.bind_property(
            'active',
            lanBox,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );
        grid.attach(lanBox, 1, 0, 1, 1);

        this.ip = new Gtk.Entry({
            activates_default: true,
            placeholder_text: _('An IPv4 or IPv6 address'),
            tooltip_text: _('An IPv4 or IPv6 address')
        });
        this.ip.connect('focus-in-event', this._onFocus.bind(this));
        lanBox.add(this.ip);

        this.port = new Gtk.SpinButton({
            activates_default: true,
            numeric: true,
            width_chars: 4
        });
        this.port.adjustment.configure(1716, 1716, 1764, 1, 1, 1);
        lanBox.add(this.port);

        // Bluetooth Devices
        this.bluez_radio = new Gtk.RadioButton({
            group: this.lan_radio,
            valign: Gtk.Align.CENTER,
            no_show_all: true
        });
        grid.attach(this.bluez_radio, 0, 1, 1, 1);

        this.bluez = new BluetoothComboBox({
            hexpand: true,
            no_show_all: true
        });
        this.bluez_radio.bind_property(
            'active',
            this.bluez,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );
        grid.attach(this.bluez, 1, 1, 1, 1);

        //
        this.bluez.bind_property(
            'has-devices',
            this.bluez_radio,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this.bluez.bind_property(
            'has-devices',
            this.bluez,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this.bluez.bind_property(
            'has-devices',
            this.lan_radio,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );
    }

    get error() {
        if (this._style === undefined) {
            this._style = this.ip.get_style_context();
        }

        if (this._error === undefined) {
            this._error = this._style.has_class('error');
        }

        return this._error;
    }

    set error(bool) {
        if (bool && !this.error) {
            this._style.add_class('error');
        } else if (!bool && this.error) {
            this._style.remove_class('error');
        }

        this._error = bool;
    }

    _onFocus(entry) {
        this.error = false;
        return false;
    }

    vfunc_response(id) {
        if (id === Gtk.ResponseType.OK) {
            try {
                let address;

                // Bluetooth device selected
                if (this.bluez.visible && this.bluez_radio.active) {
                    address = this.bluez.active_id;

                // Lan host/port entered
                } else {
                    if (!Lan.ip_is_valid(this.ip.text)) {
                        this.error = true;
                        return false;
                    }

                    address = Gio.InetSocketAddress.new_from_string(
                        this.ip.text,
                        this.port.value
                    );
                }

                this.service.broadcast(address);
            } catch (e) {
                logWarning(e);
            }
        }

        this.destroy();
        return false;
    }
});


/**
 * A dialog for selecting a device
 */
var DeviceChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectDeviceChooserDialog'
}, class DeviceChooserDialog extends Gtk.Dialog {

    _init(params) {
        super._init({
            use_header_bar: true,
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        // HeaderBar
        let headerBar = this.get_header_bar();
        headerBar.title = _('Select a Device');
        headerBar.subtitle = params.title;
        headerBar.show_close_button = false;

        let selectButton = this.add_button(_('Select'), Gtk.ResponseType.OK);
        selectButton.sensitive = false;
        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        // Device List
        let scrolledWindow = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.get_content_area().add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect('row-activated', (list, row) => {
            this.response(Gtk.ResponseType.OK);
        });
        this.list.connect('selected-rows-changed', (list) => {
            selectButton.sensitive = (list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        this._populate(params.devices);
        scrolledWindow.show_all();
    }

    /**
     * Return the selected device
     */
    get_device() {
        return this.list.get_selected_row().device;
    }

    _populate(devices) {
        for (let device of devices) {
            let row = new Gtk.ListBoxRow();
            row.device = device;
            this.list.add(row);

            let box = new Gtk.Box({
                margin: 6,
                spacing: 6
            });
            row.add(box);

            let icon = new Gtk.Image({
                icon_name: device.type,
                pixel_size: 32
            });
            box.add(icon);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true
            });
            box.add(name);
        }
    }
});

