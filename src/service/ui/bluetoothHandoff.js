'use strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const DeviceRow = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothHandoffDeviceRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/bluetooth-handoff-device-row.ui',
    Children: [
        'device_icon', 'device_name', 'switch',
    ],
}, class DeviceRow extends Gtk.ListBoxRow {

    _init(address, name, icon, connected, onToggle) {
        super._init();

        this._address = address;
        this._name = name;
        this._icon = icon;
        this._connected = connected;
        this._onToggle = onToggle;

        this.handleEvents = false;
        this.switch.state = connected;
        this.handleEvents = true;

        if (icon === 'audio-card') {
            this.device_icon.icon_name = 'audio-headphones-symbolic';
        } else {
            this.device_icon.icon_name = 'bluetooth-active-symbolic';
        }

        this.device_name.label = name;
    }

    _onDeviceToggled(_widget, state) {
        if (this.handleEvents) {
            GLib.log_structured('GSConnect', GLib.LogLevelFlags.LEVEL_MESSAGE, {
                'MESSAGE': 'Device Toggled: ' + this._address + ': ' + state,
                'SYSLOG_IDENTIFIER': 'org.gnome.Shell.Extensions.GSConnect.BluetoothHandoff'
            });
            this._onToggle(this._address, state);
        }
    }
});


var BluetoothHandoffDialog = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothHandoffDialog',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The bluetooth handoff plugin associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/bluetooth-handoff-dialog.ui',
    Children: [
        'instruction-label', 'device_list',
    ],
}, class BluetoothHandoffDialog extends Gtk.Dialog {

    _init(params, onDestroyCb) {
        super._init(Object.assign({
            use_header_bar: true,
        }, params));

        const headerbar = this.get_titlebar();
        headerbar.title = _('Bluetooth Handoff');
        headerbar.subtitle = _('Take Bluetooth devices from %s').format(this.device.name);

        // Main Box
        const content = this.get_content_area();
        content.border_width = 0;

        this.instruction_label.label = _('If your Bluetooth device doesn\'t show up, make sure both this PC and "%s" are near it').format(this.device.name);

        // Clear the device list
        const rows = this.device_list.get_children();

        for (let i = 0, len = rows.length; i < len; i++) {
            rows[i].destroy();
            // HACK: temporary mitigator for mysterious GtkListBox leak
            imports.system.gc();
        }

        this.plugin.connect('combined-state-changed', this._onStateChanged.bind(this));

        // Cleanup on destroy
        this._onDestroyCb = onDestroyCb;

        this.show_all();
    }

    _onStateChanged() {
        for (const widget of this.device_list.get_children()) {
            widget.destroy();
            // HACK: temporary mitigator for mysterious GtkListBox leak
            imports.system.gc();
        }

        this.plugin.combined_devs_state.forEach((device, i) => {
            const row = new DeviceRow(device.addr, device.name, device.icon, device.local_connected, this._onDeviceToggled.bind(this));
            this.device_list.add(row);
            if (i < this.plugin.combined_devs_state.length - 1) {
                this.device_list.add(new Gtk.Separator());
            }
        });
    }

    _onDeviceToggled(address, state) {
        if (state) {
            this.plugin.takeDevice(address);
        } else {
            this.plugin.giveDevice(address);
        }
    }

    vfunc_delete_event(event) {
        this._onDestroyCb();
        return false;
    }
});
