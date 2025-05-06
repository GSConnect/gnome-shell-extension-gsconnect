// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

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


/*
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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/service-device-chooser.ui',
    Singals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    },
    Children: ['title-widget', 'device-list', 'select-button'],
}, class DeviceChooser extends Adw.ApplicationWindow {


    _init(params = {}) {
        super._init(params);
        Object.assign(this, params);
        this.title_widget.title = this.title;

        // Device List
        this._internal_device_list = [];
        this.device_list.set_sort_func(this._sortDevices);

        this._devicesChangedId = this.application.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();
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

    /**
     * @returns {number} response the integer value returned by Gtk.ResponseType
     */
    get response() {
        if (this._response === undefined)
            this._response = null;
        return this._response;
    }

    set response(response) {
        if (response === Gtk.ResponseType.OK) {
            this._response = response;
            try {
                const device = this.device_list.get_selected_row().device;
                device.activate_action(this.action_name, this.action_target);
            } catch (e) {
                logError(e);
            }
        }
        this.emit('response', this, response);
        this.close();
    }

    _onSelectClicked(box, row) {
        this.response = Gtk.ResponseType.OK;
    }

    _onCancelClicked(box, row) {
        this.response = Gtk.ResponseType.CANCEL;
    }

    _onDeviceSelected(box) {
        this.select_button.sensitive = true;
    }

    _onDevicesChanged() {
        // Collect known devices
        const devices = {};

        for (const [id, device] of this.application.manager.devices.entries())
            devices[id] = device;

        // Prune device rows
        this._internal_device_list.forEach(row => {
            if (!devices.hasOwnProperty(row.name)) {
                this.device_list.remove(row);
            } else {
                delete devices[row.name];
            }
        });

        // Add new devices
        for (const device of Object.values(devices)) {
            const action = device.lookup_action(this.action_name);

            if (action === null)
                continue;

            const row = new Adw.ActionRow({
                title: device.id,
            });
            const icon = new Gtk.Image({
                icon_name: device.icon_name,
                pixel_size: 32,
                visible: true,
            });
            row.device = device;
            action.bind_property(
                'enabled',
                row,
                'visible',
                Gio.SettingsBindFlags.DEFAULT
            );
            row.add_prefix(icon);
            this._internal_device_list.push(row);
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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/service-error-dialog.ui',
    Children: [
        'title-widget',
        'error-stack',
        'expander-arrow',
        'report-button',
    ],
}, class ErrorDialog extends Adw.ApplicationWindow {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.title_widget.title = `GSConnect: ${this.error.name}`;

        this.error_stack.buffer.text = `${this.error.message}\n\n${this.error.stack}`;
    }

    _onClicked(button) {
        if (this.report_button === button) {
            const uri = this._buildUri(this.error.message, this.error.stack);
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
        }
        this.close();
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

