'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Keybindings = imports.service.ui.keybindings;


// Python3 mini-script to check for nautilus-python support
const NAUTILUS = `
import ctypes
import ctypes.util

path = ctypes.util.find_library('libgobject-2.0.so.0')
ctypes.cdll.LoadLibrary(path)

path = ctypes.util.find_library('libnautilus-python.so')
ctypes.cdll.LoadLibrary(path)
`;


function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({visible: true}));
    }
}


/**
 * A row for a stack sidebar
 */
var DeviceRow = GObject.registerClass({
    GTypeName: 'GSConnectSettingsDeviceRow',
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
        'symbolic-icon': GObject.ParamSpec.object(
            'symbolic-icon',
            'Symbolic Icon',
            'Icon representing the device type and state',
            GObject.ParamFlags.READWRITE,
            Gio.Icon
        )
    }
}, class GSConnectSettingsDeviceRow extends Gtk.ListBoxRow {

    _init(device) {
        super._init({
            selectable: true,
            visible: true
        });

        this.set_name(device.id);
        this.device = device;
        this.type = 'device';

        let grid = new Gtk.Grid({
            orientation: Gtk.Orientation.HORIZONTAL,
            column_spacing: 12,
            margin_left: 8,
            margin_right: 8,
            margin_bottom: 12,
            margin_top: 12,
            visible: true
        });
        this.add(grid);

        let icon = new Gtk.Image({
            pixel_size: 16,
            visible: true
        });
        this.bind_property('symbolic-icon', icon, 'gicon', 2);
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

        // A '>' image for rows that are like submenus
        let go_next = new Gtk.Image({
            icon_name: 'go-next-symbolic',
            pixel_size: 16,
            halign: Gtk.Align.END,
            visible: true
        });
        go_next.get_style_context().add_class('dim-label');
        grid.attach(go_next, 2, 0, 1, 1);

        this.connect('notify::connected', () => this.notify('symbolic-icon'));
        device.bind_property('connected', this, 'connected', 2);
        this.connect('notify::paired', () => this.notify('symbolic-icon'));
        device.bind_property('paired', this, 'paired', 2);
    }

    get symbolic_icon() {
        let name = `${this.device.icon_name}-symbolic`;

        if (!this.paired) {
            let rgba = new Gdk.RGBA({red: 0.95, green: 0, blue: 0, alpha: 0.9});
            let info = Gtk.IconTheme.get_default().lookup_icon(name, 16, 0);
            return info.load_symbolic(rgba, null, null, null)[0];
        }

        this.get_child().get_child_at(0, 0).opacity = this.connected ? 1 : 0.5;

        return new Gio.ThemedIcon({name: name});
    }
});


/**
 * A row for a section of settings
 */
