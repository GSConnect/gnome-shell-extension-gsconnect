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
import {DeviceNavigationPage, DevicePairPage} from './device.js';
import {Service} from '../utils/remote.js';


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
 * Generate Support Log by fetching system journal logs since a specified start time.
 *
 * This function creates a temporary log file and writes a predefined log header to it.
 * It then executes `journalctl` to retrieve logs from the system journal since the specified start time
 * and appends the logs to the temporary file. Finally, it opens the generated log file for review.
 *
 * @param {string} time - Start time as a string (24-hour notation, e.g., "2025-04-26 14:00:00").
 *
 * @returns {Promise<void>} Resolves when the log generation is complete.
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
 * Settings dialog for GSConnect, allowing users to configure device settings.
 *
 * This dialog enables the user to modify the device's display mode (either as a panel or a user menu) and rename the device.
 * It validates the device name input and ensures it does not contain any forbidden characters or exceed the character limit.
 * The dialog also reflects the current settings, and updates the device's settings based on user interactions.
 *
 * @class SettingsDialog
 * @augments Adw.PreferencesDialog
 */
const SettingsDialog = GObject.registerClass({
    GTypeName: 'GSConnectSettingsDialog',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-settings.ui',
    Children: [
        'display-mode-toggle', 'rename-entry',
    ],
}, class SettingsDialog extends Adw.PreferencesDialog {


    _init(params = {}) {
        super._init();
        Object.assign(this, params);

        this.rename_entry.text = this.settings.get_string('name');
        this.display_mode_toggle.set_active_name(this.display_mode);
        this.display_mode_toggle.connect('notify::active-name', () => {
            const name = this.display_mode_toggle.active_name;
            if (name)
                this.display_mode = name;

        });
    }

    /**
     * Gets or sets the display mode for the settings.
     * If 'show-indicators' is enabled, the mode will be 'panel'; otherwise, 'user-menu'.
     *
     * @type {string} - The display mode, either 'panel' or 'user-menu'.
     */
    get display_mode() {
        if (this.settings.get_boolean('show-indicators'))
            return 'panel';

        return 'user-menu';
    }

    set display_mode(mode) {
        this.settings.set_boolean('show-indicators', (mode === 'panel'));
    }

    /**
     * Handles setting the service name when the user confirms their input.
     * Validates the input name and updates the service name in settings if valid.
     *
     * @param {Gtk.Widget} widget - The widget that triggered the event (e.g., a button or entry).
     */
    _onSetServiceName(widget) {
        if (this._validateName(this.rename_entry.text))
            this.settings.set_string('name', this.rename_entry.text);

    }

    /**
     * Validates the device name to ensure it meets specific criteria:
     * - The name must not contain any forbidden characters.
     * - The name must not be empty (it must have at least one non-whitespace character).
     * - The name must be between 1 and 32 characters in length.
     *
     * If the validation fails, an error message is shown to the user, specifying the invalid characters
     * and the acceptable length constraints.
     *
     * @param {string} name - The device name to validate.
     * @returns {boolean} True if the name is valid, false otherwise.
     */
    _validateName(name) {
        // None of the forbidden characters and at least one non-whitespace
        if (name.trim() && /^[^"',;:.!?()[\]<>]{1,32}$/.test(name))
            return true;

        const dialog = new Adw.AlertDialog({
            heading: _('Invalid Device Name'),
            // TRANSLATOR: %s is a list of forbidden characters
            body: _('Device name must not contain any of %s ' +
                    'and have a length of 1-32 characters')
                .format('^"\',;:.!?()[]&lt;&gt;'),
            default_response: 'close',
        });
        dialog.add_response('close', _('Close'));

        dialog.present(Gio.Application.get_default().get_active_window());

        return false;
    }
});

/**
 * ConnectDialog class extends `Adw.Dialog` and allows the user to input a LAN IP and port.
 * It validates the inputs and triggers a connection action, displaying an error message if the validation fails.
 * Emits a 'response' signal on dialog closure with the response type (OK or CANCEL).
 *
 * @class ConnectDialog
 * @augments Adw.Dialog
 */
const ConnectDialog = GObject.registerClass({
    GTypeName: 'GSConnectConnectDialog',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/connect-dialog.ui',
    Children: [
        'lan_ip', 'lan_port',
    ],
    Signals: {
        'response': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT],
        },
    },
}, class ConnectDialog extends Adw.Dialog {

    _init() {
        super._init();
        this.set_title = _('Connect to...');
        this.connect('destroy', () => {
            this.response = Gtk.ResponseType.CANCEL;
        });
    }

    /**
     * Handles the connect button action.
     * Sets the response type to `Gtk.ResponseType.OK` when the button is clicked.
     *
     * @returns {void} - This function does not return any value.
     */
    _onConnectButton() {
        this.response = Gtk.ResponseType.OK;
    }

    /**
     * Handles the response when the dialog is closed. If the response is OK, it validates the host and port,
     * and attempts to trigger the 'connect' action. If validation fails or an error occurs, an error message is displayed.
     *
     * @param {Gtk.ResponseType} response - The response type from the dialog interaction (OK or others).
     *
     * @returns {void} - No return value. Closes the dialog after processing.
     */
    set response(response) {
        if (response === Gtk.ResponseType.OK) {
            try {
                // Retrieve host and port from the input fields
                const host = this.lan_ip.text.trim();
                const port = this.lan_port.value;

                // Validate host and port
                if (!this._validateHostAndPort(host, port)) {
                    this._showErrorMessage(_('Invalid host or port.'));
                    return;
                }

                const address = GLib.Variant.new_string(`lan://${host}:${port}`);
                this.application.activate_action('connect', address);
            } catch (e) {
                logError(e);
                this._showErrorMessage(_('An unexpected error occurred.'));
            }
        }

        // Close the dialog
        this.emit('response', response);
        this.close();
    }

    /**
     * Validates the provided host and port.
     * Ensures the host is non-empty and the port is within the valid range (1-65535).
     * Checks if the host is a valid IP address.
     *
     * @param {string} host - The host to validate.
     * @param {number} port - The port to validate.
     * @returns {boolean} - Returns true if the host is valid and the port is in range, false otherwise.
     */
    _validateHostAndPort(host, port) {
        // Ensure host is non-empty and port is within valid range
        if (!host || port < 1 || port > 65535)
            return false;


        try {
            return GLib.InetAddress.new_from_string(host) !== null;
        } catch {
            return false;
        }
    }

    /**
     * Displays an error dialog with a custom message.
     * The dialog is transient and includes a close button to dismiss it.
     *
     * @param {string} message - The error message to display in the dialog.
     * @returns {void} - No return value.
     */
    _showErrorMessage(message) {
        const win = Gtk.Application.get_default().get_active_window();

        // Create a transient error dialog
        const errorDialog = new Adw.MessageDialog({
            heading: _('Oops! An error occurred…'),
            body: message,
            transient_for: win,
        });

        // Add a close button to dismiss the dialog
        errorDialog.add_response('close', _('Close'));
        errorDialog.set_response_appearance('close', Adw.ResponseAppearance.DESTRUCTIVE);

        // Handle the response to close the dialog
        errorDialog.connect('response', () => errorDialog.close());

        errorDialog.present();
    }
});

