'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;


function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


function switcher_separators(row, before) {
    if (before && (before.type === undefined || row.type !== before.type)) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


/**
 * A row for a stack sidebar
 */
var SidebarRow = GObject.registerClass({
    GTypeName: 'GSConnectSidebarRow'
}, class SidebarRow extends Gtk.ListBoxRow {

    _init(panel) {
        super._init({
            selectable: true,
            visible: true
        });

        this.set_name(panel.device.id);

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
        panel.bind_property('symbolic-icon', icon, 'gicon', GObject.BindingFlags.SYNC_CREATE);
        grid.attach(icon, 0, 0, 1, 1);

        let title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        panel.device.bind_property('name', title, 'label', GObject.BindingFlags.SYNC_CREATE);
        grid.attach(title, 1, 0, 1, 1);

        // A '>' image for rows that are like submenus
        let go_next = new Gtk.Image({
            icon_name: 'go-next-symbolic',
            pixel_size: 16,
            halign: Gtk.Align.END,
            visible: true
        });
        grid.attach(go_next, 2, 0, 1, 1);
    }

    get icon() {
        return this.get_child().get_child_at(0, 0);
    }

    get title() {
        return this.get_child().get_child_at(1, 0).label;
    }

    get type() {
        return 'device';
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
            activatable: true,
            selectable: false,
            height_request: 56,
            visible: true
        });

        this._grid = new Gtk.Grid({
            column_spacing: 12,
            margin_top: 8,
            margin_right: 12,
            margin_bottom: 8,
            margin_left: 12,
            visible: true
        });
        this.add(this._grid);

        // Row Icon
        this._icon = new Gtk.Image({
            pixel_size: 32
        });
        this._grid.attach(this._icon, 0, 0, 1, 2);

        // Row Title
        this._title = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        this._grid.attach(this._title, 1, 0, 1, 1);

        // Row Subtitle
        this._subtitle = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true
        });
        this._subtitle.get_style_context().add_class('dim-label');
        this._grid.attach(this._subtitle, 1, 1, 1, 1);

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
        this._grid.attach(this.widget, 2, 0, 1, 2);
    }
});


