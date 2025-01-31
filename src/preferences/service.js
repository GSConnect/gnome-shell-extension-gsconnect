// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import system from 'system';

import Config from '../config.js';
import { DeviceNavigationPage, DevicePairPage } from './device.js';
import { Service } from '../utils/remote.js';


/*
 * Header for support logs
 */
const LOG_HEADER = new GLib.Bytes(`
GSConnect: ${Config.PACKAGE_VERSION} (${Config.IS_USER ? 'user' : 'system'})
GJS:       ${system.version}
Session:   ${GLib.getenv('XDG_SESSION_TYPE')}
OS:        ${GLib.get_os_info('PRETTY_NAME')}
--------------------------------------------------------------------------------
`);


/**
 * Generate a support log.
 *
 * @param {string} time - Start time as a string (24-hour notation)
 */
async function generateSupportLog(time) {
    try {
        const [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
        const logFile = stream.get_output_stream();

        await new Promise((resolve, reject) => {
            logFile.write_bytes_async(LOG_HEADER, 0, null, (file, res) => {
                try {
                    resolve(file.write_bytes_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        // FIXME: BSD???
        const proc = new Gio.Subprocess({
            flags: (Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE),
            argv: ['journalctl', '--no-host', '--since', time],
        });
        proc.init(null);

        logFile.splice_async(
            proc.get_stdout_pipe(),
            Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, res) => {
                try {
                    source.splice_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );

        await new Promise((resolve, reject) => {
            proc.wait_check_async(null, (proc, res) => {
                try {
                    resolve(proc.wait_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        const uri = file.get_uri();
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    } catch (e) {
        logError(e);
    }
}

/**
 * "Connect to..." Dialog
 */
const ConnectDialog = GObject.registerClass({
    GTypeName: 'GSConnectConnectDialog',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/connect-dialog.ui',
    Children: [
        'lan_ip', 'lan_port',
    ],
}, class ConnectDialog extends Adw.Dialog {

    _init() {
        super._init();

        this.set_title = _('Connect to...')
    }

    _onResponse(dialog, response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            try {
                let address;

                // Retrieve host and port from the input fields
                const host = this.lan_ip.text.trim();
                const port = this.lan_port.value;

                // Validate host and port
                if (!this._validateHostAndPort(host, port)) {
                    this._showErrorMessage(_('Invalid host or port.'));
                    return;
                }

                address = GLib.Variant.new_string(`lan://${host}:${port}`);
                this.application.activate_action('connect', address);
            } catch (e) {
                logError(e);
                this._showErrorMessage(_('An unexpected error occurred.'));
            }
        }

        // Close the dialog
        this.close();
    }

    _validateHostAndPort(host, port) {
        // Ensure host is non-empty and port is within valid range
        if (!host || port < 1 || port > 65535) {
            return false;
        }

        try {
            return GLib.InetAddress.new_from_string(host) !== null;
        } catch {
            return false;
        }
    }

    _showErrorMessage(message) {
        // Create a transient error dialog
        const errorDialog = new Adw.MessageDialog({
            transient_for: this,
            modal: true,
            body: message,
        });

        // Add a close button to dismiss the dialog
        errorDialog.add_response('close', _('Close'));
        errorDialog.set_response_appearance('close', Adw.ResponseAppearance.DESTRUCTIVE);

        // Handle the response to close the dialog
        errorDialog.connect('response', () => errorDialog.close());

        errorDialog.show();
    }
});


export const Window = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesWindow',
    Properties: {
        'display-mode': GObject.ParamSpec.string(
            'display-mode',
            'Display Mode',
            'Display devices in either the Panel or User Menu',
            GObject.ParamFlags.READWRITE,
            null
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-window.ui',
    Children: [
        'window_title' ,
        'split_view' ,
        'refresh_button' , 
        'device_list'
    ],
}, class PreferencesWindow extends Adw.ApplicationWindow {

    _init(params = {}) {
        super._init(params);
        
        // Service Settings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                true
            ),
        });
        this.device_list.connect("row-selected", this._onDeviceSelected.bind(this));
            
        // Service Proxy
        this.service = new Service();

        this._deviceAddedId = this.service.connect(
            'device-added',
            this._onDeviceAdded.bind(this)
        );

        this._deviceRemovedId = this.service.connect(
            'device-removed',
            this._onDeviceRemoved.bind(this)
        );

        this._serviceChangedId = this.service.connect(
            'notify::active',
            this._onServiceChanged.bind(this)
        );
        
        this.add_action(this.settings.create_action('discoverable'));

        this.refresh_button.connect("clicked", this._refresh.bind(this))

        // Application Menu
        this._initMenu();

        // Setting: Keep Alive When Locked
        this.add_action(this.settings.create_action('keep-alive-when-locked'));

        // Broadcast automatically every 5 seconds if there are no devices yet
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            this._refresh.bind(this)
        );

        // Restore window size/maximized/position
        this._restoreGeometry();

        // Prime the service
        this._initService();
    }

    get display_mode() {
        if (this.settings.get_boolean('show-indicators'))
            return 'panel';

        return 'user-menu';
    }

    set display_mode(mode) {
        this.settings.set_boolean('show-indicators', (mode === 'panel'));
    }

    delete_event(event) {
        if (this.service) {
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);
            this.service.disconnect(this._serviceChangedId);
            this.service.destroy();
            this.service = null;
        }

        this._saveGeometry();
        GLib.source_remove(this._refreshSource);

        return false;
    }

    async _initService() {
        try {
            this.refresh_button.grab_focus();

            this._onServiceChanged(this.service, null);
            await this.service.reload();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _initMenu() {
        // Panel/User Menu mode
        const displayMode = new Gio.PropertyAction({
            name: 'display-mode',
            property_name: 'display-mode',
            object: this,
        });
        this.add_action(displayMode);

        // About Dialog
        const aboutDialog = new Gio.SimpleAction({name: 'about'});
        aboutDialog.connect('activate', this._aboutDialog.bind(this));
        this.add_action(aboutDialog);

        // "Connect to..." Dialog
        const connectDialog = new Gio.SimpleAction({name: 'connect'});
        connectDialog.connect('activate', this._connectDialog.bind(this));
        this.add_action(connectDialog);

        // "Generate Support Log" GAction
        const generateSupportLog = new Gio.SimpleAction({name: 'support-log'});
        generateSupportLog.connect('activate', this._generateSupportLog.bind(this));
        this.add_action(generateSupportLog);

        // "Help" GAction
        const help = new Gio.SimpleAction({name: 'help'});
        help.connect('activate', this._help);
        this.add_action(help);
    }

    _refresh() {
        if (this.service.active) {
            this.service.activate_action('refresh', null);
        }
        return GLib.SOURCE_CONTINUE;
    }

    /*
     * Window State
     */
    _restoreGeometry() {
        this._windowState = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.WindowState',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/preferences/',
        });

        // Size
        const [width, height] = this._windowState.get_value('window-size').deepUnpack();

        if (width && height)
            this.set_default_size(width, height);

        // Maximized State
        if (this._windowState.get_boolean('window-maximized'))
            this.maximize();
    }

    _saveGeometry() {
        const state = this.get_window().get_state();

        // Maximized State
        const maximized = (state & Gdk.WindowState.MAXIMIZED);
        this._windowState.set_boolean('window-maximized', maximized);

        // Leave the size at the value before maximizing
        if (maximized || (state & Gdk.WindowState.FULLSCREEN))
            return;

        // Size
        const size = this.get_size();
        this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
    }

    /**
     * About Dialog
     */
    _aboutDialog() {
        if (this._about === undefined) {
            this._about = new Adw.AboutDialog({
                application_name :  _("GSConnect"),
                application_icon : "org.gnome.Shell.Extensions.GSConnect",
                comments: _('A complete KDE Connect implementation for GNOME'),
                version : Config.PACKAGE_VERSION.toString(),
                license_type: Gtk.License.GPL_2_0,
                website: Config.PACKAGE_URL,
                translator_credits: _('translator-credits'),
                developers: [
                    "Andy Holmes <andrew.g.r.holmes@gmail.com>",
                    "Bertrand Lacoste <getzze@gmail.com>",
                    "Frank Dana <ferdnyc@gmail.com>"
                ],
            });
        }
        this._about.present(this);
    
    }

    /**
     * Connect to..." Dialog
     */
    _connectDialog() {
        if (this.dialog == null) {
            this.dialog = new ConnectDialog();
        }
        this.dialog.present(this)
    }
    

    /*
     * "Generate Support Log" GAction
     */
    _generateSupportLog() {
        const dialog = new Adw.MessageDialog({
            heading: _('Generate Support Log'),
            body: _('Debug messages are being logged. Take any steps necessary to reproduce a problem then review the log.'),
            transient_for: this
        });
        
        dialog.add_response("cancel",  _("_Cancel"));
        dialog.add_response("review_log",  _("Review Log"));

        // Enable debug logging and mark the current time
        this.settings.set_boolean('debug', true);
        const now = GLib.DateTime.new_now_local().format('%R');

        dialog.connect('response', (dialog, response_id) => {
            // Disable debug logging and destroy the dialog
            this.settings.set_boolean('debug', false);
            dialog.destroy();
            print(response_id);

            // Only generate a log if instructed
            if (response_id === "review_log")
                generateSupportLog(now);
        });

        dialog.present();
    }

    /*
     * "Help" GAction
     */
    _help(action, parameter) {
        const uri = `${Config.PACKAGE_URL}/wiki/Help`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    _onDeviceAdded(service, device) {
        try {
            if (this.rows == null) {
                this.rows = [];
            }
            let row = new Adw.ActionRow();
            row.set_title(device.name);
            row.add_prefix(new Gtk.Image({
                icon_name : device.icon_name,
                visible : true,
            }));

            device.connect(
                'notify::connected',
                this._onDeviceChanged.bind(this)
            );
            device.connect(
                'notify::paired',
                this._onDeviceChanged.bind(this)
            );

            row.device = device;
            this.rows[device.id] = row;
            this.device_list.append(row);
            this._onDeviceChanged(device, null);
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceChanged(device, paramspec) {
        switch (false) {
            case device.paired:
                this.rows[device.id].set_subtitle(_('Unpaired'));
                break;
            case device.connected:
                this.rows[device.id].set_subtitle(_('Disconnected'));
                break;
            default:
                this.rows[device.id].set_subtitle(_('Connected'));
        }
        if (this.device_list.get_selected_row() != null 
            && this.device_list.get_selected_row().device.id == device.id)
            this._onDeviceSelected(null, this.rows[device.id]);
    }

    _onDeviceRemoved(service, device) {
        try {
            const row = this.rows[device.id];
            if (row != null) {
                this.device_list.remove(row);
                row.dispose();
            }
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceSelected(box, row) {
        try {
            if (row.device.paired) {
                const navigation_page = new DeviceNavigationPage(row.device);
                this.split_view.set_content(navigation_page);
                this.split_view.set_show_content(true);
            } else {
                const navigation_page = new DevicePairPage(row.device);
                this.split_view.set_content(navigation_page);
                this.split_view.set_show_content(true);
            }
        } catch (e) {
            logError(e);
        }
    }

    _onServiceChanged(service, pspec) {
        if (this.service.active)
            this.window_title.set_subtitle(_('Searching for devices…'));
        else
            this.window_title.set_subtitle(_('Waiting for service…'));
    }
});
