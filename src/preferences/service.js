'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Config = imports.config;
const Device = imports.preferences.device;
const Remote = imports.utils.remote;


/*
 * Header for support logs
 */
const LOG_HEADER = new GLib.Bytes(`
GSConnect: ${Config.PACKAGE_VERSION} (${Config.IS_USER ? 'user' : 'system'})
GJS:       ${imports.system.version}
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
        let [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
        let logFile = stream.get_output_stream();

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
        let proc = new Gio.Subprocess({
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

        let uri = file.get_uri();
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    } catch (e) {
        logError(e);
    }
}


/**
 * "Connect to..." Dialog
 */
var ConnectDialog = GObject.registerClass({
    GTypeName: 'GSConnectConnectDialog',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/connect-dialog.ui',
    Children: [
        'cancel-button', 'connect-button',
        'lan-grid', 'lan-ip', 'lan-port',
    ],
}, class ConnectDialog extends Gtk.Dialog {

    _init(params = {}) {
        super._init(Object.assign({
            use_header_bar: true,
        }, params));
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            try {
                let address;

                // Lan host/port entered
                if (this.lan_ip.text) {
                    let host = this.lan_ip.text;
                    let port = this.lan_port.value;
                    address = GLib.Variant.new_string(`lan://${host}:${port}`);
                } else {
                    return false;
                }

                this.application.activate_action('connect', address);
            } catch (e) {
                logError(e);
            }
        }

        this.destroy();
        return false;
    }
});


function rowSeparators(row, before) {
    let header = row.get_header();

    if (before === null) {
        if (header !== null)
            header.destroy();

        return;
    }

    if (header === null)
        row.set_header(new Gtk.Separator({visible: true}));
}