var Window = GObject.registerClass({
    GTypeName: 'GSConnectSettingsWindow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/settings.ui',
    Children: [
        'headerbar', 'headerbar-stack',
        'service-name', 'headerbar-edit', 'headerbar-entry',
        'device-name', 'device-type',
        'prev-button', 'device-menu', 'service-menu',
        'stack', 'switcher', 'sidebar',
        'shell-list', 'display-mode',
        'network-list',
        'advanced-list',
        'help', 'help-list'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        this.connect_template();

        super._init(params);

        this.settings = new Gio.SimpleActionGroup();
        this.insert_action_group('settings', this.settings);

        // Service HeaderBar
        gsconnect.settings.bind(
            'public-name',
            this.service_name,
            'label',
            Gio.SettingsBindFlags.DEFAULT
        );

        this.service_menu.set_menu_model(this.application.app_menu);

        // Sidebar
        this.help.type = 'device';
        this.switcher.set_header_func(this._headerFunc);
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // Init UI Elements
        this._serviceSettings();

        // Setup devices
        this._serviceDevices = this.application.connect(
            'notify::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();
    }

    _headerFunc(row, before) {
        if (before !== null && before.get_name() === 'advanced') {
            row.set_header(new Gtk.Separator({ visible: true }));
        }
    }

    /**
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        //
        this.prev_button.visible = false;
        this.headerbar_stack.visible_child_name = 'headerbar-service';

        // Select the general page
        this.sidebar.visible_child_name = 'switcher';
        this.switcher.get_row_at_index(0).activate();

        // Reset the device menu
        this._setDeviceMenu();
    }

    _onEditServiceName(button, event) {
        this.headerbar_entry.text = this.application.name;
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
    _setDeviceMenu(panel=null) {
        this.device_menu.insert_action_group('device', null);
        this.device_menu.insert_action_group('misc', null);
        this.device_menu.set_menu_model(null);

        if (panel) {
            this.device_menu.insert_action_group('device', panel.device);
            this.device_menu.insert_action_group('misc', panel.actions);
            this.device_menu.set_menu_model(panel.menu);
        }
    }

    async _onSwitcherRowSelected(box, row) {
        row = row || this.switcher.get_row_at_index(0);
        let name = row.get_name();

        this.stack.visible_child_name = name;

        if (this.sidebar.get_child_by_name(name)) {
            let panel = this.stack.visible_child;
            let device = this.stack.visible_child.device;
            this._setDeviceMenu(panel);

            // Transition the headerbar & sidebar
            this.prev_button.visible = true;
            this.device_name.label = device.name;
            this.device_type.label = device.display_type;
            this.headerbar_stack.visible_child_name = 'headerbar-device';

            this.sidebar.visible_child_name = name;
        }
    }

    /**
     * UI Setup and template connecting
     */
    _serviceSettings() {
        this.settings.add_action(gsconnect.settings.create_action('show-offline'));
        this.settings.add_action(gsconnect.settings.create_action('show-unpaired'));
        this.settings.add_action(gsconnect.settings.create_action('show-battery'));
        this.settings.add_action(gsconnect.settings.create_action('debug'));

        this.shell_list.set_header_func(section_separators);
        this.network_list.set_header_func(section_separators);
        this.advanced_list.set_header_func(section_separators);

        this._setDisplayMode();
    }

    _setDisplayMode(box, row) {
        let state = gsconnect.settings.get_boolean('show-indicators');

        if (row) {
            state = !state;
            gsconnect.settings.set_boolean('show-indicators', state);
        }

        this.display_mode.label = state ? _('Panel') : _('User Menu');
    }

    async _onDevicesChanged() {
        for (let id of this.application.devices) {
            if (!this.stack.get_child_by_name(id)) {
                await this.addDevice(id);
            }
        }

        this.stack.foreach(child => {
            if (child.row) {
                let name = child.row.get_name();
                if (!this.application.devices.includes(name)) {
                    let panel = this.stack.get_child_by_name(name);
                    panel._destroy();
                    panel.destroy();
                }
            }
        });

        this.help.visible = !this.application.devices.length;
    }

    async addDevice(id) {
        let device = this.application._devices.get(id);

        // Create a new device widget
        let panel = new Device(device);

        // Add device to switcher, and panel stack
        this.stack.add_titled(panel, id, device.name);
        this.sidebar.add_named(panel.switcher, id);
        this.switcher.add(panel.row);
    }
});


var Device = GObject.registerClass({
    GTypeName: 'GSConnectSettingsDevice',
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
        'symbolic-icon':GObject.ParamSpec.object(
            'symbolic-icon',
            'Symbolic Icon',
            'Icon representing the device type and state',
            GObject.ParamFlags.READWRITE,
            Gio.Icon
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/device.ui',
    Children: [
        'switcher',
        // General Settings
        'general-list',
        'clipboard', 'clipboard-allow',
        'mpris', 'mpris-allow',
        'mousepad', 'mousepad-allow',
        // RunCommand
        'runcommand', 'share-commands', 'command-list',
        'command-toolbar', 'command-add', 'command-remove', 'command-edit',
        'command-editor', 'command-name', 'command-line',
        'command-trash', 'command-save',
        // Notifications
        'notification', 'notification-page',
        'share-notifications', 'notification-apps',
        // Telephony
        'telephony',
        'telephony-list', 'handle-sms', 'handle-calls',
        'calls-list',
        'ringing-button', 'talking-button',
        // Errata
        'errata', 'errata-page', 'error-list',
        // Events
        'events-list',
        //TODO
        // Shortcuts
        'shortcuts-actions', 'shortcuts-actions-title', 'shortcuts-actions-list',
        'shortcuts-commands', 'shortcuts-commands-title', 'shortcuts-commands-list',
        // Advanced
        'plugin-blacklist',
        'danger-list', 'device-delete-button',
    ]
}, class Device extends Gtk.Stack {

    _init(device) {
        this.connect_template();

        super._init();

        this.service = Gio.Application.get_default();
        this.device = device;

        // GActions
        this.actions = new Gio.SimpleActionGroup();
        this.insert_action_group('misc', this.actions);

        let connect_bluetooth = new Gio.SimpleAction({
            name: 'connect-bluetooth',
            parameter_type: null
        });
        connect_bluetooth.connect('activate', this._onActivateBluetooth.bind(this));
        this.actions.add_action(connect_bluetooth);

        let connect_lan = new Gio.SimpleAction({
            name: 'connect-lan',
            parameter_type: null
        });
        connect_lan.connect('activate', this._onActivateLan.bind(this));
        this.actions.add_action(connect_lan);

        // GMenu
        let builder = Gtk.Builder.new_from_resource(gsconnect.app_path + '/gtk/menus.ui');
        this.menu = builder.get_object('device-status');
        this.menu.append_section(null, this.device.menu);

        // Device Status
        this.connect('notify::connected', this._onStatusChanged.bind(this));
        this.device.bind_property('connected', this, 'connected', GObject.BindingFlags.SYNC_CREATE);

        this.connect('notify::paired', this._onStatusChanged.bind(this));
        this.device.bind_property('paired', this, 'paired', GObject.BindingFlags.SYNC_CREATE);

        // Sidebar Row
        this.row = new SidebarRow(this);

        this.insert_action_group('device', this.device);

        // Settings Pages
        this._generalSettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._telephonySettings();
        // --------------------------
        this._keybindingSettings();
        this._pluginSettings();

        // Separate plugins and other settings
        this.switcher.set_header_func((row, before) => {
            if (row.get_name() === 'shortcuts') {
                row.set_header(new Gtk.Separator({ visible: true }));
            }
        });

        // Device Changes
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
        this._bluetoothHostChangedId = this.device.settings.connect(
            'changed::bluetooth-host',
            this._onBluetoothHostChanged.bind(this)
        );
        this._onBluetoothHostChanged(this.device.settings);

        this._tcpHostChangedId = this.device.settings.connect(
            'changed::tcp-host',
            this._onTcpHostChanged.bind(this)
        );
        this._onTcpHostChanged(this.device.settings);

        this._onStatusChanged();

        // Errors/Warnings
        this.device.connect('notify::errors', this._errataPage.bind(this));
        this._errataPage();

        // Hide elements for any disabled plugins
        for (let name of this.device.settings.get_strv('plugin-blacklist')) {
            if (this.hasOwnProperty(name)) {
                this[name].visible = false;
            }
        }
    }

    // FIXME: bogus
    _errataPage() {
        this.error_list.foreach(row => {
            row.widget.disconnect(row._loadPluginId);
            row.destroy()
        });

        for (let [name, error] of this.device.errors) {
            let row = new SectionRow({
                title: name,
                subtitle: error.message,
                widget: new Gtk.Button({
                    image: new Gtk.Image({
                        icon_name: 'view-refresh-symbolic',
                        pixel_size: 16,
                        visible: true
                    }),
                    halign: Gtk.Align.END,
                    valign: Gtk.Align.CENTER,
                    vexpand: true,
                    visible: true
                }),
                activatable: false,
                selectable: false
            });
            row._subtitle.tooltip_text = error.message;
            row._subtitle.ellipsize = Pango.EllipsizeMode.MIDDLE;

            row.widget.get_style_context().add_class('circular');
            row.widget.get_style_context().add_class('flat');
            row._loadPluginId = row.widget.connect(
                'clicked',
                this.device.loadPlugin.bind(this.device, name)
            );

            this.error_list.add(row);
        }

        if (this.device.errors.size > 0) {
            this.errata.visible = true;
        } else {
            if (this.visible_child_name === 'errata') {
                this.visible_child_name = 'general';
            }

            this.errata.visible = false;
        }
    }

    _onBluetoothHostChanged(settings) {
        let hasBluetooth = (settings.get_string('bluetooth-host').length);
        this.actions.lookup_action('connect-bluetooth').enabled = hasBluetooth;
    }

    _onActivateBluetooth(button) {
        this.device.settings.set_string('last-connection', 'bluetooth');
        this.device.activate();
    }

    _onTcpHostChanged(settings) {
        let hasLan = (settings.get_string('tcp-host').length);
        this.actions.lookup_action('connect-lan').enabled = hasLan;
    }

    _onActivateLan(button) {
        this.device.settings.set_string('last-connection', 'tcp');
        this.device.activate();
    }

    get symbolic_icon() {
        let name = this.device.symbolic_icon_name;

        if (!this.paired) {
            let rgba = new Gdk.RGBA({ red: 0.95, green: 0, blue: 0, alpha: 0.9 });
            let info = Gtk.IconTheme.get_default().lookup_icon(name, 16, 0);
            return info.load_symbolic(rgba, null, null, null)[0];
        }

        return new Gio.ThemedIcon({ name: name });
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
            path: this.device.settings.path + 'plugin/' + name + '/'
        });

        return this._gsettings[name];
    }

    _onActionsChanged() {
        this._populateActionKeybindings();
    }

    _onStatusChanged() {
        this.notify('symbolic-icon');

        if (this.row) {
            //this.row.icon.gicon = this.symbolic_icon;
            this.row.icon.opacity = this.connected ? 1 : 0.5;
        }
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

        this.device.settings.disconnect(this._bluetoothHostChangedId);
        this.device.settings.disconnect(this._tcpHostChangedId);
        this.device.settings.disconnect(this._keybindingsId);

        for (let settings of Object.values(this._gsettings)) {
            settings.run_dispose();
        }
    }

    _onSwitcherRowSelected(box, row) {
        this.set_visible_child_name(row.get_name());
    }

    /**
     * General Settings
     */
    async _generalSettings() {
        // Setup current values
        this.general_list.foreach(row => {
            let label = row.get_child().get_child_at(1, 0);
            let name = label.get_name().split('-')[0];
            let settings = this._getSettings(name);

            switch (name) {
                case 'clipboard':
                    let send = settings.get_boolean('send-content');
                    let receive = settings.get_boolean('receive-content');

                    if (send && receive) {
                        label.label = _('Both');
                    } else if (send) {
                        label.label = _('To Device');
                    } else if (receive) {
                        label.label = _('From Device');
                    } else {
                        label.label = _('Off');
                    }
                    break;

                case 'mousepad':
                    if (!this.device.get_outgoing_supported('mousepad.request')) {
                        row.destroy();
                        break;
                    }

                    let control = settings.get_boolean('share-control');
                    label.label = (control) ? _('On') : _('Off');
                    break;

                case 'mpris':
                    if (!this.device.get_outgoing_supported('mpris.request')) {
                        row.destroy();
                        break;
                    }

                    let players = settings.get_boolean('share-players');
                    label.label = (players) ? _('On') : _('Off');
                    break;
            }
        });

        // Separators & Sorting
        this.general_list.set_header_func(section_separators);

        this.general_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
    }

    async _onGeneralRowActivated(box, row) {
        let label = row.get_child().get_child_at(1, 0);
        let name = label.get_name().split('-')[0];
        let settings = this._getSettings(name);

        switch (name) {
            case 'clipboard':
                let send = settings.get_boolean('send-content');
                let receive = settings.get_boolean('receive-content');

                if (send && receive) {
                    send = false;
                    receive = false;
                    label.label = _('Off');
                } else if (send) {
                    send = false;
                    receive = true;
                    label.label = _('From Device');
                } else if (receive) {
                    send = true;
                    receive = true;
                    label.label = _('Both');
                } else {
                    send = true;
                    receive = false;
                    label.label = _('To Device');
                }

                settings.set_boolean('send-content', send);
                settings.set_boolean('receive-content', receive);
                break;

            case 'mousepad':
                let control = !settings.get_boolean('share-control');
                label.label = (control) ? _('On') : _('Off');
                settings.set_boolean('share-control', control);
                break;

            case 'mpris':
                let players = !settings.get_boolean('share-players');
                label.label = (players) ? _('On') : _('Off');
                settings.set_boolean('share-players', players);
                break;
        }
    }

    /**
     * RunCommand Page
     */
    async _runcommandSettings() {
        let settings = this._getSettings('runcommand');

        settings.bind(
            'share-commands',
            this.share_commands,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        settings.bind(
            'share-commands',
            this.command_list,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        settings.bind(
            'share-commands',
            this.command_toolbar,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Exclusively enable the editor or add button
        this.command_editor.bind_property(
            'visible',
            this.command_add,
            'sensitive',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Local Command List
        // TODO: backwards compatibility?
        this._commands = settings.get_value('command-list').full_unpack();

        this.command_list.set_sort_func(this._commandSortFunc);
        this.command_list.set_header_func(section_separators);
        this._populateCommands();
    }

    _commandSortFunc(row1, row2) {
        // Placing the command editor next the row it's editing
        if (row1.uuid && row1.uuid === row2.get_name()) {
            return 1;
        } else if (row2.uuid && row2.uuid === row1.get_name()) {
            return -1;
        // Command editor when in disuse
        } else if (!row1.title || !row2.title) {
            return 0;
        }

        return row1.title.localeCompare(row2.title);
    }

    async _insertCommand(uuid) {
        let row = new SectionRow({
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            activatable: false,
            selectable: true
        });
        row.set_name(uuid);
        row._subtitle.ellipsize = Pango.EllipsizeMode.MIDDLE;

        this.command_list.add(row);

        return row;
    }

    _onCommandSelected(box) {
        this.command_edit.sensitive = (box.get_selected_rows().length > 0);
        this.command_remove.sensitive = (box.get_selected_rows().length > 0);
    }

    // The '+' row at the bottom of the command list, the only activatable row
    async _onAddCommand(button) {
        let uuid = GLib.uuid_string_random();
        this._commands[uuid] = { name: '', command: '' };

        let command = await this._insertCommand(uuid);
        this.command_list.select_row(command);
        this._onEditCommand();
    }

    _onRemoveCommand() {
        let row = this.command_list.get_selected_row();
        delete this._commands[row.get_name()];

        this._getSettings('runcommand').set_value(
            'command-list',
            GLib.Variant.full_pack(this._commands)
        );

        this._populateCommands();
    }

    // The 'edit' icon in the GtkListBoxRow of a command
    _onEditCommand(button) {
        let row = this.command_list.get_selected_row();
        let uuid = row.get_name();

        this.command_editor.title = this.command_name.text;
        this.command_editor.uuid = uuid;
        this.command_name.text = this._commands[uuid].name.slice(0);
        this.command_line.text = this._commands[uuid].command.slice(0);

        row.visible = false;
        this.command_editor.visible = true;
        this.command_name.has_focus = true;
        this.command_list.invalidate_sort();
    }

    // The 'folder' icon in the command editor GtkEntry
    _onBrowseCommand(entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type('application/x-executable');

        let dialog = new Gtk.FileChooserDialog({ filter: filter });
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Open'), Gtk.ResponseType.OK);

        if (dialog.run() === Gtk.ResponseType.OK) {
            this.command_line.text = dialog.get_filename();
        }

        dialog.destroy();
    }

    // The 'save' icon in the command editor
    async _onSaveCommand() {
        if (this.command_name.text && this.command_line.text) {
            let cmd = this._commands[this.command_editor.uuid];
            cmd.name = this.command_name.text.slice(0);
            cmd.command = this.command_line.text.slice(0);
        } else {
            delete this._commands[this.command_editor.uuid];
        }

        this._getSettings('runcommand').set_value(
            'command-list',
            GLib.Variant.full_pack(this._commands)
        );

        this._populateCommands();
    }

    async _populateCommands() {
        delete this.command_editor.title;
        delete this.command_editor.uuid;
        this.command_name.text = '';
        this.command_line.text = '';

        this.command_list.foreach(row => {
            if (row !== this.command_editor) {
                row.destroy();
            }
        });

        this.command_editor.visible = false;

        for (let uuid in this._commands) {
            this._insertCommand(uuid);
        }
    }

    /**
     * Notification Settings
     */
    async _notificationSettings() {
        let settings = this._getSettings('notification');

        settings.bind(
            'send-notifications',
            this.share_notifications,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

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

    async _onNotificationRowActivated(box, row) {
        let settings = this._getSettings('notification');
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        applications[row.title].enabled = !applications[row.title].enabled;
        row.widget.label = (applications[row.title].enabled) ? _('On') : _('Off');
        settings.set_string('applications', JSON.stringify(applications));
    }

    async _populateApplications(settings) {
        let applications = await this._queryApplications(settings);

        for (let name in applications) {
            let row = new SectionRow({
                icon_name: applications[name].iconName,
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

    // TODO: move to notifications.js
    async _queryApplications(settings) {
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        let appInfos = [];
        let ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

        // Query Gnome's notification settings
        for (let appSettings of Object.values(this.service.notificationListener.applications)) {
            let appId = appSettings.get_string('application-id');

            if (appId !== ignoreId) {
                let appInfo = Gio.DesktopAppInfo.new(appId);

                if (appInfo) {
                    appInfos.push(appInfo);
                }
            }
        }

        // Include applications that statically declare to show notifications
        // TODO: if g-s-d does this already, maybe we don't have to
        Gio.AppInfo.get_all().map(appInfo => {
            if (appInfo.get_id() !== ignoreId &&
                appInfo.get_boolean('X-GNOME-UsesNotifications')) {
                appInfos.push(appInfo);
            }
        });

        // Update GSettings
        appInfos.map(appInfo => {
            let appName = appInfo.get_name();
            let icon = appInfo.get_icon();

            if (appName && !applications[appName]) {
                applications[appName] = {
                    iconName: (icon) ? icon.to_string() : 'application-x-executable',
                    enabled: true
                };
            }
        });

        settings.set_string('applications', JSON.stringify(applications));

        return applications;
    }

    /**
     * Telephony Settings
     */
    async _telephonySettings() {
        let settings = this._getSettings('telephony');

        // SMS
        settings.bind(
            'handle-sms',
            this.handle_sms,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        settings.bind(
            'handle-calls',
            this.handle_calls,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        settings.bind(
            'handle-calls',
            this.calls_list,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );
        this.telephony_list.set_header_func(section_separators);

        // Settings Actions
        let actions = new Gio.SimpleActionGroup();
        actions.add_action(settings.create_action('ringing-volume'));
        actions.add_action(settings.create_action('ringing-pause'));

        actions.add_action(settings.create_action('talking-volume'));
        actions.add_action(settings.create_action('talking-microphone'));
        actions.add_action(settings.create_action('talking-pause'));

        // Menu Models
        this.ringing_button.set_menu_model(
            this.service.get_menu_by_id('ringing-popover')
        );

        this.talking_button.set_menu_model(
            this.service.get_menu_by_id('talking-popover')
        );

        this.insert_action_group('telephony', actions);

        this.calls_list.set_header_func(section_separators);
    }

    /**
     * Keyboard Shortcuts
     */
    async _keybindingSettings() {
        this._keybindingsId = this.device.settings.connect(
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

    async _populateKeybindings() {
        try {
            await this._populateActionKeybindings();
            await this._populateCommandKeybindings();
        } catch (e) {
            logError(e);
        }
    }

    async _populateActionKeybindings() {
        this.shortcuts_actions_list.foreach(row => row.destroy());

        let keybindings = this.device.settings.get_value('keybindings').full_unpack();

        // TODO: Backwards compatibility; remove later
        if (typeof keybindings === 'string') {
            this.device.settings.set_value(
                'keybindings',
                new GLib.Variant('a{sv}', {})
            );
            // A ::changed signal should be emitted so we'll return
            return;
        }

        // TODO: Device Menu shortcut

        for (let name of this.device.list_actions().sort()) {
            let action = this.device.lookup_action(name);

            if (action.parameter_type === null) {
                let widget = new Gtk.Label({
                    label: _('Disabled'),
                    visible: true
                });
                widget.get_style_context().add_class('dim-label');

                if (keybindings[action.name]) {
                    let accel = Gtk.accelerator_parse(keybindings[action.name]);
                    widget.label = Gtk.accelerator_get_label(...accel);
                }

                let row = new SectionRow({
                    icon_name: action.icon_name,
                    title: action.summary,
                    subtitle: action.description,
                    widget: widget
                });
                row._icon.pixel_size = 16;
                row.action = action.name;
                row.summary = action.summary;
                this.shortcuts_actions_list.add(row);
            }
        }

        this.shortcuts_actions_list.invalidate_headers();
    }

    async _onResetActionsShortcuts(button) {
        let keybindings = this.device.settings.get_value('keybindings').full_unpack();

        for (let action in keybindings) {
            if (!action.includes('::')) {
                delete keybindings[action];
            }
        }

        this.device.settings.set_value(
            'keybindings',
            GLib.Variant.full_pack(keybindings)
        );
    }

    async _onResetCommandsShortcuts(button) {
        let keybindings = this.device.settings.get_value('keybindings').full_unpack();

        for (let action in keybindings) {
            if (action.includes('::')) {
                delete keybindings[action];
            }
        }

        this.device.settings.set_value(
            'keybindings',
            GLib.Variant.full_pack(keybindings)
        );
    }

    async _populateCommandKeybindings() {
        this.shortcuts_commands_list.foreach(row => row.destroy());

        let keybindings = this.device.settings.get_value('keybindings').full_unpack();

        // Commands
        let runcommand = this.device.lookup_plugin('runcommand');
        let remoteCommands = (runcommand) ? runcommand.remote_commands : {};
        let hasCommands = (Object.keys(remoteCommands).length > 0);
        this.shortcuts_commands_title.visible = hasCommands;
        this.shortcuts_commands.visible = hasCommands;

        for (let uuid in remoteCommands) {
            let command = remoteCommands[uuid];
            let commandAction = `executeCommand::${uuid}`;

            let widget = new Gtk.Label({
                label: _('Disabled'),
                visible: true
            });
            widget.get_style_context().add_class('dim-label');

            if (keybindings[commandAction]) {
                let accel = Gtk.accelerator_parse(keybindings[commandAction]);
                widget.label = Gtk.accelerator_get_label(...accel);
            }

            let row = new SectionRow({
                title: command.name,
                subtitle: command.command,
                widget: widget
            });
            row.action = commandAction;
            row.summary = command.name;
            this.shortcuts_commands_list.add(row);
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

    async _onShortcutRowActivated(box, row) {
        let dialog = new ShortcutEditor({
            summary: row.summary,
            transient_for: box.get_toplevel()
        });

        dialog.connect('response', (dialog, response) => {
            if (response !== Gtk.ResponseType.CANCEL) {
                // Get current keybindings
                let keybindings = this.device.settings.get_value('keybindings').full_unpack();

                if (response === Gtk.ResponseType.OK) {
                    keybindings[row.action] = dialog.accelerator;
                // Reset (Backspace)
                } else if (response === 1) {
                    delete keybindings[row.action];
                }

                this.device.settings.set_value(
                    'keybindings',
                    GLib.Variant.full_pack(keybindings)
                );
            }

            dialog.destroy();
        });

        dialog.run();
    }

    /**
     * Advanced Page
     */
    async _pluginSettings() {
        let reloadPlugins = new Gio.SimpleAction({
            name: 'reload-plugins',
            parameter_type: null
        });
        reloadPlugins.connect(
            'activate',
            () => this.device.reloadPlugins()
        );
        this.actions.add_action(reloadPlugins);

//        this.device.settings.connect(
//            'changed::plugins-blacklist',
//            this._populatePlugins.bind(this)
//        );

        this._populatePlugins();
    }

    async _populatePlugins() {
        this.plugin_blacklist.foreach(row => {
            row.widget.disconnect(row.widget._togglePluginId);
            row.destroy()
        });

        for (let plugin of this.device.supported_plugins) {
            let row = new Gtk.ListBoxRow({
                activatable: true,
                selectable: false,
                visible: true
            });
            this.plugin_blacklist.add(row);

            let widget = new Gtk.CheckButton({
                label: plugin,
                active: this.device.get_plugin_allowed(plugin),
                valign: Gtk.Align.CENTER,
                visible: true
            });
            widget._togglePluginId = widget.connect(
                'notify::active',
                this._togglePlugin.bind(this)
            );
            row.add(widget);
        }
    }

    async _togglePlugin(widget) {
        let name = widget.label;
        let blacklist = this.device.settings.get_strv('plugin-blacklist');

        if (blacklist.includes(name)) {
            blacklist.splice(blacklist.indexOf(name), 1);
            this.device.loadPlugin(name);
        } else {
            this.device.unloadPlugin(name);
            blacklist.push(name);
        }

        this.device.settings.set_strv('plugin-blacklist', blacklist);

        if (this.hasOwnProperty(name)) {
            this[name].visible = this.device.get_plugin_allowed(name);
        }
    }
});


/**
 * A simplified version of the shortcut editor from Gnome Control Center
 */
var ShortcutEditor = GObject.registerClass({
    GTypeName: 'GSConnectShortcutEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/shortcut-editor.ui',
    Children: [
        // HeaderBar
        'cancel-button', 'set-button',
        //
        'stack',
        'shortcut-summary',
        'edit-shortcut', 'confirm-shortcut',
        'conflict-label'
    ]
}, class ShortcutEditor extends Gtk.Dialog {

    _init(params) {
        this.connect_template();

        super._init({
            transient_for: params.transient_for,
            use_header_bar: true,
            modal: true
        });

        this.seat = Gdk.Display.get_default().get_default_seat();

        // Content
        this.shortcut_summary.label = _('Enter a new shortcut to change <b>%s</b>').format(
            params.summary
        );

        this.shortcut_label = new Gtk.ShortcutLabel({
            accelerator: '',
            disabled_text: _('Disabled'),
            hexpand: true,
            halign: Gtk.Align.CENTER,
            visible: true
        });
        this.confirm_shortcut.attach(this.shortcut_label, 0, 0, 1, 1);
    }

    get accelerator() {
        return this.shortcut_label.accelerator;
    }

    _onDeleteEvent() {
        this.disconnect_template();
        return false;
    }

    _onKeyPressEvent(widget, event) {
        if (!this._gdkDevice) {
            return false;
        }

        let keyval = event.get_keyval()[1];
        let keyvalLower = Gdk.keyval_to_lower(keyval);

        let state = event.get_state()[1];
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

        // TODO: Remove modifier keys
        let mods = [
            Gdk.KEY_Alt_L,
            Gdk.KEY_Alt_R,
            Gdk.KEY_Caps_Lock,
            Gdk.KEY_Control_L,
            Gdk.KEY_Control_R,
            Gdk.KEY_Meta_L,
            Gdk.KEY_Meta_R,
            Gdk.KEY_Num_Lock,
            Gdk.KEY_Shift_L,
            Gdk.KEY_Shift_R,
            Gdk.KEY_Super_L,
            Gdk.KEY_Super_R
        ];
        if (mods.indexOf(keyvalLower) > -1) {
            return true;
        }

        // Normalize Tab
        if (keyvalLower === Gdk.KEY_ISO_Left_Tab) {
            keyvalLower = Gdk.KEY_Tab;
        }

        // Put shift back if it changed the case of the key, not otherwise.
        if (keyvalLower !== keyval) {
            realMask |= Gdk.ModifierType.SHIFT_MASK;
        }

        // HACK: we don't want to use SysRq as a keybinding (but we do want
        // Alt+Print), so we avoid translation from Alt+Print to SysRq
        if (keyvalLower === Gdk.KEY_Sys_Req && (realMask & Gdk.ModifierType.MOD1_MASK) !== 0) {
            keyvalLower = Gdk.KEY_Print;
        }

        // A single Escape press cancels the editing
        if (realMask === 0 && keyvalLower === Gdk.KEY_Escape) {
            return this._onCancel();
        }

        // Backspace disables the current shortcut
        if (realMask === 0 && keyvalLower === Gdk.KEY_BackSpace) {
            return this._onRemove();
        }

        // CapsLock isn't supported as a keybinding modifier, so keep it from
        // confusing us
        realMask &= ~Gdk.ModifierType.LOCK_MASK;

        if (keyvalLower !== 0 && realMask !== 0) {
            this.ungrab();

            this.cancel_button.visible = true;

            // Switch to confirm/conflict page
            this.stack.set_visible_child_name('confirm-shortcut');
            // Show shortcut icons
            this.shortcut_label.accelerator = Gtk.accelerator_name(
                keyvalLower,
                realMask
            );

            // Show the Set button if available
            if (this.check(this.accelerator)) {
                this.set_button.visible = true;
            // Otherwise report the conflict
            } else {
                this.conflict_label.label = _('%s is already being used').format(
                    Gtk.accelerator_get_label(keyvalLower, realMask)
                );
                this.conflict_label.visible = true;
            }
        }

        return true;
    }

    _onCancel() {
        return this.response(Gtk.ResponseType.CANCEL);
    }

    _onSet() {
        return this.response(Gtk.ResponseType.OK);
    }

    _onRemove() {
        return this.response(1);
    }

    _grabAccelerator(accelerator, flags=0) {
        return Gio.DBus.session.call_sync(
            'org.gnome.Shell',
            '/org/gnome/Shell',
            'org.gnome.Shell',
            'GrabAccelerator',
            new GLib.Variant('(su)', [accelerator, flags]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deep_unpack()[0];
    }

    _ungrabAccelerator(action) {
        return Gio.DBus.session.call_sync(
            'org.gnome.Shell',
            '/org/gnome/Shell',
            'org.gnome.Shell',
            'UngrabAccelerator',
            new GLib.Variant('(u)', [action]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).deep_unpack()[0];
    }

    response(response_id) {
        this.hide();
        this.ungrab();

        super.response(response_id);
    }

    check(accelerator) {
        // Check someone else isn't already using the binding
        let action = this._grabAccelerator(accelerator);

        if (action !== 0) {
            this._ungrabAccelerator(action);
            return true;
        }

        return false;
    }

    grab() {
        let success = this.seat.grab(
            this.get_window(),
            Gdk.SeatCapabilities.KEYBOARD,
            true, // owner_events
            null, // cursor
            null, // event
            null
        );

        if (success !== Gdk.GrabStatus.SUCCESS) {
            this._onCancel();
        }

        this._gdkDevice = this.seat.get_keyboard();
        this._gdkDevice = this._gdkDevice || this.seat.get_pointer();
        this.grab_add();
    }

    ungrab() {
        this.seat.ungrab();
        this.grab_remove();
        delete this._gdkDevice;
    }

    // Override with a non-blocking version of Gtk.Dialog.run()
    run() {
        this.show();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.grab();
            return GLib.SOURCE_REMOVE;
        });
    }
});

