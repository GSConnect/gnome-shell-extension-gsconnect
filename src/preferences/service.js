'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Device = imports.preferences.device;
const Remote = imports.shell.remote;

/*
 * Header for support logs
 */
const LOG_HEADER = new GLib.Bytes(`
GSConnect Version: ${gsconnect.metadata.version}
GSConnect Install: ${(gsconnect.is_local) ? 'user' : 'system'}
GJS: ${imports.system.version}
XDG_SESSION_TYPE: ${GLib.getenv('XDG_SESSION_TYPE')}
GDMSESSION: ${GLib.getenv('GDMSESSION')}
--------------------------------------------------------------------------------
`);


/**
 * Generate a support log
 */
async function generateSupportLog(time) {
    try {
        let file = Gio.File.new_tmp('gsconnect.XXXXXX')[0];

        let logFile = await new Promise((resolve, reject) => {
            file.replace_async(null, false, 2, 0, null, (file, res) => {
                try {
                    resolve(file.replace_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

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
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            argv: ['journalctl', '--no-host', '--since', time]
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
    Properties: {
        'has-devices': GObject.ParamSpec.boolean(
            'has-devices',
            'Has Devices',
            'Whether any KDE Connect enabled bluetooth devices are present',
            GObject.ParamFlags.READABLE,
            false
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/connect.ui',
    Children: [
        'cancel-button', 'connect-button',
        'lan-radio', 'lan-grid', 'lan-ip', 'lan-port',
        'bluez-radio', 'bluez-grid', 'bluez-device', 'bluez-devices'
    ]
}, class ConnectDialog extends Gtk.Dialog {

    _init(parent = null) {
        this.connectTemplate();
        super._init({
            application: Gio.Application.get_default(),
            modal: (parent),
            transient_for: parent,
            use_header_bar: true
        });

        // Bluez Device ComboBox
        let iconCell = new Gtk.CellRendererPixbuf({xpad: 6});
        this.bluez_device.pack_start(iconCell, false);
        this.bluez_device.add_attribute(iconCell, 'pixbuf', 0);

        let nameCell = new Gtk.CellRendererText();
        this.bluez_device.pack_start(nameCell, true);
        this.bluez_device.add_attribute(nameCell, 'text', 1);

        if (this.application.bluetooth) {
            this._devicesId = this.application.bluetooth.connect(
                'notify::devices',
                this.populate.bind(this)
            );
            this.populate();
        }

        // Connection type selection
        this.lan_radio.bind_property(
            'active',
            this.lan_grid,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        this.bluez_radio.bind_property(
            'active',
            this.bluez_grid,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Hide Bluez and selection if there are no supported bluetooth devices
        this.bind_property(
            'has-devices',
            this.bluez_radio,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this.bind_property(
            'has-devices',
            this.bluez_grid,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this.bind_property(
            'has-devices',
            this.lan_radio,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            try {
                let address;

                // Bluetooth device selected
                if (this.bluez_device.visible && this.bluez_radio.active) {
                    let path = this.bluez_device.active_id;
                    address = GLib.Variant.new_string(`bluetooth://${path}`);

                // Lan host/port entered
                } else if (this.lan_ip.text) {
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

        if (this._devicesId) {
            this.application.bluetooth.disconnect(this._devicesId);
        }

        this.disconnectTemplate();
        this.destroy();
        return false;
    }

    get has_devices() {
        if (!this.application.bluetooth) {
            return false;
        }

        return this.application.bluetooth.devices.length > 0;
    }

    populate() {
        this.bluez_devices.clear();
        let theme = Gtk.IconTheme.get_default();

        if (this.has_devices) {
            for (let device of this.application.bluetooth.devices) {
                let pixbuf = theme.load_icon(
                    device.Icon,
                    16,
                    Gtk.IconLookupFlags.FORCE_SIZE
                );

                this.bluez_devices.set(
                    this.bluez_devices.append(),
                    [0, 1, 2],
                    [pixbuf, `${device.Alias} (${device.Adapter})`, device.g_object_path]
                );
            }

            this.bluez_device.active_id = this.application.bluetooth.devices[0].g_object_path;
        }

        this.notify('has-devices');
    }
});


function rowSeparators(row, before) {
    let header = row.get_header();

    if (before === null) {
        if (header !== null) {
            header.destroy();
        }

        return;
    }

    if (header === null) {
        header = new Gtk.Separator({visible: true});
        row.set_header(header);
    }
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
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-window.ui',
    Children: [
        // HeaderBar
        'headerbar', 'infobar', 'stack',
        'service-menu', 'service-edit', 'service-entry', 'service-refresh',
        'device-menu', 'prev-button',

        // Focus Box
        'service-window', 'service-box',

        // Device List
        'device-list', 'device-list-spinner', 'device-list-placeholder'
    ]
}, class PreferencesWindow extends Gtk.ApplicationWindow {

    _init(params) {
        this.connectTemplate();
        super._init(params);

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Preferences',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/preferences/'
        });

        // HeaderBar (Service Name)
        this.headerbar.title = gsconnect.settings.get_string('name');
        this.service_entry.text = this.headerbar.title;

        // Scroll with keyboard focus
        this.service_box.set_focus_vadjustment(this.service_window.vadjustment);

        // Device List
        this.device_list.set_header_func(rowSeparators);

        // Discoverable InfoBar
        gsconnect.settings.bind(
            'discoverable',
            this.infobar,
            'reveal-child',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this.add_action(gsconnect.settings.create_action('discoverable'));

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

        // Start the remote service
        this._init_async();
    }

    get display_mode() {
        if (gsconnect.settings.get_boolean('show-indicators')) {
            return 'panel';
        } else {
            return 'user-menu';
        }
    }

    set display_mode(mode) {
        gsconnect.settings.set_boolean('show-indicators', (mode === 'panel'));
    }

    vfunc_delete_event(event) {
        if (this.service) {
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);
            this.service.destroy();
            this.service = null;
        }

        this._saveGeometry();
        this.disconnectTemplate();
        GLib.source_remove(this._refreshSource);

        return false;
    }

    async _init_async() {
        try {
            // Device Manager
            this.service = new Remote.Service();

            // Watch for new and removed
            this._deviceAddedId = this.service.connect(
                'device-added',
                this._onDeviceAdded.bind(this)
            );

            this._deviceRemovedId = this.service.connect(
                'device-removed',
                this._onDeviceRemoved.bind(this)
            );

            await this.service.start();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _initMenu() {
        // Panel/User Menu mode
        let displayMode = new Gio.PropertyAction({
            name: 'display-mode',
            property_name: 'display-mode',
            object: this
        });
        this.add_action(displayMode);

        // About Dialog
        let aboutDialog = new Gio.SimpleAction({name: 'about'});
        aboutDialog.connect('activate', this._aboutDialog.bind(this));
        this.add_action(aboutDialog);

        // "Connect to..." Dialog
        let connectDialog = new Gio.SimpleAction({name: 'connect'});
        connectDialog.connect('activate', this._connectDialog);
        this.add_action(connectDialog);

        // "Generate Support Log" GAction
        let generateSupportLog = new Gio.SimpleAction({name: 'support-log'});
        generateSupportLog.connect('activate', this._generateSupportLog);
        this.add_action(generateSupportLog);

        // "Help" GAction
        let help = new Gio.SimpleAction({name: 'help'});
        help.connect('activate', this._help);
        this.add_action(help);
    }

    _refresh() {
        if (this.device_list.get_children().length < 1) {
            this.device_list_spinner.active = true;
            this.application.activate_action('broadcast', null);
        } else {
            this.device_list_spinner.active = false;
        }

        return GLib.SOURCE_CONTINUE;
    }

    _restoreGeometry() {
        if (this._mutterSettings === undefined) {
            this._mutterSettings = new Gio.Settings({
                schema_id: 'org.gnome.mutter'
            });
        }

        // Restore geometry, even if we're going to maximize
        let [width, height] = this.settings.get_value('window-size').deep_unpack();
        this.set_default_size(width, height);

        // Respect mutter's settings
        if (!this._mutterSettings.get_boolean('center-new-windows')) {
            let [x, y] = this.settings.get_value('window-position').deep_unpack();
            this.move(x, y);
        }

        // Maximize if set
        if (this.settings.get_boolean('window-maximized'))
            this.maximize();
    }

    _saveGeometry() {
        let state = this.get_window().get_state();

        // Maximized State
        let maximized = (state & Gdk.WindowState.MAXIMIZED);
        this.settings.set_boolean('window-maximized', maximized);

        // Leave the size and position at the values before maximizing
        if (maximized || (state & Gdk.WindowState.FULLSCREEN))
            return;

        // Save the size and position
        let size = this.get_size();
        this.settings.set_value('window-size', new GLib.Variant('(ii)', size));

        let position = this.get_position();
        this.settings.set_value('window-position', new GLib.Variant('(ii)', position));
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
                    'Frank Dana <ferdnyc@gmail.com>'
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
                version: `${gsconnect.metadata.version}`,
                website: gsconnect.metadata.url,
                license_type: Gtk.License.GPL_2_0,
                modal: true,
                transient_for: this
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
        new ConnectDialog(Gio.Application.get_default()._window);
    }

    /**
     * "Generate Support Log" GAction
     */
    _generateSupportLog() {
        let dialog = new Gtk.MessageDialog({
            text: _('Generate Support Log'),
            secondary_text: _('Debug messages are being logged. Take any steps necessary to reproduce a problem then review the log.')
        });
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Review Log'), Gtk.ResponseType.OK);

        // Enable debug logging and mark the current time
        gsconnect.settings.set_boolean('debug', true);
        let now = GLib.DateTime.new_now_local().format('%R');

        dialog.connect('response', (dialog, response_id) => {
            // Disable debug logging and destroy the dialog
            gsconnect.settings.set_boolean('debug', false);
            dialog.destroy();

            // Only generate a log if instructed
            if (response_id === Gtk.ResponseType.OK) {
                generateSupportLog(now);
            }
        });

        dialog.show_all();
    }

    /**
     * "Help" GAction
     */
    _help(action, parameter) {
        let uri = 'https://github.com/andyholmes/gnome-shell-extension-gsconnect';
        uri += '/wiki/Help';
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    /**
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        // HeaderBar (Service)
        this.prev_button.visible = false;
        this.device_menu.visible = false;

        this.service_refresh.visible = true;
        this.service_edit.visible = true;
        this.service_menu.visible = true;

        this.headerbar.title = gsconnect.settings.get_string('name');
        this.headerbar.subtitle = null;

        // Panel
        this.stack.visible_child_name = 'service';
        this._setDeviceMenu();
    }

    _onEditServiceName(button, event) {
        this.service_entry.text = this.headerbar.title;
    }

    _onUnfocusServiceName(entry, event) {
        this.service_edit.active = false;
        return false;
    }

    _onSetServiceName(button, event) {
        if (this.service_entry.text.length) {
            this.headerbar.title = this.service_entry.text;
            gsconnect.settings.set_string('name', this.service_entry.text);
        }

        this.service_edit.active = false;
    }

    /**
     * Context Switcher
     */
    _setDeviceMenu(panel = null) {
        this.device_menu.insert_action_group('device', null);
        this.device_menu.insert_action_group('settings', null);
        this.device_menu.set_menu_model(null);

        if (panel) {
            this.device_menu.insert_action_group('device', panel.device.action_group);
            this.device_menu.insert_action_group('settings', panel.actions);
            this.device_menu.set_menu_model(panel.menu);
        }
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
            visible: true
        });
        row.set_name(device.id);

        let grid = new Gtk.Grid({
            column_spacing: 12,
            margin_left: 20,
            margin_right: 20,
            margin_bottom: 8,
            margin_top: 8,
            visible: true
        });
        row.add(grid);

        let icon = new Gtk.Image({
            gicon: new Gio.ThemedIcon({name: `${device.icon_name}-symbolic`}),
            icon_size: Gtk.IconSize.BUTTON,
            visible: true
        });
        grid.attach(icon, 0, 0, 1, 1);

        let title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        device.settings.bind('name', title, 'label', 0);
        grid.attach(title, 1, 0, 1, 1);

        let status = new Gtk.Label({
            halign: Gtk.Align.END,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        grid.attach(status, 2, 0, 1, 1);

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
                let prefs = new Device.DevicePreferences(device);
                this.stack.add_titled(prefs, device.id, device.name);

                // Add a row to the device list
                prefs.row = this._createDeviceRow(device);
                this.device_list.add(prefs.row);
            }
        } catch (e) {
            logError (e);
        }
    }

    _onDeviceRemoved(service, device) {
        try {
            let prefs = this.stack.get_child_by_name(device.id);

            if (prefs !== null) {
                if (prefs === this.stack.get_visible_child()) {
                    this._onPrevious();
                }

                prefs.row.destroy();
                prefs.row = null;

                prefs.dispose();
                prefs.destroy();
            }
        } catch (e) {
            logError (e);
        }
    }

    _onDeviceSelected(box, row) {
        try {
            if (row === null) {
                this._onPrevious();
                return;
            }

            // Transition the panel
            let name = row.get_name();
            let prefs = this.stack.get_child_by_name(name);

            this.stack.visible_child = prefs;
            this._setDeviceMenu(prefs);

            // HeaderBar (Device)
            this.service_refresh.visible = false;
            this.service_edit.visible = false;
            this.service_menu.visible = false;

            this.prev_button.visible = true;
            this.device_menu.visible = true;

            this.headerbar.title = prefs.device.name;
            this.headerbar.subtitle = prefs.device.display_type;
        } catch (e) {
            logError(e);
        }
    }
});

