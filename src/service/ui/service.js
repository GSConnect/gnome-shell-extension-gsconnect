'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Config = imports.config;


/*
 * Issue Header
 */
const ISSUE_HEADER = `
GSConnect: ${Config.PACKAGE_VERSION} (${Config.IS_USER ? 'user' : 'system'})
GJS:       ${imports.system.version}
Session:   ${GLib.getenv('XDG_SESSION_TYPE')}
OS:        ${GLib.get_os_info('PRETTY_NAME')}
`;


/**
 * A dialog for selecting a device
 */
var DeviceChooser = GObject.registerClass({
    GTypeName: 'GSConnectServiceDeviceChooser',
    Properties: {
        'action-name': GObject.ParamSpec.string(
            'action-name',
            'Action Name',
            'The name of the associated action, like "sendFile"',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'action-target': GObject.param_spec_variant(
            'action-target',
            'Action Target',
            'The parameter for action invocations',
            new GLib.VariantType('*'),
            null,
            GObject.ParamFlags.READWRITE
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/service-device-chooser.ui',
    Children: ['device-list', 'cancel-button', 'select-button'],
}, class DeviceChooser extends Gtk.Dialog {

    _init(params = {}) {
        super._init({
            use_header_bar: true,
            application: Gio.Application.get_default(),
        });
        this.set_keep_above(true);

        // HeaderBar
        this.get_header_bar().subtitle = params.title;

        // Dialog Action
        this.action_name = params.action_name;
        this.action_target = params.action_target;

        // Device List
        this.device_list.set_sort_func(this._sortDevices);

        this._devicesChangedId = this.application.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            try {
                let device = this.device_list.get_selected_row().device;
                device.activate_action(this.action_name, this.action_target);
            } catch (e) {
                logError(e);
            }
        }

        this.destroy();
    }

    get action_name() {
        if (this._action_name === undefined)
            this._action_name = null;

        return this._action_name;
    }

    set action_name(name) {
        this._action_name = name;
    }

    get action_target() {
        if (this._action_target === undefined)
            this._action_target = null;

        return this._action_target;
    }

    set action_target(variant) {
        this._action_target = variant;
    }

    _onDeviceActivated(box, row) {
        this.response(Gtk.ResponseType.OK);
    }

    _onDeviceSelected(box) {
        this.set_response_sensitive(
            Gtk.ResponseType.OK,
            (box.get_selected_row())
        );
    }

    _onDevicesChanged() {
        // Collect known devices
        let devices = {};

        for (let [id, device] of this.application.devices.entries())
            devices[id] = device;

        // Prune device rows
        this.device_list.foreach(row => {
            if (!devices.hasOwnProperty(row.name))
                row.destroy();
            else
                delete devices[row.name];
        });

        // Add new devices
        for (let device of Object.values(devices)) {
            let action = device.lookup_action(this.action_name);

            if (action === null)
                continue;

            let row = new Gtk.ListBoxRow({
                visible: action.enabled,
            });
            row.set_name(device.id);
            row.device = device;

            action.bind_property(
                'enabled',
                row,
                'visible',
                Gio.SettingsBindFlags.DEFAULT
            );

            let grid = new Gtk.Grid({
                column_spacing: 12,
                margin: 6,
                visible: true,
            });
            row.add(grid);

            let icon = new Gtk.Image({
                icon_name: device.icon_name,
                pixel_size: 32,
                visible: true,
            });
            grid.attach(icon, 0, 0, 1, 1);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true,
                visible: true,
            });
            grid.attach(name, 1, 0, 1, 1);

            this.device_list.add(row);
        }

        if (this.device_list.get_selected_row() === null)
            this.device_list.select_row(this.device_list.get_row_at_index(0));
    }

    _sortDevices(row1, row2) {
        return row1.device.name.localeCompare(row2.device.name);
    }
});


/**
 * A dialog for reporting an error.
 */
var ErrorDialog = GObject.registerClass({
    GTypeName: 'GSConnectServiceErrorDialog',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/service-error-dialog.ui',
    Children: [
        'error-stack',
        'expander-arrow',
        'gesture',
        'report-button',
        'revealer',
    ],
}, class ErrorDialog extends Gtk.Window {

    _init(error) {
        super._init({
            application: Gio.Application.get_default(),
            title: `GSConnect: ${error.name}`,
        });
        this.set_keep_above(true);

        this.error = error;
        this.error_stack.buffer.text = `${error.message}\n\n${error.stack}`;
        this.gesture.connect('released', this._onReleased.bind(this));
    }

    _onClicked(button) {
        if (this.report_button === button) {
            const uri = this._buildUri(this.error.message, this.error.stack);
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
        }

        this.destroy();
    }

    _onReleased(gesture, n_press) {
        if (n_press === 1)
            this.revealer.reveal_child = !this.revealer.reveal_child;
    }

    _onRevealChild(revealer, pspec) {
        this.expander_arrow.icon_name = this.revealer.reveal_child
            ? 'pan-down-symbolic'
            : 'pan-end-symbolic';
    }

    _buildUri(message, stack) {
        let body = `\`\`\`${ISSUE_HEADER}\n${stack}\n\`\`\``;
        let titleQuery = encodeURIComponent(message).replace('%20', '+');
        let bodyQuery = encodeURIComponent(body).replace('%20', '+');
        let uri = `${Config.PACKAGE_BUGREPORT}?title=${titleQuery}&body=${bodyQuery}`;

        // Reasonable URI length limit
        if (uri.length > 2000)
            return uri.substr(0, 2000);

        return uri;
    }
});