/**
 * Subclass of Adw.ApplicationWindow that provides the preferences window for the GSConnect GNOME extension.
 * It manages device connections, display modes, settings dialogs, and automatic device refresh.
 * Handles window geometry restoration and integrates service state changes for device management.
 *
 * @class SettingsDialog
 * @augments Adw.PreferencesDialog
 */
export const PreferencesWindow = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesWindow',
    Properties: {
        'display-mode': GObject.ParamSpec.string(
            'display-mode',
            'Display Mode',
            'Display devices in either the Panel or User Menu',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-window.ui',
    Children: [
        'window-title', 'split-view', 'refresh-button', 'refresh-spinner',
        'refresh-stack', 'device-list', 'welcome',
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
        this._deviceListId = this.device_list.connect('row-selected', this._onDeviceSelected.bind(this));

        // Service Proxy
        this.service = new Service();

        this.pages = new Map();

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

    /**
     * Cleans up resources on window close:
     * - Removes and disposes pages.
     * - Disconnects service signals and destroys the service.
     * - Saves window geometry and removes the refresh source.
     *
     * @param {Gdk.Event} event - The close request event.
     * @returns {boolean} - Returns false to allow window close.
     */
    vfunc_close_request(event) {
        this.device_list.disconnect(this._deviceListId);
        // Remove row inside the list
        this.rows.forEach(element => {
            if(row.device._connectedId)
                row.device.disconnect(row.device._connectedId);
            if(row.device._pairedId)
                row.device.disconnect(row.device._pairedId);
            this.device_list.remove(row);
        });
        // Remove pages inside the Map
        Array.from(this.pages.keys()).forEach(id => {
            const page = this.pages.get(id);
            this.pages.delete(id);
        });

        // Disconnect signals
        if (this.service) {
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);
            this.service.disconnect(this._serviceChangedId);
            this.service = null;
        }

        // Save the window geometry
        this._saveGeometry();

        GLib.Source.remove(this._refreshSource);

        return false;
    }

    /**
     * Initializes the service by updating the service state, focusing the refresh button, and reloading the service.
     * If an error occurs during initialization, it is logged.
     *
     * @returns {void}
     */
    async _initService() {
        try {
            this._onServiceChanged(this.service, null);
            this.refresh_button.grab_focus();
            await this.service.reload();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    /**
     * Initializes the menu with actions for various dialogs and functionalities.
     * - Adds actions for display mode, about dialog, connection, settings, support log, and help.
     *
     * @returns {void}
     */
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

        const settingsDialog = new Gio.SimpleAction({name: 'settings'});
        settingsDialog.connect('activate', this._settingsDialog.bind(this));
        this.add_action(settingsDialog);

        // "Generate Support Log" GAction
        const generateSupportLog = new Gio.SimpleAction({name: 'support-log'});
        generateSupportLog.connect('activate', this._generateSupportLog.bind(this));
        this.add_action(generateSupportLog);

        // "Help" GAction
        const help = new Gio.SimpleAction({name: 'help'});
        help.connect('activate', this._help);
        this.add_action(help);
    }

    /**
     * Triggers a refresh action if the service is active.
     * Calls the 'refresh' action on the service.
     *
     * @param {Gtk.Widget} widget - The widget that invoke the callback
     * @returns {number} GLib.SOURCE_CONTINUE to continue the main loop
     */
    _refresh(widget) {
        if (widget) {
            this.refresh_stack.set_visible_child(this.refresh_spinner);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                this.refresh_stack.set_visible_child(this.refresh_button);
            });
        }
        if (this.service.active)
            this.service.activate_action('refresh', null);

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

    /**
     * Saves the window geometry (size and maximized state) to the settings.
     * If the window is maximized or fullscreen, only the maximized state is saved.
     * Otherwise, the current width and height are saved as the window size.
     *
     * @returns {void}
     */
    _saveGeometry() {
        const maximized = this.is_maximized();  // GTK 4 method
        this._windowState.set_boolean('window-maximized', maximized);

        if (maximized || this.is_fullscreen())
            return;

        // Size
        const width = this.get_allocated_width();
        const height = this.get_allocated_height();
        this._windowState.set_value('window-size', new GLib.Variant('(ii)', [width, height]));
    }

    /**
     * Displays the About Dialog with application details.
     * If it doesn't already exist, creates a new Adw.AboutDialog
     * with information such as version, license, website, and developer credits.
     *
     * @returns {void}
     */
    _aboutDialog() {
        const about = new Adw.AboutDialog({
            application_name: _('GSConnect'),
            application_icon: 'org.gnome.Shell.Extensions.GSConnect',
            comments: _('A complete KDE Connect implementation for GNOME'),
            version: Config.PACKAGE_VERSION.toString(),
            license_type: Gtk.License.GPL_2_0,
            website: Config.PACKAGE_URL,
            translator_credits: _('translator-credits'),
            designers: [
                'Giorgio Dramis <dramisgiorgio@outlook.com>',
                'Matthieu Lorier <loriermatthieu@gmail.com>',
            ],
            developers: [
                'Andy Holmes <andrew.g.r.holmes@gmail.com>',
                'Bertrand Lacoste <getzze@gmail.com>',
                'Frank Dana <ferdnyc@gmail.com>',
            ],
        });
        about.present(this);

    }

    /**
     * Displays the connection dialog. If it doesn't already exist,
     * it creates a new ConnectDialog instance and presents it.
     *
     * @returns {void}
     */
    _connectDialog() {
        if (this._dialog === undefined)
            this._dialog = new ConnectDialog();
        this._dialog.present(this);
    }

    /**
     * Displays the settings dialog. If it doesn't already exist,
     * it creates a new SettingsDialog instance and presents it.
     *
     * @returns {void}
     */
    _settingsDialog() {
        if (this._settings_dialog === undefined) {
            this._settings_dialog = new SettingsDialog({
                settings: this.settings,
            });
        }
        this._settings_dialog.present(this);
    }

    /**
     * Prompts the user to Generate Support Log by displaying a message dialog.
     * It enables debug logging, waits for user input, and either generates
     * the log or cancels the operation based on the response.
     *
     * @returns {void}
     */
    _generateSupportLog() {
        const dialog = new Adw.AlertDialog({
            heading: _('Generate Support Log'),
            body: _('Debug messages are being logged. Take any steps necessary to reproduce a problem then review the log.'),
            default_response: 'close',
        });
        
        dialog.add_response('close',  _('Cancel'));
        dialog.add_response('review_log',  _('Review Log'));

        // Enable debug logging and mark the current time
        this.settings.set_boolean('debug', true);
        const now = GLib.DateTime.new_now_local().format('%R');

        dialog.connect('response', (dialog, response_id) => {
            // Disable debug logging and destroy the dialog
            this.settings.set_boolean('debug', false);

            // Only generate a log if instructed
            if (response_id !== 'review_log')
                generateSupportLog(now);
        });

        dialog.present(Gio.Application.get_default().get_active_window());
    }

    /**
     * Validates a device name by ensuring it does not contain forbidden characters
     * and is between 1 and 32 characters in length. If the name is invalid, displays
     * an error dialog listing the forbidden characters.
     *
     * @param {string} name - The device name to validate.
     *
     * @returns {boolean} - Returns true if the name is valid, otherwise false.
     */
    _validateName(name) {
        // None of the forbidden characters and at least one non-whitespace
        if (name.trim() && /^[^"',;:.!?()[\]<>]{1,32}$/.test(name))
            return true;

        const dialog = new Adw.AlertDialog({
            heading: _('Invalid Device Name'),
            // TRANSLATOR: %s is a list of forbidden characters
            body: _('Device name must not contain any of %s ' +
                              'and have a length of 1-32 characters')
                .format('<b><tt>^"\',;:.!?()[]&lt;&gt;</tt></b>'),
            default_response: 'close',
        });
        dialog.add_response('close', _('Close'))
        dialog.present(Gio.Application.get_default().get_active_window());

        return false;
    }

    /*
     * "Help" GAction
     */
    _help(action, parameter) {
        const uri = `${Config.PACKAGE_URL}/wiki/Help`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    /**
     * Sets the device menu by inserting action groups and updating the menu model.
     * If no panel is provided, it clears the menu. Otherwise, it configures the menu
     * with the panel's device actions and menu model.
     *
     * @param {object|null} panel - The panel containing device actions and menu model, or null to reset.
     *
     * @returns {void}
     */
    _setDeviceMenu(panel = null) {
        this.device_menu.insert_action_group('device', null);
        this.device_menu.insert_action_group('settings', null);
        this.device_menu.set_menu_model(null);

        if (panel === null)
            return;

        this.device_menu.insert_action_group('device', panel.device.action_group);
        this.device_menu.insert_action_group('settings', panel.actions);
        this.device_menu.set_menu_model(panel.menu);
    }

    /**
     * Updates the subtitle of the device row based on its pairing and connection status.
     * If the updated device is currently selected, it triggers the device selection handler.
     *
     * @param {object} device - The updated device.
     * @param {object} paramspec - The parameters associated with the change.
     *
     * @returns {void}
     */
    _onDeviceChanged(device, paramspec) {
        const row = this.rows[device.id];
        switch (false) {
            case device.paired:
                row.set_subtitle(_('Unpaired'));
                break;
            case device.connected:
                row.set_subtitle(_('Disconnected'));
                break;
            default:
                row.set_subtitle(_('Connected'));
        }

        if (this.device_list.get_selected_row() !== null &&
            this.device_list.get_selected_row().device.id === device.id)
            this._onDeviceSelected(null, this.rows[device.id]);
    }

    /**
     * Adds a new device to the device list, creates a corresponding row, and sets up event listeners
     * for device connection and pairing changes. Also updates the device row based on its current state.
     *
     * @param {object} service - The service that triggered the addition.
     * @param {object} device - The device being added to the list.
     *
     * @returns {void}
     */
    _onDeviceAdded(service, device) {
        try {
            if (this.rows === undefined)
                this.rows = [];

            const row = new Adw.ActionRow();
            row.set_title(device.name);
            row.set_title_lines(1);
            row.set_subtitle_lines(1);
            row.add_prefix(new Gtk.Image({
                icon_name: device.icon_name,
                visible: true,
            }));

            device._connectedId = device.connect(
                'notify::connected',
                this._onDeviceChanged.bind(this)
            );
            device._pairedId = device.connect(
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

    /**
     * @param {GObject.Object} service - The service object
     * @param {GObject.Object} device - The device object
     * @returns {void}
     */
    _onDeviceRemoved(service, device) {
        try {
            const row = this.rows[device.id];
            if (row !== null) {
                row.device.disconnect(row.device._connectedId);
                row.device.disconnect(row.device._pairedId);
                this.device_list.remove(row);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Handles the selection of a device row. It creates or updates the corresponding
     * navigation page based on whether the device is paired or not. If the device is
     * paired, it shows a DeviceNavigationPage; otherwise, it shows a DevicePairPage.
     * It also ensures proper handling of switching between pages if necessary.
     *
     * @param {object} box - The container widget.
     * @param {object} row - The selected device row.
     *
     * @returns {void}
     */
    _onDeviceSelected(box, row) {
        try {
            if (!row) {
                this.split_view.set_content(this.welcome);
                this.split_view.set_show_content(true);
            } else { 
                let navigation_page = this.pages.get(row.device.id);
                if (row.device.paired) {
                    if (!navigation_page) {
                        navigation_page = new DeviceNavigationPage({device: row.device});
                    } else if (navigation_page instanceof DevicePairPage) {
                        this.pages.delete(row.device.id);
                        navigation_page.unparent();
                        navigation_page = new DeviceNavigationPage({device: row.device});
                    }

                } else if (!row.device.paired) {
                    if (!navigation_page) {
                        navigation_page = new DevicePairPage({device: row.device});
                    } else if (navigation_page instanceof DeviceNavigationPage) {
                        this.pages.delete(row.device.id);
                        navigation_page.unparent();
                        navigation_page = new DevicePairPage({device: row.device});
                    }
                }
                this.pages.set(row.device.id, navigation_page);
                this.split_view.set_content(navigation_page);
                this.split_view.set_show_content(true);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Updates the UI based on the service's active state. If the service is active,
     * it sets the window subtitle to "Searching for devices" and enables the refresh button.
     * If the service is inactive, it sets the subtitle to "Waiting for service" and disables
     * the refresh button.
     *
     * @param {object} service - The service object whose state changed.
     * @param {object} pspec - The property specification object.
     *
     * @returns {void}
     */
    _onServiceChanged(service, pspec) {
        if (service.active) {
            this.window_title.set_subtitle(_('Searching for devices…'));
            this.refresh_button.set_sensitive(true);
        } else {
            this.window_title.set_subtitle(_('Waiting for service…'));
            this.refresh_button.set_sensitive(false);
        }
    }
});
