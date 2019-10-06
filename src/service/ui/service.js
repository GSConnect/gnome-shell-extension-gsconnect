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

        // Placeholder
        let placeholder = new Gtk.Grid({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            visible: true
        });
        placeholder.get_style_context().add_class('placeholder');
        this.list.set_placeholder(placeholder);

        let placeholderImage = new Gtk.Image({
            icon_name: 'org.gnome.Shell.Extensions.GSConnect-symbolic',
            pixel_size: 64,
            visible: true
        });
        placeholderImage.get_style_context().add_class('placeholder-image');
        placeholder.attach(placeholderImage, 0, 0, 1, 1);

        let placeholderLabel = new Gtk.Label({
            label: _('No Device Found'),
            margin_top: 12,
            visible: true
        });
        placeholderLabel.get_style_context().add_class('placeholder-title');
        placeholder.attach(placeholderLabel, 0, 1, 1, 1);

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
        for (let device of this.application._devices.values()) {
            let action = device.lookup_action(this._action);

            let row = new Gtk.ListBoxRow({
                visible: action.enabled
            });

            action.bind_property('enabled', row, 'visible', 0);
            row.device = device;

            let grid = new Gtk.Grid({
                column_spacing: 12,
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
            this.list.add(row);
        }

        this.list.select_row(this.list.get_row_at_index(0));
    }
});

