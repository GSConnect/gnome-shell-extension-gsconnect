'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Keybindings = imports.service.ui.keybindings;


// Header for support logs
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

        let proc = new Gio.Subprocess({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
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

        await new Promise((resolve, reject) => {
            Gio.AppInfo.launch_default_for_uri_async(file.get_uri(), null, null, (src, res) => {
                try {
                    resolve(Gio.AppInfo.launch_default_for_uri_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        logError(e);
    }
}


function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({visible: true}));
    }
}


/**
 * A row for a section of settings
 */
var SectionRow = GObject.registerClass({
    GTypeName: 'GSConnectSectionRow'
}, class SectionRow extends Gtk.ListBoxRow {

    _init(params) {
        super._init({
            height_request: 56,
            selectable: false,
            visible: true
        });

        let grid = new Gtk.Grid({
            column_spacing: 12,
            margin_top: 8,
            margin_right: 12,
            margin_bottom: 8,
            margin_left: 12,
            visible: true
        });
        this.add(grid);

        // Row Icon
        this._icon = new Gtk.Image({
            pixel_size: 32
        });
        grid.attach(this._icon, 0, 0, 1, 2);

        // Row Title
        this._title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        grid.attach(this._title, 1, 0, 1, 1);

        // Row Subtitle
        this._subtitle = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        this._subtitle.get_style_context().add_class('dim-label');
        grid.attach(this._subtitle, 1, 1, 1, 1);

        Object.assign(this, params);
    }

    get icon() {
        return this._icon.gicon;
    }

    set icon(gicon) {
        this._icon.visible = (gicon);
        this._icon.gicon = gicon;
    }

    get icon_name() {
        return this._icon.icon_name;
    }

    set icon_name(text) {
        this._icon.visible = (text);
        this._icon.icon_name = text;
    }

    get title() {
        return this._title.label;
    }

    set title(text) {
        this._title.visible = (text);
        this._title.label = text;
    }

    get subtitle() {
        return this._subtitle.label;
    }

    set subtitle(text) {
        this._subtitle.visible = (text);
        this._subtitle.label = text;
    }

    get widget() {
        return this._widget;
    }

    set widget(widget) {
        if (this._widget && this._widget instanceof Gtk.Widget) {
            this._widget.destroy();
            this._widget = null;
        }

        this._widget = widget;
        this.get_child().attach(this.widget, 2, 0, 1, 2);
    }
});


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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/connect.ui',
    Children: [
        'cancel-button', 'connect-button',
        'lan-radio', 'lan-grid', 'lan-ip', 'lan-port',
        'bluez-radio', 'bluez-grid', 'bluez-device', 'bluez-devices'
    ]
}, class ConnectDialog extends Gtk.Dialog {

    _init(parent = null) {
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
                    address = this.bluez_device.active_id;

                // Lan host/port entered
                } else if (this.lan_ip.text) {
                    address = Gio.InetSocketAddress.new_from_string(
                        this.lan_ip.text,
                        this.lan_port.value
                    );
                } else {
                    return false;
                }

                this.application.broadcast(address);
            } catch (e) {
                logError(e);
            }
        }

        if (this._deviceId) {
            this.application.bluetooth.disconnect(this._devicesId);
        }

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


/**
 * A Device Row
 */
const DeviceRow = GObject.registerClass({
    GTypeName: 'GSConnectDeviceRow',
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'deviceConnected',
            'Whether the device is connected',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'paired': GObject.ParamSpec.boolean(
            'paired',
            'devicePaired',
            'Whether the device is paired',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'status': GObject.ParamSpec.string(
            'status',
            'Device Status',
            'The status of the device',
            GObject.ParamFlags.READWRITE,
            null
        )
    }
}, class GSConnectDeviceRow extends Gtk.ListBoxRow {

    _init(device) {
        super._init({
            height_request: 52,
            selectable: false
        });

        this.set_name(device.id);
        this.device = device;

        let grid = new Gtk.Grid({
            column_spacing: 12,
            margin_left: 20, // 20
            margin_right: 20,
            margin_bottom: 8, // 16
            margin_top: 8
        });
        this.add(grid);

        let icon = new Gtk.Image({
            gicon: new Gio.ThemedIcon({name: `${this.device.icon_name}-symbolic`}),
            icon_size: Gtk.IconSize.BUTTON
        });
        grid.attach(icon, 0, 0, 1, 1);

        let title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        device.settings.bind('name', title, 'label', 0);
        grid.attach(title, 1, 0, 1, 1);

        let status = new Gtk.Label({
            halign: Gtk.Align.END,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        this.bind_property('status', status, 'label', 2);
        grid.attach(status, 2, 0, 1, 1);

        this.connect('notify::connected', () => this.notify('status'));
        device.bind_property('connected', this, 'connected', 2);
        this.connect('notify::paired', () => this.notify('status'));
        device.bind_property('paired', this, 'paired', 2);

        this.show_all();
    }

    get status() {
        if (!this.paired) {
            return _('Unpaired');
        } else if (!this.connected) {
            return _('Disconnected');
        }

        return _('Connected');
    }
});


var Window = GObject.registerClass({
    GTypeName: 'GSConnectSettingsWindow',
    Properties: {
        'display-mode': GObject.ParamSpec.string(
            'display-mode',
            'Display Mode',
            'Display devices in either the Panel or User Menu',
            GObject.ParamFlags.READWRITE,
            null
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/settings.ui',
    Children: [
        // HeaderBar
        'headerbar', 'infobar', 'stack',
        'device-headerbar', 'device-menu',
        'service-headerbar', 'service-menu', 'service-edit', 'service-entry',
        'prev-button',

        // TODO: Info label
        'info-label',

        // Device List
        'device-list', 'device-list-spinner', 'device-list-placeholder'
    ]
}, class SettingsWindow extends Gtk.ApplicationWindow {

    _init(params) {
        this.connect_template();

        super._init({
            application: Gio.Application.get_default(),
            title: _('Settings')
        });

        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Preferences',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/preferences/'
        });

        gsconnect.settings.bind(
            'discoverable',
            this.infobar,
            'reveal-child',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );

        // Service Name
        gsconnect.settings.bind(
            'public-name',
            this.service_headerbar,
            'title',
            Gio.SettingsBindFlags.DEFAULT
        );
        this.service_entry.text = this.service_headerbar.title;

        // Downloads link
        let download_dir = GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_DOWNLOAD
        );

        // Account for some corner cases with a fallback
        if (!download_dir || download_dir === GLib.get_home_dir()) {
            download_dir = GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        }

        this.info_label.label = _('Transferred files are placed in the <a href="%s">Downloads</a> folder.').format(
            'file://' + download_dir
        );

        //
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

        // App Menu (in-window only)
        this.service_menu.set_menu_model(
            this.application.get_menu_by_id('service-menu')
        );

        // Device List
        this.device_list.set_header_func(section_separators);
        this.device_list.set_placeholder(this.device_list_placeholder);

        // Setup devices
        this._devicesChangedId = gsconnect.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();

        // If there are no devices, it's safe to auto-broadcast
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, this._refresh.bind(this));

        // Restore window size/maximized/position
        this.restore_geometry();
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
        this.save_geometry();
        return this.hide_on_delete();
    }

    _refresh() {
        if (this.application.devices.length < 1 && this.stack.visible_child_name === 'service') {
            this.application.broadcast();
            this.device_list_spinner.active = true;
        } else {
            this.device_list_spinner.active = false;
        }

        return GLib.SOURCE_CONTINUE;
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
                    gsconnect.app_path + '/icons/' + gsconnect.app_id + '.svg',
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
            this._about.connect(
                'delete-event',
                () => this._about.hide_on_delete()
            );
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
            text: _('Debug Logging Enabled'),
            secondary_text: _('Reproduce the problem and press “Done” to review the log.')
        });
        dialog.set_keep_above(true);
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Done'), Gtk.ResponseType.OK);

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
     * Badges
     */
    _onLinkButton(button) {
        try {
            Gtk.show_uri_on_window(this, button.tooltip_text, Gdk.CURRENT_TIME);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        this.headerbar.visible_child_name = 'service';
        this.stack.visible_child_name = 'service';
        this._setDeviceMenu();
    }

    _onEditServiceName(button, event) {
        this.service_entry.text = this.service_headerbar.title;
    }

    _onUnfocusServiceName(entry, event) {
        this.service_edit.active = false;
        return false;
    }

    _onSetServiceName(button, event) {
        if (this.service_entry.text.length) {
            this.service_headerbar.title = this.service_entry.text;
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
            this.device_menu.insert_action_group('device', panel.device);
            this.device_menu.insert_action_group('settings', panel.actions);
            this.device_menu.set_menu_model(panel.menu);
        }
    }

    _onDeviceSelected(box, row) {
        let name = (typeof box === 'string') ? box : row.get_name();

        // Transition the panel
        let panel = this.stack.get_child_by_name(name);
        this._setDeviceMenu(panel);
        this.stack.visible_child_name = name;

        // Transition the headerbar
        this.device_headerbar.title = panel.device.name;
        this.device_headerbar.subtitle = panel.device.display_type;
        this.headerbar.visible_child_name = 'device';
    }

    _onDevicesChanged() {
        try {
            for (let id of this.application.devices) {
                if (!this.stack.get_child_by_name(id)) {
                    this.addDevice(id);
                }
            }

            this.stack.foreach(child => {
                if (child.row) {
                    let id = child.row.get_name();

                    if (!this.application.devices.includes(id)) {
                        if (this.stack.visible_child_name === id) {
                            this._onPrevious();
                        }

                        let panel = this.stack.get_child_by_name(id);
                        panel._destroy();
                        panel.destroy();
                    }
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    addDevice(id) {
        let device = this.application._devices.get(id);

        // Add the device settings to the content stack
        this.stack.add_titled(new DevicePreferences(device), id, device.name);
        this.device_list.add(new DeviceRow(device));
    }
});


var DevicePreferences = GObject.registerClass({
    GTypeName: 'GSConnectDevicePreferences',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/device.ui',
    Children: [
        'sidebar', 'stack', 'infobar',
        // Sharing
        'sharing-list',
        'clipboard', 'clipboard-sync', 'mousepad', 'mpris', 'systemvolume',
        // RunCommand
        'runcommand', 'command-list',
        'command-toolbar', 'command-add', 'command-remove', 'command-edit',
        'command-editor', 'command-name', 'command-line',
        // Notifications
        'notification', 'notification-apps',
        // Telephony
        'telephony',
        'ringing-list', 'ringing-volume', 'talking-list', 'talking-volume',
        // Shortcuts
        'shortcuts-actions', 'shortcuts-actions-title', 'shortcuts-actions-list',
        'shortcuts-commands', 'shortcuts-commands-title', 'shortcuts-commands-list',
        // Advanced
        'plugin-list', 'danger-list'
    ]
}, class DevicePreferences extends Gtk.Grid {

    _init(device) {
        this.connect_template();

        super._init();

        this.device = device;
        this._menus = Gtk.Builder.new_from_resource(gsconnect.app_path + '/gtk/menus.ui');
        this._menus.translation_domain = 'org.gnome.Shell.Extensions.GSConnect';

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup('org.gnome.Shell.Extensions.GSConnect.Device', true),
            path: '/org/gnome/shell/extensions/gsconnect/device/' + this.device.id + '/'
        });

        // Infobar
        this.settings.bind(
            'paired',
            this.infobar,
            'reveal-child',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN
        );

        this._setupActions();

        // Device Menu
        this.menu = this._menus.get_object('device-menu');
        this.menu.prepend_section(null, this.device.menu);

        this.insert_action_group('device', this.device);

        // Settings Pages
        this._sharingSettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._telephonySettings();
        // --------------------------
        this._keybindingSettings();
        this._advancedSettings();

        // Separate plugins and other settings
        this.sidebar.set_header_func((row, before) => {
            if (row.get_name() === 'shortcuts') {
                row.set_header(new Gtk.Separator({visible: true}));
            }
        });

        // Action Changes
        this._actionAddedId = this.device.connect(
            'action-added',
            this._onActionsChanged.bind(this)
        );
        this._actionRemovedId = this.device.connect(
            'action-removed',
            this._onActionsChanged.bind(this)
        );
        this._actionEnabledId = this.device.connect(
            'action-enabled-changed',
            this._onActionsChanged.bind(this)
        );

        // Connected/Paired
        this._bluetoothHostChangedId = this.settings.connect(
            'changed::bluetooth-host',
            this._onBluetoothHostChanged.bind(this)
        );

        this._tcpHostChangedId = this.settings.connect(
            'changed::tcp-host',
            this._onTcpHostChanged.bind(this)
        );

        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );
        this._onConnected(this.device);

        // Hide elements for any disabled plugins
        for (let name of this.settings.get_strv('supported-plugins')) {
            if (this.hasOwnProperty(name)) {
                this[name].visible = this.get_plugin_allowed(name);
            }
        }
    }

    get service() {
        return Gio.Application.get_default();
    }

    get supported_plugins() {
        let supported = this.settings.get_strv('supported-plugins');

        // Preempt 'mousepad' plugin on Wayland
        if (_WAYLAND) supported.splice(supported.indexOf('mousepad'), 1);

        return supported;
    }

    _onActionsChanged() {
        this._populateActionKeybindings();
    }

    _onSwitcherRowSelected(box, row) {
        this.stack.set_visible_child_name(row.get_name());
    }

    _onToggleRowActivated(box, row) {
        let widget = row.get_child().get_child_at(1, 0);
        widget.active = !widget.active;
    }

    _onConnected(device) {
        this._onTcpHostChanged();
        this._onBluetoothHostChanged();
    }

    _onBluetoothHostChanged() {
        let action = this.actions.lookup_action('connect-bluetooth');
        let hasBluetooth = (this.settings.get_string('bluetooth-host').length);
        let isLan = (this.settings.get_string('last-connection') === 'tcp');

        action.enabled = (isLan && hasBluetooth);
    }

    _onActivateBluetooth() {
        this.settings.set_string('last-connection', 'bluetooth');
        this.device.activate();
    }

    _onTcpHostChanged() {
        let action = this.actions.lookup_action('connect-tcp');
        let hasLan = (this.settings.get_string('tcp-host').length);
        let isBluetooth = (this.settings.get_string('last-connection') === 'bluetooth');

        action.enabled = (isBluetooth && hasLan);
    }

    _onActivateLan() {
        this.settings.set_string('last-connection', 'tcp');
        this.device.activate();
    }

    _onEncryptionInfo() {
        let dialog = new Gtk.MessageDialog({
            buttons: Gtk.ButtonsType.OK,
            text: _('Encryption Info'),
            secondary_text: this.device.encryption_info,
            modal: true,
            transient_for: this.get_toplevel()
        });
        dialog.connect('response', (dialog) => dialog.destroy());
        dialog.present();
    }

    _onDeleteDevice(button) {
        let application = Gio.Application.get_default();
        application.deleteDevice(this.device.id);
    }

    _destroy() {
        this.disconnect_template();

        this.device.disconnect(this._actionAddedId);
        this.device.disconnect(this._actionRemovedId);
        this.device.disconnect(this._actionEnabledId);
        this.device.disconnect(this._connectedId);

        this.settings.disconnect(this._bluetoothHostChangedId);
        this.settings.disconnect(this._tcpHostChangedId);
        this.settings.disconnect(this._keybindingsId);
        this.settings.disconnect(this._pluginsId);
    }

    _getSettings(name) {
        if (this._gsettings === undefined) {
            this._gsettings = {};
        }

        if (this._gsettings.hasOwnProperty(name)) {
            return this._gsettings[name];
        }

        let meta = imports.service.plugins[name].Metadata;

        this._gsettings[name] = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(meta.id, -1),
            path: this.settings.path + 'plugin/' + name + '/'
        });

        return this._gsettings[name];
    }

    _setupActions() {
        this.actions = new Gio.SimpleActionGroup();
        this.insert_action_group('settings', this.actions);

        let settings = this._getSettings('battery');
        this.actions.add_action(settings.create_action('send-statistics'));

        settings = this._getSettings('clipboard');
        this.actions.add_action(settings.create_action('send-content'));
        this.actions.add_action(settings.create_action('receive-content'));
        this.clipboard_sync.set_menu_model(this._menus.get_object('clipboard-sync'));

        settings = this._getSettings('mousepad');
        this.actions.add_action(settings.create_action('share-control'));

        settings = this._getSettings('mpris');
        this.actions.add_action(settings.create_action('share-players'));

        settings = this._getSettings('notification');
        this.actions.add_action(settings.create_action('send-notifications'));

        settings = this._getSettings('systemvolume');
        this.actions.add_action(settings.create_action('share-sinks'));

        settings = this._getSettings('telephony');
        this.actions.add_action(settings.create_action('ringing-volume'));
        this.actions.add_action(settings.create_action('ringing-pause'));
        this.ringing_volume.set_menu_model(this._menus.get_object('ringing-volume'));

        this.actions.add_action(settings.create_action('talking-volume'));
        this.actions.add_action(settings.create_action('talking-pause'));
        this.actions.add_action(settings.create_action('talking-microphone'));
        this.talking_volume.set_menu_model(this._menus.get_object('talking-volume'));

        // Connect Actions
        let status_bluetooth = new Gio.SimpleAction({name: 'connect-bluetooth'});
        status_bluetooth.connect('activate', this._onActivateBluetooth.bind(this));
        this.actions.add_action(status_bluetooth);

        let status_lan = new Gio.SimpleAction({name: 'connect-tcp'});
        status_lan.connect('activate', this._onActivateLan.bind(this));
        this.actions.add_action(status_lan);

        // Pair Actions
        let encryption_info = new Gio.SimpleAction({name: 'encryption-info'});
        encryption_info.connect('activate', this._onEncryptionInfo.bind(this));
        this.actions.add_action(encryption_info);

        let status_pair = new Gio.SimpleAction({name: 'pair'});
        status_pair.connect('activate', this.device.pair.bind(this.device));
        this.settings.bind('paired', status_pair, 'enabled', 16);
        this.actions.add_action(status_pair);

        let status_unpair = new Gio.SimpleAction({name: 'unpair'});
        status_unpair.connect('activate', this.device.unpair.bind(this.device));
        this.settings.bind('paired', status_unpair, 'enabled', 0);
        this.actions.add_action(status_unpair);
    }

    /**
     * Sharing Settings
     */
    _sharingSettings() {
        this.sharing_list.foreach(row => {
            let name = row.get_name();
            row.visible = this.device.get_outgoing_supported(`${name}.request`);

            // Extra check for battery reporting
            if (name === 'battery') {
                row.visible = row.visible && this.service.type === 'laptop';
            }
        });

        // Separators & Sorting
        this.sharing_list.set_header_func(section_separators);

        this.sharing_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
    }

    /**
     * RunCommand Page
     */
    _runcommandSettings() {
        // Exclusively enable the editor or add button
        this.command_editor.bind_property(
            'visible',
            this.command_add,
            'sensitive',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Local Command List
        let settings = this._getSettings('runcommand');
        this._commands = settings.get_value('command-list').full_unpack();
        this._commands = (typeof this._commands === 'string') ? {} : this._commands;

        let placeholder = new Gtk.Image({
            icon_name: 'system-run-symbolic',
            hexpand: true,
            halign: Gtk.Align.CENTER,
            margin: 12,
            pixel_size: 32,
            visible: true
        });
        placeholder.get_style_context().add_class('dim-label');

        this.command_list.set_placeholder(placeholder);
        this.command_list.set_sort_func(this._commandSortFunc);
        this.command_list.set_header_func(section_separators);

        this._populateCommands();
    }

    _commandSortFunc(row1, row2) {
        if (!row1.title || !row2.title) {
            return 0;
        }

        return row1.title.localeCompare(row2.title);
    }

    _insertCommand(uuid) {
        let row = new SectionRow({
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            selectable: true
        });
        row.set_name(uuid);
        row._subtitle.ellipsize = Pango.EllipsizeMode.MIDDLE;

        this.command_list.add(row);

        return row;
    }

    _onCommandSelected(box) {
        let selected = (box.get_selected_row() !== null);
        this.command_edit.sensitive = selected;
        this.command_remove.sensitive = selected;
    }

    // The [+] button in the toolbar
    _onAddCommand(button) {
        let uuid = GLib.uuid_string_random();
        this._commands[uuid] = {name: '', command: ''};

        let row = this._insertCommand(uuid);
        this.command_list.select_row(row);
        this._onEditCommand();
    }

    // The [-] button in the toolbar
    _onRemoveCommand(button) {
        let row = this.command_list.get_selected_row();
        delete this._commands[row.get_name()];

        this._getSettings('runcommand').set_value(
            'command-list',
            GLib.Variant.full_pack(this._commands)
        );

        this._populateCommands();
    }

    // The 'edit'/'save' icon in the toolbar
    _onEditCommand(button) {
        let row = this.command_list.get_selected_row();
        let uuid = row.get_name();

        // The editor is open so we're being asked to save
        if (this.command_editor.visible) {
            if (this.command_name.text && this.command_line.text) {
                this._commands[uuid] = {
                    name: this.command_name.text,
                    command: this.command_line.text
                };
            } else {
                delete this._commands[uuid];
            }

            this._getSettings('runcommand').set_value(
                'command-list',
                GLib.Variant.full_pack(this._commands)
            );

            this._populateCommands();

        // The editor is closed so we're being asked to edit
        } else {
            this.command_editor.uuid = uuid;
            this.command_name.text = this._commands[uuid].name;
            this.command_line.text = this._commands[uuid].command;

            this.command_edit.get_child().icon_name = 'document-save-symbolic';

            row.visible = false;
            this.command_editor.visible = true;
            this.command_name.has_focus = true;

            this.command_list.foreach(child => {
                child.sensitive = (child === this.command_editor);
            });
        }
    }

    // The 'folder' icon in the command editor GtkEntry
    _onBrowseCommand(entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type('application/x-executable');

        let dialog = new Gtk.FileChooserDialog({filter: filter});
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Open'), Gtk.ResponseType.OK);

        dialog.connect('response', (dialog, response_id) => {
            if (response_id === Gtk.ResponseType.OK) {
                this.command_line.text = dialog.get_filename();
            }

            dialog.destroy();
        });

        dialog.show_all();
    }

    async _populateCommands() {
        delete this.command_editor.uuid;
        this.command_name.text = '';
        this.command_line.text = '';
        this.command_edit.get_child().icon_name = 'document-edit-symbolic';
        this.command_editor.visible = false;

        this.command_list.foreach(row => {
            if (row !== this.command_editor) {
                row.destroy();
            }
        });

        Object.keys(this._commands).map(uuid => this._insertCommand(uuid));
    }

    /**
     * Notification Settings
     */
    _notificationSettings() {
        let settings = this._getSettings('notification');

        settings.bind(
            'send-notifications',
            this.notification_apps,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        this.notification_apps.set_sort_func((row1, row2) => {
            return row1.title.localeCompare(row2.title);
        });
        this.notification_apps.set_header_func(section_separators);

        this._populateApplications(settings);
    }

    _onNotificationRowActivated(box, row) {
        let settings = this._getSettings('notification');
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        applications[row.title].enabled = !applications[row.title].enabled;
        row.widget.label = applications[row.title].enabled ? _('On') : _('Off');
        settings.set_string('applications', JSON.stringify(applications));
    }

    _populateApplications(settings) {
        let applications = this._queryApplications(settings);

        for (let name in applications) {
            let row = new SectionRow({
                icon: Gio.Icon.new_for_string(applications[name].iconName),
                title: name,
                height_request: 48,
                widget: new Gtk.Label({
                    label: applications[name].enabled ? _('On') : _('Off'),
                    margin_end: 12,
                    halign: Gtk.Align.END,
                    hexpand: true,
                    valign: Gtk.Align.CENTER,
                    vexpand: true,
                    visible: true
                })
            });

            this.notification_apps.add(row);
        }
    }

    // TODO: move to components/notification.js
    _queryApplications(settings) {
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        let appInfos = [];
        let ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

        // Query GNOME's notification settings
        for (let appSettings of Object.values(this.service.notification.applications)) {
            let appId = appSettings.get_string('application-id');

            if (appId !== ignoreId) {
                let appInfo = Gio.DesktopAppInfo.new(appId);

                if (appInfo) {
                    appInfos.push(appInfo);
                }
            }
        }

        // Scan applications that statically declare to show notifications
        // TODO: if g-s-d does this already, maybe we don't have to
        for (let appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_id() !== ignoreId &&
                appInfo.get_boolean('X-GNOME-UsesNotifications')) {
                appInfos.push(appInfo);
            }
        }

        // Update GSettings
        for (let appInfo of appInfos) {
            let appName = appInfo.get_name();

            if (appName && !applications[appName]) {
                let icon = appInfo.get_icon();
                icon = (icon) ? icon.to_string() : 'application-x-executable';

                applications[appName] = {
                    iconName: icon,
                    enabled: true
                };
            }
        }

        settings.set_string('applications', JSON.stringify(applications));

        return applications;
    }

    /**
     * Telephony Settings
     */
    _telephonySettings() {
        this.ringing_list.set_header_func(section_separators);
        this.talking_list.set_header_func(section_separators);
    }

    /**
     * Keyboard Shortcuts
     */
    _keybindingSettings() {
        this._keybindingsId = this.settings.connect(
            'changed::keybindings',
            this._populateKeybindings.bind(this)
        );

        this.shortcuts_actions_list.set_header_func(section_separators);
        this.shortcuts_actions_list.set_sort_func((row1, row2) => {
            return row1.title.localeCompare(row2.title);
        });

        this.shortcuts_commands_list.set_header_func(section_separators);
        this.shortcuts_commands_list.set_sort_func((row1, row2) => {
            return row1.title.localeCompare(row2.title);
        });

        this._populateKeybindings();
    }

    _populateKeybindings() {
        if (this.device.list_actions().length === 0) {
            return;
        }

        this._populateActionKeybindings();
        this._populateCommandKeybindings();
    }

    _addActionKeybinding(name, keybindings) {
        if (this.device.get_action_parameter_type(name) !== null) return;
        if (!this.device.get_action_enabled(name)) return;

        let [label, icon_name] = this.device.get_action_state(name).deep_unpack();

        let widget = new Gtk.Label({
            label: _('Disabled'),
            visible: true
        });
        widget.get_style_context().add_class('dim-label');

        if (keybindings[name]) {
            let accel = Gtk.accelerator_parse(keybindings[name]);
            widget.label = Gtk.accelerator_get_label(...accel);
        }

        let row = new SectionRow({
            icon: new Gio.ThemedIcon({name: icon_name}),
            title: label,
            widget: widget
        });
        row.height_request = 48;
        row._icon.pixel_size = 16;
        row.action = name;
        this.shortcuts_actions_list.add(row);
    }

    _populateActionKeybindings() {
        this.shortcuts_actions_list.foreach(row => row.destroy());

        let keybindings = this.settings.get_value('keybindings').deep_unpack();

        // TODO: Backwards compatibility; remove later
        if (typeof keybindings === 'string') {
            this.settings.set_value(
                'keybindings',
                new GLib.Variant('a{ss}', {})
            );
            // A ::changed signal should be emitted so we'll return
            return;
        }

        // TODO: Device Menu shortcut
        for (let name of this.device.list_actions().sort()) {
            try {
                this._addActionKeybinding(name, keybindings);
            } catch (e) {
                logError(e);
            }
        }
    }

    _onResetActionShortcuts(button) {
        let keybindings = this.settings.get_value('keybindings').deep_unpack();

        for (let action in keybindings) {
            if (!action.includes('::')) {
                delete keybindings[action];
            }
        }

        this.settings.set_value(
            'keybindings',
            new GLib.Variant('a{ss}', keybindings)
        );
    }

    _addCommandKeybinding(uuid, command, keybindings) {
        let action = `executeCommand::${uuid}`;

        let widget = new Gtk.Label({
            label: _('Disabled'),
            visible: true
        });
        widget.get_style_context().add_class('dim-label');

        if (keybindings[action]) {
            let accel = Gtk.accelerator_parse(keybindings[action]);
            widget.label = Gtk.accelerator_get_label(...accel);
        }

        let row = new SectionRow({
            title: command.name,
            subtitle: command.command,
            widget: widget
        });
        row.action = action;
        this.shortcuts_commands_list.add(row);
    }

    _populateCommandKeybindings() {
        this.shortcuts_commands_list.foreach(row => row.destroy());

        let keybindings = this.settings.get_value('keybindings').deep_unpack();

        // Exclude defunct commands
        for (let action in keybindings) {
            if (action.includes('::')) {
                let uuid = action.split('::')[1];

                if (!remoteCommands.hasOwnProperty(uuid)) {
                    delete keybindings[action];
                }
            }
        }

        // Commands
        let runcommand = this.device.lookup_plugin('runcommand');
        let remoteCommands = (runcommand) ? runcommand.remote_commands : {};
        let hasCommands = (Object.keys(remoteCommands).length > 0);
        this.shortcuts_commands_title.visible = hasCommands;
        this.shortcuts_commands.visible = hasCommands;

        for (let [uuid, command] of Object.entries(remoteCommands)) {
            this._addCommandKeybinding(uuid, command, keybindings);
        }

        for (let action in keybindings) {
            if (action.includes('::')) {
                let uuid = action.split('::')[1];

                if (!remoteCommands.hasOwnProperty(uuid)) {
                    delete keybindings[action];
                }
            }
        }
    }

    _onResetCommandShortcuts(button) {
        let keybindings = this.settings.get_value('keybindings').deep_unpack();

        for (let action in keybindings) {
            if (action.includes('::')) {
                delete keybindings[action];
            }
        }

        this.settings.set_value(
            'keybindings',
            new GLib.Variant('a{ss}', keybindings)
        );
    }

    async _onShortcutRowActivated(box, row) {
        try {
            let keybindings = this.settings.get_value('keybindings').deep_unpack();
            let accelerator = await Keybindings.get_accelerator(
                row.title,
                keybindings[row.action]
            );

            if (accelerator) {
                keybindings[row.action] = accelerator;
            } else {
                delete keybindings[row.action];
            }

            this.settings.set_value(
                'keybindings',
                new GLib.Variant('a{ss}', keybindings)
            );
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Advanced Page
     */
    _advancedSettings() {
        this._pluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._populatePlugins.bind(this)
        );
        this._populatePlugins();
    }

    get_plugin_allowed(name) {
        let disabled = this.settings.get_strv('disabled-plugins');
        let supported = this.supported_plugins;

        return supported.filter(name => !disabled.includes(name)).includes(name);
    }

    _addPlugin(name) {
        let widget = new Gtk.CheckButton({
            label: imports.service.plugins[name].Metadata.label,
            active: this.get_plugin_allowed(name),
            tooltip_text: name,
            valign: Gtk.Align.CENTER,
            visible: true
        });
        this.plugin_list.add(widget);

        widget._togglePluginId = widget.connect(
            'notify::active',
            this._togglePlugin.bind(this)
        );
    }

    _populatePlugins() {
        this.plugin_list.foreach(row => {
            let checkbutton = row.get_child();
            checkbutton.disconnect(checkbutton._togglePluginId);
            row.destroy();
        });

        for (let name of this.supported_plugins) {
            this._addPlugin(name);
        }
    }

    _togglePlugin(widget) {
        try {
            let name = widget.tooltip_text;
            let disabled = this.settings.get_strv('disabled-plugins');

            if (disabled.includes(name)) {
                disabled.splice(disabled.indexOf(name), 1);
            } else {
                disabled.push(name);
            }

            this.settings.set_strv('disabled-plugins', disabled);

            if (this.hasOwnProperty(name)) {
                this[name].visible = !disabled.includes(name);
            }
        } catch (e) {
            logError(e);
        }
    }
});

