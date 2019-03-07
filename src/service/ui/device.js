'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Keybindings = imports.service.ui.keybindings;


// Build a list of plugins and shortcuts for devices
const DEVICE_PLUGINS = [];
const DEVICE_SHORTCUTS = {
    activate: ['view-refresh-symbolic', _('Reconnect')],
    openSettings: ['preferences-system-symbolic', _('Settings')]
};

for (let name in imports.service.plugins) {
    if (name === 'base') continue;

    // Plugins
    DEVICE_PLUGINS.push(name);

    // Shortcuts
    let meta = imports.service.plugins[name].Metadata;

    for (let [name, action] of Object.entries(meta.actions)) {
        if (action.parameter_type === null) {
            DEVICE_SHORTCUTS[name] = [action.icon_name, action.label];
        }
    }
}


// A GtkListBoxUpdateHeaderFunc for sections
function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({visible: true}));
    }
}


// A GtkListBoxSortFunc for SectionRow rows
function title_sort(row1, row2) {
    if (!row1.title || !row2.title) return 0;

    return row1.title.localeCompare(row2.title);
}


/**
 * A row for a section of settings
 */
const SectionRow = GObject.registerClass({
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

    get icon_name() {
        return this._icon.gicon.names[0];
    }

    set icon_name(icon_name) {
        this._icon.visible = (icon_name);
        this._icon.gicon = new Gio.ThemedIcon({name: icon_name});
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


var DevicePreferences = GObject.registerClass({
    GTypeName: 'GSConnectDevicePreferences',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/device.ui',
    Children: [
        'sidebar', 'stack', 'infobar',
        // Sharing
        'sharing-list', 'sharing-page',
        'clipboard', 'clipboard-sync', 'mousepad', 'mpris', 'systemvolume',
        // RunCommand
        'runcommand', 'runcommand-page',
        'command-list', 'command-list-placeholder',
        'command-toolbar', 'command-add', 'command-remove', 'command-edit', 'command-save',
        'command-editor', 'command-name', 'command-line',
        // Notifications
        'notification', 'notification-page',
        'notification-list', 'notification-apps',
        // Telephony
        'telephony', 'telephony-page',
        'ringing-list', 'ringing-volume', 'talking-list', 'talking-volume',
        // Shortcuts
        'shortcuts-page',
        'shortcuts-actions', 'shortcuts-actions-title', 'shortcuts-actions-list',
        'shortcuts-commands', 'shortcuts-commands-title', 'shortcuts-commands-list',
        // Advanced
        'advanced-page',
        'plugin-list', 'experimental-list', 'danger-list'
    ]
}, class DevicePreferences extends Gtk.Grid {

    _init(device) {
        this.connect_template();

        super._init();

        this.device = device;
        this.set_name(device.id);

        // Menus
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
        for (let name of DEVICE_PLUGINS) {
            if (this.hasOwnProperty(name)) {
                this[name].visible = this.get_plugin_allowed(name);
            }
        }
    }

    get service() {
        return Gio.Application.get_default();
    }

    _onKeynavFailed(widget, direction) {
        if (direction === Gtk.DirectionType.UP && widget.prev) {
            widget.prev.child_focus(direction);
        } else if (direction === Gtk.DirectionType.DOWN && widget.next) {
            widget.next.child_focus(direction);
        }

        return true;
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

        // Keybindings signals
        this.device.disconnect(this._actionAddedId);
        this.device.disconnect(this._actionRemovedId);
        this.settings.disconnect(this._keybindingsId);

        // Device state signals
        this.device.disconnect(this._connectedId);
        this.settings.disconnect(this._bluetoothHostChangedId);
        this.settings.disconnect(this._tcpHostChangedId);

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

        settings = this._getSettings('contacts');
        this.actions.add_action(settings.create_action('contacts-source'));

        settings = this._getSettings('mousepad');
        this.actions.add_action(settings.create_action('share-control'));

        settings = this._getSettings('mpris');
        this.actions.add_action(settings.create_action('share-players'));

        settings = this._getSettings('notification');
        this.actions.add_action(settings.create_action('send-notifications'));

        settings = this._getSettings('photo');
        this.actions.add_action(settings.create_action('share-camera'));

        settings = this._getSettings('sms');
        this.actions.add_action(settings.create_action('legacy-sms'));

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

        // Bind the edit/save button sensitivity to the editor visibility
        this.command_editor.bind_property(
            'visible',
            this.command_edit,
            'sensitive',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        this.command_editor.bind_property(
            'visible',
            this.command_save,
            'sensitive',
            GObject.BindingFlags.DEFAULT
        );

        // Scroll with keyboard focus
        let runcommand_box = this.runcommand_page.get_child().get_child();
        runcommand_box.set_focus_vadjustment(this.runcommand_page.vadjustment);

        // Local Command List
        let settings = this._getSettings('runcommand');
        this._commands = settings.get_value('command-list').full_unpack();
        this._commands = (typeof this._commands === 'string') ? {} : this._commands;

        this.command_list.set_placeholder(this.command_list_placeholder);
        this.command_list.set_sort_func(title_sort);
        this.command_list.set_header_func(section_separators);

        Object.keys(this._commands).map(uuid => this._insertCommand(uuid));
    }

    _resetCommandEditor() {
        // Reset the command editor
        delete this.command_editor.uuid;
        this.command_name.text = '';
        this.command_line.text = '';
        this.command_editor.visible = false;

        this.command_list.foreach(child => {
            if (child === this.command_editor) return;

            child.visible = true;
            child.sensitive = true;
        });

        this.command_list.invalidate_sort();
        this.command_list.invalidate_headers();
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

        row.destroy();
        this._resetCommandEditor();
    }

    // 'Edit' icon in the toolbar
    _onEditCommand(button) {
        let row = this.command_list.get_selected_row();
        let uuid = row.get_name();

        this.command_editor.uuid = uuid;
        this.command_name.text = this._commands[uuid].name;
        this.command_line.text = this._commands[uuid].command;

        row.visible = false;
        this.command_editor.visible = true;
        this.command_name.has_focus = true;

        this.command_list.foreach(child => {
            child.sensitive = (child === this.command_editor);
        });
    }

    // 'Save' icon in the toolbar
    _onSaveCommand(button) {
        let row = this.command_list.get_selected_row();
        let uuid = row.get_name();

        if (this.command_name.text && this.command_line.text) {
            this._commands[uuid] = {
                name: this.command_name.text,
                command: this.command_line.text
            };

            row.title = this.command_name.text;
            row.subtitle = this.command_line.text;

            this._getSettings('runcommand').set_value(
                'command-list',
                GLib.Variant.full_pack(this._commands)
            );
        } else {
            delete this._commands[uuid];
            row.destroy();
        }

        this._resetCommandEditor();
    }

    // The 'folder' icon in the command editor GtkEntry
    _onBrowseCommand(entry, icon_pos, event) {
        let filter = new Gtk.FileFilter();
        filter.add_mime_type('application/x-executable');

        let dialog = new Gtk.FileChooserDialog({filter: filter});
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Open'), Gtk.ResponseType.OK);
        dialog.set_default_response(Gtk.ResponseType.OK);

        dialog.connect('response', (dialog, response_id) => {
            if (response_id === Gtk.ResponseType.OK) {
                this.command_line.text = dialog.get_filename();
            }

            dialog.destroy();
        });

        dialog.show_all();
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

        // Scroll with keyboard focus
        let notification_box = this.notification_page.get_child().get_child();
        notification_box.set_focus_vadjustment(this.notification_page.vadjustment);

        // Continue focus chain between lists
        this.notification_list.next = this.notification_apps;
        this.notification_apps.prev = this.notification_list;

        this.notification_apps.set_sort_func(title_sort);
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
                icon_name: applications[name].iconName,
                title: name,
                height_request: 48,
                widget: new Gtk.Label({
                    label: applications[name].enabled ? _('On') : _('Off'),
                    margin_start: 12,
                    margin_end: 12,
                    halign: Gtk.Align.END,
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
        // Continue focus chain between lists
        this.ringing_list.next = this.talking_list;
        this.talking_list.prev = this.ringing_list;

        this.ringing_list.set_header_func(section_separators);
        this.talking_list.set_header_func(section_separators);
    }

    /**
     * Keyboard Shortcuts
     */
    _keybindingSettings() {
        // Scroll with keyboard focus
        let shortcuts_box = this.shortcuts_page.get_child().get_child();
        shortcuts_box.set_focus_vadjustment(this.shortcuts_page.vadjustment);

        // Filter & Sort
        this.shortcuts_actions_list.set_filter_func(this._filterPluginKeybindings.bind(this));
        this.shortcuts_actions_list.set_header_func(section_separators);
        this.shortcuts_actions_list.set_sort_func(title_sort);

        // Init
        for (let name in DEVICE_SHORTCUTS) {
            this._addPluginKeybinding(name);
        }

        this._setPluginKeybindings();

        // Watch for GAction and Keybinding changes
        this._actionAddedId = this.device.connect(
            'action-added',
            () => this.shortcuts_actions_list.invalidate_filter()
        );
        this._actionRemovedId = this.device.connect(
            'action-removed',
            () => this.shortcuts_actions_list.invalidate_filter()
        );
        this._keybindingsId = this.settings.connect(
            'changed::keybindings',
            this._setPluginKeybindings.bind(this)
        );

        // TODO: probably not used very often, but needs work
        this.shortcuts_commands_list.set_header_func(section_separators);
        this.shortcuts_commands_list.set_sort_func(title_sort);
        this._populateCommandKeybindings();
    }

    _addPluginKeybinding(name) {
        let [icon_name, label] = DEVICE_SHORTCUTS[name];

        let widget = new Gtk.Label({
            label: _('Disabled'),
            visible: true
        });
        widget.get_style_context().add_class('dim-label');

        let row = new SectionRow({
            icon_name: icon_name,
            title: label,
            widget: widget
        });
        row.height_request = 48;
        row._icon.pixel_size = 16;
        row.action = name;
        this.shortcuts_actions_list.add(row);
    }

    _filterPluginKeybindings(row) {
        return (this.device.lookup_action(row.action));
    }

    _setPluginKeybindings() {
        let keybindings = this.settings.get_value('keybindings').deep_unpack();

        this.shortcuts_actions_list.foreach(row => {
            if (keybindings[row.action]) {
                let accel = Gtk.accelerator_parse(keybindings[row.action]);
                row.widget.label = Gtk.accelerator_get_label(...accel);
            } else {
                row.widget.label = _('Disabled');
            }
        });
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
        this.shortcuts_commands_list.foreach(row => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            //row.destroy();
            row.run_dispose();
            imports.system.gc();
        });

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
        // Scroll with keyboard focus
        let advanced_box = this.advanced_page.get_child().get_child();
        advanced_box.set_focus_vadjustment(this.advanced_page.vadjustment);

        //
        this.plugin_list.set_header_func(section_separators);

        // Continue focus chain between lists
        this.plugin_list.next = this.experimental_list;
        this.experimental_list.prev = this.plugin_list;

        this._pluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._populatePlugins.bind(this)
        );
        this._populatePlugins();
    }

    get_plugin_allowed(name) {
        let disabled = this.settings.get_strv('disabled-plugins');
        let supported = this.device.supported_plugins;

        return supported.filter(name => !disabled.includes(name)).includes(name);
    }

    _addPlugin(name) {
        let plugin = imports.service.plugins[name];

        let row = new Gtk.ListBoxRow({
            border_width: 0,
            visible: true
        });

        let grid = new Gtk.Grid({
            height_request: 32,
            visible: true
        });
        row.add(grid);

        let widget = new Gtk.CheckButton({
            label: plugin.Metadata.label,
            active: this.get_plugin_allowed(name),
            hexpand: true,
            tooltip_text: name,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        grid.add(widget);

        if (plugin.Plugin.prototype.cacheClear) {
            let button = new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: 'edit-clear-all-symbolic',
                    pixel_size: 16,
                    visible: true
                }),
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            button.connect('clicked', this._clearPluginCache.bind(this, name));
            button.get_style_context().add_class('flat');
            widget.bind_property('active', button, 'sensitive', 2);
            grid.add(button);
        }

        this.plugin_list.add(row);

        widget._togglePluginId = widget.connect(
            'notify::active',
            this._togglePlugin.bind(this)
        );

        if (this.hasOwnProperty(name)) {
            this[name].visible = widget.active;
        }
    }

    _clearPluginCache(name) {
        try {
            this.device.lookup_plugin(name).cacheClear();
        } catch (e) {
            warning(e, `${this.device.name}: ${this.name}`);
        }
    }

    _populatePlugins() {
        let supported = this.device.supported_plugins;

        for (let row of this.plugin_list.get_children()) {
            let checkbutton = row.get_child().get_child_at(0, 0);
            let name = checkbutton.tooltip_text;

            if (supported.includes(name)) {
                row.visible = true;
                checkbutton.active = this.get_plugin_allowed(name);
            } else {
                row.visible = false;

                if (this.hasOwnProperty(name)) {
                    this[name].visible = false;
                }
            }

            supported.splice(supported.indexOf(name), 1);
        }

        for (let name of supported) {
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