var SectionRow = GObject.registerClass({
    GTypeName: 'GSConnectSectionRow'
}, class SectionRow extends Gtk.ListBoxRow {

    _init(params) {
        super._init({
            activatable: false,
            selectable: false,
            height_request: 56,
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
        }

        this._widget = widget;
        this.get_child().attach(this.widget, 2, 0, 1, 2);
    }
});


var Window = GObject.registerClass({
    GTypeName: 'GSConnectSettingsWindow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/settings.ui',
    Children: [
        // HeaderBar
        'headerbar', 'headerbar-stack',
        'service-name', 'headerbar-edit', 'headerbar-entry',
        'device-name', 'device-type',
        'prev-button', 'device-menu', 'service-menu',

        // Sidebar
        'stack', 'switcher', 'sidebar',
        'appearance-list', 'display-mode',
        'service-list', 'software-list',
        'help',

        // Dependencies
        'caribou-help', 'caribou-ok', 'nautilus-help', 'nautilus-ok'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        this.connect_template();

        super._init(params);

        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup('org.gnome.Shell.Extensions.GSConnect.Preferences', true),
            path: '/org/gnome/shell/extensions/gsconnect/preferences/'
        });

        // Service HeaderBar
        gsconnect.settings.bind(
            'public-name',
            this.service_name,
            'label',
            Gio.SettingsBindFlags.DEFAULT
        );

        this.service_menu.set_menu_model(
            this.application.get_menu_by_id('service-menu')
        );

        // Sidebar
        this.switcher.set_header_func(this._headerFunc);
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // Init UI Elements
        this.add_action(gsconnect.settings.create_action('show-indicators'));
        this._displayModeChangedId = gsconnect.settings.connect(
            'changed::show-indicators',
            this._onDisplayModeChanged.bind(this)
        );
        this._onDisplayModeChanged();

        this.service_list.set_header_func(section_separators);
        this.software_list.set_header_func(section_separators);

        // Recheck deps
        this._softwareSettings();

        // Setup devices
        this._devicesChangedId = gsconnect.settings.connect(
            'changed::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();

        this.restore_geometry();
    }

    vfunc_delete_event(event) {
        this.save_geometry();
        return this.hide_on_delete();
    }

    _onDisplayModeChanged(settings) {
        let state = gsconnect.settings.get_boolean('show-indicators');
        this.display_mode.label = state ? _('Panel') : _('User Menu');
    }

    _headerFunc(row, before) {
        if ([2, 3].includes(row.get_index())) {
            row.set_header(new Gtk.Separator({visible: true}));
        }
    }

    /**
     * Additional Features
     */
    _softwareSettings() {
        // Inject a button for each dependency row
        for (let row of this.software_list.get_children()) {
            let name = row.get_name();

            // Hide "Extended Keyboard Support" on Wayland
            if (name === 'caribou' && _WAYLAND) row.visible = false;

            // Set the help link
            let label = row.get_child().get_child_at(1, 0);
            label.label = `<a href="https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Installation#${name}">` + _('Help') + '</a>';
        }

        this.software_list.set_header_func(section_separators);
    }

    _onVisibleChildName(stack) {
        if (stack.visible_child_name !== 'other') return;

        this.checkDependency('caribou');
        this.checkDependency('nautilus');
    }

    async checkDependency(name) {
        let result = false;

        try {
            // Extended Keyboard Support
            if (name === 'caribou') {
                result = (imports.gi.Caribou);

            // Files Integration
            } else if (name === 'nautilus') {
                result = await new Promise((resolve, reject) => {
                    let proc = new Gio.Subprocess({
                        argv: ['python3', '-c', NAUTILUS]
                    });
                    proc.init(null);

                    proc.wait_check_async(null, (proc, res) => {
                        try {
                            resolve(proc.wait_check_finish(res));
                        } catch (e) {
                            resolve(false);
                        }
                    });
                });
            }
        } catch (e) {
            result = false;
        } finally {
            this[`${name}_ok`].visible = result;
            this[`${name}_help`].visible = !result;
        }
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
        this.headerbar_stack.visible_child_name = 'headerbar-service';

        // Select the general page
        this.sidebar.visible_child_name = 'switcher';
        this.switcher.get_row_at_index(0).activate();

        // Reset the device menu
        this._setDeviceMenu();
    }

    _onEditServiceName(button, event) {
        this.headerbar_entry.text = gsconnect.settings.get_string('public-name');
        this.headerbar_stack.visible_child_name = 'headerbar-entry';
    }

    _onEscServiceName(entry, event) {
        if (event.get_event_type() === Gdk.EventType.KEY_PRESS &&
            event.get_keyval()[1] === Gdk.KEY_Escape) {
            this.headerbar_stack.visible_child_name = 'headerbar-service';
        }

        return false;
    }

    _onUnfocusServiceName(entry, event) {
        this.headerbar_stack.visible_child_name = 'headerbar-service';

        return false;
    }

    _onSetServiceName(button, event) {
        this.service_name.label = this.headerbar_entry.text;
        this.headerbar_stack.visible_child_name = 'headerbar-service';
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

    _onSwitcherRowSelected(box, row) {
        row = row || this.switcher.get_row_at_index(0);
        let name = row.get_name();

        this.stack.visible_child_name = name;

        if (this.sidebar.get_child_by_name(name)) {
            let panel = this.stack.visible_child;
            let device = this.stack.visible_child.device;
            this._setDeviceMenu(panel);

            // Transition the headerbar & sidebar
            this.device_name.label = device.name;
            this.device_type.label = device.display_type;
            this.headerbar_stack.visible_child_name = 'headerbar-device';

            this.sidebar.visible_child_name = name;
        }
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
        } finally {
            this.help.visible = !this.application.devices.length;
        }
    }

    addDevice(id) {
        let device = this.application._devices.get(id);

        // Create a new device settings widget
        let panel = new Device(device);

        // Add the device settings to the content stack
        this.stack.add_titled(panel, id, device.name);
        // Add the device sidebar to the sidebar stack
        this.sidebar.add_named(panel.switcher, id);
        // Add a device row to the main sidebar
        this.switcher.add(panel.row);
    }
});


var Device = GObject.registerClass({
    GTypeName: 'GSConnectSettingsDevice',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/device.ui',
    Children: [
        'switcher',
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
}, class Device extends Gtk.Stack {

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

        this._setupActions();

        // Device Menu
        this.menu = this._menus.get_object('device-menu');
        this.menu.prepend_section(null, this.device.menu);

        // Sidebar Row
        this.row = new DeviceRow(this.device);

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
        this.switcher.set_header_func((row, before) => {
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
        this._onBluetoothHostChanged(this.settings);

        this._tcpHostChangedId = this.settings.connect(
            'changed::tcp-host',
            this._onTcpHostChanged.bind(this)
        );
        this._onTcpHostChanged(this.settings);

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
        this.set_visible_child_name(row.get_name());
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

        this.switcher.destroy();
        this.row.destroy();

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
    // TODO: non-blocking dialog
    _onBrowseCommand(entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type('application/x-executable');

        let dialog = new Gtk.FileChooserDialog({filter: filter});
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Open'), Gtk.ResponseType.OK);

        if (dialog.run() === Gtk.ResponseType.OK) {
            this.command_line.text = dialog.get_filename();
        }

        dialog.destroy();
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
                }),
                activatable: true
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
            widget: widget,
            activatable: true
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
            widget: widget,
            activatable: true
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