var Window = GObject.registerClass({
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
        // HeaderBar
        'headerbar', 'infobar', 'stack',
        'service-menu', 'service-edit', 'refresh-button',
        'device-menu', 'prev-button',

        // Popover
        'rename-popover', 'rename', 'rename-label', 'rename-entry', 'rename-submit',

        // Focus Box
        'service-window', 'service-box',

        // Device List
        'device-list', 'device-list-spinner', 'device-list-placeholder',
    ],
}, class PreferencesWindow extends Gtk.ApplicationWindow {

    _init(params = {}) {
        super._init(params);

        // Service Settings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                true
            ),
        });

        // Service Proxy
        this.service = new Remote.Service();

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

        // HeaderBar (Service Name)
        this.headerbar.title = this.settings.get_string('name');
        this.rename_entry.text = this.headerbar.title;

        // Scroll with keyboard focus
        this.service_box.set_focus_vadjustment(this.service_window.vadjustment);

        // Device List
        this.device_list.set_header_func(rowSeparators);

        // Discoverable InfoBar
        this.settings.bind(
            'discoverable',
            this.infobar,
            'reveal-child',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.add_action(this.settings.create_action('discoverable'));

        // Application Menu
        this._initMenu();

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

    vfunc_delete_event(event) {
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
        let displayMode = new Gio.PropertyAction({
            name: 'display-mode',
            property_name: 'display-mode',
            object: this,
        });
        this.add_action(displayMode);

        // About Dialog
        let aboutDialog = new Gio.SimpleAction({name: 'about'});
        aboutDialog.connect('activate', this._aboutDialog.bind(this));
        this.add_action(aboutDialog);

        // "Connect to..." Dialog
        let connectDialog = new Gio.SimpleAction({name: 'connect'});
        connectDialog.connect('activate', this._connectDialog.bind(this));
        this.add_action(connectDialog);

        // "Generate Support Log" GAction
        let generateSupportLog = new Gio.SimpleAction({name: 'support-log'});
        generateSupportLog.connect('activate', this._generateSupportLog.bind(this));
        this.add_action(generateSupportLog);

        // "Help" GAction
        let help = new Gio.SimpleAction({name: 'help'});
        help.connect('activate', this._help);
        this.add_action(help);
    }

    _refresh() {
        if (this.service.active && this.device_list.get_children().length < 1) {
            this.device_list_spinner.active = true;
            this.service.activate_action('refresh', null);
        } else {
            this.device_list_spinner.active = false;
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
        let [width, height] = this._windowState.get_value('window-size').deepUnpack();

        if (width && height)
            this.set_default_size(width, height);

        // Maximized State
        if (this._windowState.get_boolean('window-maximized'))
            this.maximize();
    }

    _saveGeometry() {
        let state = this.get_window().get_state();

        // Maximized State
        let maximized = (state & Gdk.WindowState.MAXIMIZED);
        this._windowState.set_boolean('window-maximized', maximized);

        // Leave the size at the value before maximizing
        if (maximized || (state & Gdk.WindowState.FULLSCREEN))
            return;

        // Size
        let size = this.get_size();
        this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
    }

    /**
     * About Dialog
     */
    _aboutDialog() {
        if (this._about === undefined) {
            this._about = new Gtk.AboutDialog({
                application: Gio.Application.get_default(),
                authors: [
                    'Andy Holmes <andrew.g.r.holmes@gmail.com>',
                    'Bertrand Lacoste <getzze@gmail.com>',
                    'Frank Dana <ferdnyc@gmail.com>',
                ],
                comments: _('A complete KDE Connect implementation for GNOME'),
                logo: GdkPixbuf.Pixbuf.new_from_resource_at_scale(
                    '/org/gnome/Shell/Extensions/GSConnect/icons/org.gnome.Shell.Extensions.GSConnect.svg',
                    128,
                    128,
                    true
                ),
                program_name: 'GSConnect',
                // TRANSLATORS: eg. 'Translator Name <your.email@domain.com>'
                translator_credits: _('translator-credits'),
                version: Config.PACKAGE_VERSION.toString(),
                website: Config.PACKAGE_URL,
                license_type: Gtk.License.GPL_2_0,
                modal: true,
                transient_for: this,
            });

            // Persist
            this._about.connect('response', (dialog) => dialog.hide_on_delete());
            this._about.connect('delete-event', (dialog) => dialog.hide_on_delete());
        }

        this._about.present();
    }

    /**
     * Connect to..." Dialog
     */
    _connectDialog() {
        new ConnectDialog({
            application: Gio.Application.get_default(),
            modal: true,
            transient_for: this,
        });
    }

    /*
     * "Generate Support Log" GAction
     */
    _generateSupportLog() {
        let dialog = new Gtk.MessageDialog({
            text: _('Generate Support Log'),
            secondary_text: _('Debug messages are being logged. Take any steps necessary to reproduce a problem then review the log.'),
        });
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Review Log'), Gtk.ResponseType.OK);

        // Enable debug logging and mark the current time
        this.settings.set_boolean('debug', true);
        let now = GLib.DateTime.new_now_local().format('%R');

        dialog.connect('response', (dialog, response_id) => {
            // Disable debug logging and destroy the dialog
            this.settings.set_boolean('debug', false);
            dialog.destroy();

            // Only generate a log if instructed
            if (response_id === Gtk.ResponseType.OK)
                generateSupportLog(now);
        });

        dialog.show_all();
    }

    /*
     * "Help" GAction
     */
    _help(action, parameter) {
        let uri = `${Config.PACKAGE_URL}/wiki/Help`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    /*
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        // HeaderBar (Service)
        this.prev_button.visible = false;
        this.device_menu.visible = false;

        this.refresh_button.visible = true;
        this.service_edit.visible = true;
        this.service_menu.visible = true;

        this.headerbar.title = this.settings.get_string('name');
        this.headerbar.subtitle = null;

        // Panel
        this.stack.visible_child_name = 'service';
        this._setDeviceMenu();
    }

    _onEditServiceName(button, event) {
        this.rename_entry.text = this.headerbar.title;
        this.rename_entry.has_focus = true;
    }

    _onSetServiceName(widget) {
        if (this.rename_entry.text.length) {
            this.headerbar.title = this.rename_entry.text;
            this.settings.set_string('name', this.rename_entry.text);
        }

        this.service_edit.active = false;
        this.service_edit.grab_focus();
    }

    /*
     * Context Switcher
     */
    _getTypeLabel(device) {
        switch (device.type) {
            case 'laptop':
                return _('Laptop');
            case 'phone':
                return _('Smartphone');
            case 'tablet':
                return _('Tablet');
            case 'tv':
                return _('Television');
            default:
                return _('Desktop');
        }
    }

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

    _onDeviceChanged(statusLabel, device, pspec) {
        switch (false) {
            case device.paired:
                statusLabel.label = _('Unpaired');
                break;

            case device.connected:
                statusLabel.label = _('Disconnected');
                break;

            default:
                statusLabel.label = _('Connected');
        }
    }

    _createDeviceRow(device) {
        let row = new Gtk.ListBoxRow({
            height_request: 52,
            selectable: false,
            visible: true,
        });
        row.set_name(device.id);

        let grid = new Gtk.Grid({
            column_spacing: 12,
            margin_left: 20,
            margin_right: 20,
            margin_bottom: 8,
            margin_top: 8,
            visible: true,
        });
        row.add(grid);

        let icon = new Gtk.Image({
            gicon: new Gio.ThemedIcon({name: device.icon_name}),
            icon_size: Gtk.IconSize.BUTTON,
            visible: true,
        });
        grid.attach(icon, 0, 0, 1, 1);

        let title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true,
        });
        grid.attach(title, 1, 0, 1, 1);

        let status = new Gtk.Label({
            halign: Gtk.Align.END,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true,
        });
        grid.attach(status, 2, 0, 1, 1);

        // Keep name up to date
        device.bind_property(
            'name',
            title,
            'label',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Keep status up to date
        device.connect(
            'notify::connected',
            this._onDeviceChanged.bind(null, status)
        );
        device.connect(
            'notify::paired',
            this._onDeviceChanged.bind(null, status)
        );
        this._onDeviceChanged(status, device, null);

        return row;
    }

    _onDeviceAdded(service, device) {
        try {
            if (!this.stack.get_child_by_name(device.id)) {
                // Add the device preferences
                let prefs = new Device.Panel(device);
                this.stack.add_titled(prefs, device.id, device.name);

                // Add a row to the device list
                prefs.row = this._createDeviceRow(device);
                this.device_list.add(prefs.row);
            }
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceRemoved(service, device) {
        try {
            let prefs = this.stack.get_child_by_name(device.id);

            if (prefs === null)
                return;

            if (prefs === this.stack.get_visible_child())
                this._onPrevious();

            prefs.row.destroy();
            prefs.row = null;

            prefs.dispose();
            prefs.destroy();
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceSelected(box, row) {
        try {
            if (row === null)
                return this._onPrevious();

            // Transition the panel
            let name = row.get_name();
            let prefs = this.stack.get_child_by_name(name);

            this.stack.visible_child = prefs;
            this._setDeviceMenu(prefs);

            // HeaderBar (Device)
            this.refresh_button.visible = false;
            this.service_edit.visible = false;
            this.service_menu.visible = false;

            this.prev_button.visible = true;
            this.device_menu.visible = true;

            this.headerbar.title = prefs.device.name;
            this.headerbar.subtitle = this._getTypeLabel(prefs.device);
        } catch (e) {
            logError(e);
        }
    }

    _onServiceChanged(service, pspec) {
        if (this.service.active)
            this.device_list_placeholder.label = _('Searching for devices…');
        else
            this.device_list_placeholder.label = _('Waiting for service…');
    }
});

