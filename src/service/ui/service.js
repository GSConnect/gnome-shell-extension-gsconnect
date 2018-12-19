'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


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
            default_height: 200,
            visible: true
        });
        this.set_keep_above(true);

        //
        this._action = params.action;
        this._parameter = params.parameter;

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
        let contentArea = this.get_content_area();
        contentArea.border_width = 0;

        let scrolledWindow = new Gtk.ScrolledWindow({
            border_width: 0,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            visible: true
        });
        contentArea.add(scrolledWindow);

        this.list = new Gtk.ListBox({
            activate_on_single_click: false,
            visible: true
        });
        scrolledWindow.add(this.list);

        this.list.connect(
            'row-activated',
            this._onDeviceActivated.bind(this)
        );

        this.list.connect(
            'selected-rows-changed',
            this._onDeviceSelected.bind(this)
        );

        this._populate();
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            try {
                let device = this.list.get_selected_row().device;
                device.activate_action(this._action, this._parameter);
            } catch (e) {
                logError(e);
            }
        }

        this.destroy();
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

    _populate() {
        let devices = [];

        for (let device of this.application._devices.values()) {
            if (device.get_action_enabled(this._action)) {
                devices.push(device);
            }
        }

        for (let device of devices) {
            let row = new Gtk.ListBoxRow({visible: true});
            this.list.add(row);
            row.device = device;

            let grid = new Gtk.Grid({
                column_spacing: 6,
                margin: 6,
                visible: true
            });
            row.add(grid);

            let icon = new Gtk.Image({
                icon_name: device.icon_name,
                pixel_size: 32,
                visible: true
            });
            grid.attach(icon, 0, 0, 1, 1);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true,
                visible: true
            });
            grid.attach(name, 1, 0, 1, 1);
        }
    }
});

