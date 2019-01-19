'use strict';

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Device = imports.service.ui.device;


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

        open_uri(file.get_uri());
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

        if (this._devicesId) {
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
        'service-menu', 'service-refresh', 'service-edit', 'service-entry',
        'device-menu', 'prev-button',

        'service-window', 'service-box', 'info-label',

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

        // HeaderBar (Service Name)
        this.headerbar.title = gsconnect.settings.get_string('public-name');
        this.service_entry.text = this.headerbar.title;

        // Scroll with keyboard focus
        this.service_box.set_focus_vadjustment(this.service_window.vadjustment);

        // Downloads link; Account for some corner cases with a fallback
        let download_dir = GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_DOWNLOAD
        );

        if (!download_dir || download_dir === GLib.get_home_dir()) {
            download_dir = GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        }

        // TRANSLATORS: Description of where directly shared files are stored.
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
        this.device_list.set_header_func((row, before) => {
            if (before) row.set_header(new Gtk.Separator({visible: true}));
        });
        this.device_list.set_placeholder(this.device_list_placeholder);

        // Setup devices
        this._devicesChangedId = gsconnect.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();

        // If there are no devices, it's safe to auto-broadcast
        this._refresh();
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
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        // HeaderBar (Service)
        this.prev_button.visible = false;
        this.device_menu.visible = false;

        this.service_refresh.visible = true;
        this.service_edit.visible = true;
        this.service_menu.visible = true;

        this.headerbar.title = gsconnect.settings.get_string('public-name');
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
            gsconnect.settings.set_string('public-name', this.service_entry.text);
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
        this.stack.visible_child_name = name;
        this._setDeviceMenu(this.stack.visible_child);

        // HeaderBar (Device)
        this.service_refresh.visible = false;
        this.service_edit.visible = false;
        this.service_menu.visible = false;

        this.prev_button.visible = true;
        this.device_menu.visible = true;

        this.headerbar.title = panel.device.name;
        this.headerbar.subtitle = panel.device.display_type;
    }

    _onDevicesChanged() {
        try {
            for (let id of this.application.devices) {
                if (!this.stack.get_child_by_name(id)) {
                    this.addDevice(id);
                }
            }

            this.stack.foreach(panel => {
                let id = panel.get_name();

                if (id !== 'service' && !this.application.devices.includes(id)) {
                    if (this.stack.visible_child === panel) {
                        this._onPrevious();
                    }

                    panel._destroy();
                    panel.destroy();
                }
            });

            this.device_list.foreach(row => {
                if (!this.application.devices.includes(row.get_name())) {
                    // HACK: temporary mitigator for mysterious GtkListBox leak
                    //row.destroy();
                    row.run_dispose();
                    imports.system.gc();
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    addDevice(id) {
        let device = this.application._devices.get(id);

        // Add the device settings to the content stack
        this.stack.add_titled(new Device.DevicePreferences(device), id, device.name);
        this.device_list.add(new DeviceRow(device));
    }
});

