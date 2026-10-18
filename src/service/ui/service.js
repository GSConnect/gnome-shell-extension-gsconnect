// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import system from 'system';

import Config from '../../config.js';


/*
 * Issue Header
 */
const ISSUE_HEADER = `
GSConnect: ${Config.PACKAGE_VERSION} (${Config.IS_USER ? 'user' : 'system'})
GJS:       ${system.version}
Session:   ${GLib.getenv('XDG_SESSION_TYPE')}
OS:        ${GLib.get_os_info('PRETTY_NAME')}
`;


/**
 * A dialog for selecting a device
 */
export const DeviceChooser = GObject.registerClass({
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
}, class DeviceChooser extends Adw.Window {

    _init(params = {}) {
        super._init({
            application: Gio.Application.get_default(),
            title: _('Select a Device'),
            default_width: 320,
            default_height: 360,
        });

        // Dialog Action
        this.action_name = params.action_name;
        this.action_target = params.action_target;

        this._buildLayout(params.title);

        this._devicesChangedId = this.application.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();

        this.connect('close-request', () => {
            this.application.settings.disconnect(this._devicesChangedId);
            return false;
        });

        this.present();
    }

    _buildLayout(subtitle) {
        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
            title_widget: new Adw.WindowTitle({
                title: _('Select a Device'),
                subtitle: subtitle ?? '',
            }),
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this._selectButton = new Gtk.Button({label: _('Select'), sensitive: false});
        this._selectButton.add_css_class('suggested-action');
        this._selectButton.connect('clicked', () => this._select());
        header.pack_end(this._selectButton);

        this.device_list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            valign: Gtk.Align.START,
        });
        this.device_list.add_css_class('boxed-list');
        this.device_list.set_sort_func(this._sortDevices);
        this.device_list.connect('row-activated', () => this._select());
        this.device_list.connect('row-selected', (box, row) => {
            this._selectButton.sensitive = row !== null;
        });

        const placeholder = new Gtk.Label({
            label: _('No Device Found'),
            margin_top: 24,
            margin_bottom: 24,
        });
        placeholder.add_css_class('dim-label');
        this.device_list.set_placeholder(placeholder);

        toolbar.set_content(new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: this.device_list,
        }));

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (controller, keyval) => {
            if (keyval === Gdk.KEY_Escape) {
                this.close();
                return true;
            }
            return false;
        });
        this.add_controller(keys);
    }

    _select() {
        const row = this.device_list.get_selected_row();

        if (row === null)
            return;

        try {
            row.device.activate_action(this.action_name, this.action_target);
        } catch (e) {
            logError(e);
        }

        this.close();
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

    _onDevicesChanged() {
        // Collect known devices
        const devices = {};

        for (const [id, device] of this.application.manager.devices.entries())
            devices[id] = device;

        // Prune device rows
        let row = this.device_list.get_first_child();

        while (row !== null) {
            const next = row.get_next_sibling();

            if (!(row.get_name() in devices))
                this.device_list.remove(row);
            else
                delete devices[row.get_name()];

            row = next;
        }

        // Add new devices
        for (const device of Object.values(devices)) {
            const action = device.lookup_action(this.action_name);

            if (action === null)
                continue;

            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(device.name, -1),
                activatable: true,
                visible: action.enabled,
            });
            row.set_name(device.id);
            row.device = device;
            row.add_prefix(new Gtk.Image({
                icon_name: device.icon_name,
                pixel_size: 32,
            }));

            action.bind_property(
                'enabled',
                row,
                'visible',
                GObject.BindingFlags.DEFAULT
            );

            this.device_list.append(row);
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
export const ErrorDialog = GObject.registerClass({
    GTypeName: 'GSConnectServiceErrorDialog',
}, class ErrorDialog extends Adw.Window {

    _init(error) {
        super._init({
            application: Gio.Application.get_default(),
            title: `GSConnect: ${error.name}`,
            default_width: 600,
            default_height: 400,
        });

        this.error = error;
        this._buildLayout();
    }

    _buildLayout() {
        const toolbar = new Adw.ToolbarView();
        this.set_content(toolbar);

        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        const report = new Gtk.Button({label: _('Report')});
        report.add_css_class('suggested-action');
        report.connect('clicked', () => {
            const uri = this._buildUri(this.error.message, this.error.stack);
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
            this.close();
        });
        header.pack_end(report);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        toolbar.set_content(box);

        const status = new Adw.StatusPage({
            icon_name: 'dialog-error-symbolic',
            title: _('Something’s gone wrong'),
            description: _('GSConnect encountered an unexpected error. Please report the problem and include any information that may help.'),
            vexpand: true,
        });
        status.add_css_class('compact');
        box.append(status);

        // Technical details
        const expander = new Adw.ExpanderRow({title: _('Technical Details')});
        const text = new Gtk.TextView({
            editable: false,
            cursor_visible: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 12,
            bottom_margin: 12,
            left_margin: 12,
            right_margin: 12,
        });
        text.buffer.text = `${this.error.message}\n\n${this.error.stack}`;
        expander.add_row(new Gtk.ScrolledWindow({
            child: text,
            min_content_height: 120,
        }));

        const group = new Adw.PreferencesGroup();
        group.add(expander);
        box.append(group);
    }

    _buildUri(message, stack) {
        const body = `\`\`\`${ISSUE_HEADER}\n${stack}\n\`\`\``;
        const titleQuery = encodeURIComponent(message).replace('%20', '+');
        const bodyQuery = encodeURIComponent(body).replace('%20', '+');
        const uri = `${Config.PACKAGE_BUGREPORT}?title=${titleQuery}&body=${bodyQuery}`;

        // Reasonable URI length limit
        if (uri.length > 2000)
            return uri.substr(0, 2000);

        return uri;
    }
});
