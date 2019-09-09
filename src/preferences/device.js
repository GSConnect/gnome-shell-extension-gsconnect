'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Keybindings = imports.preferences.keybindings;


// Build a list of plugins and shortcuts for devices
const DEVICE_PLUGINS = [];
const DEVICE_SHORTCUTS = {};

for (let name in imports.service.plugins) {
    if (name === 'base') continue;

    // Plugins
    DEVICE_PLUGINS.push(name);

    // Shortcuts (GActions without parameters)
    let meta = imports.service.plugins[name].Metadata;

    for (let [name, action] of Object.entries(meta.actions)) {
        if (action.parameter_type === null) {
            DEVICE_SHORTCUTS[name] = [action.icon_name, action.label];
        }
    }
}


// A GtkListBoxUpdateHeaderFunc for sections
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
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/device-preferences.ui',
    Children: [
        'sidebar', 'stack', 'infobar',

        // Sharing
        'sharing', 'sharing-page',
        'desktop-list', 'clipboard', 'clipboard-sync', 'mousepad', 'mpris', 'systemvolume',
        'share', 'receive-files', 'receive-directory',

        // Battery
        'battery',
        'battery-device-label', 'battery-device', 'battery-device-list',
        'battery-system-label', 'battery-system', 'battery-system-list',

        // RunCommand
        'runcommand', 'runcommand-page',
        'command-list',
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

        // Advanced
        'advanced-page',
        'plugin-list', 'experimental-list'
    ]
}, class DevicePreferences extends Gtk.Grid {

    _init(device) {
        this.connectTemplate();
        super._init();

        this.device = device;

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: this.device.settings.settings_schema,
            path: this.device.settings.path
        });

        // Infobar
        this.device.bind_property(
            'paired',
            this.infobar,
            'reveal-child',
            (GObject.BindingFlags.SYNC_CREATE |
             GObject.BindingFlags.INVERT_BOOLEAN)
        );

        this._setupActions();

        // Settings Pages
        this._sharingSettings();
        this._batterySettings();
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

        // Hide elements for any disabled plugins
        for (let name of DEVICE_PLUGINS) {
            if (this.hasOwnProperty(name)) {
                this[name].visible = this.get_plugin_allowed(name);
            }
        }
    }

    get menu() {
        if (this._menu === undefined) {
            let menus = Gtk.Builder.new_from_resource(
                '/org/gnome/Shell/Extensions/GSConnect/gtk/menus.ui'
            );
            menus.translation_domain = 'org.gnome.Shell.Extensions.GSConnect';

            this._menu = menus.get_object('device-menu');
            this._menu.prepend_section(null, this.device.menu);
            this.insert_action_group('device', this.device.action_group);
        }

        return this._menu;
    }

    get supported_plugins() {
        let supported = this.settings.get_strv('supported-plugins');

        // Preempt mousepad plugin on Wayland
        if (_WAYLAND) {
            supported = supported.filter(name => (name !== 'mousepad'));
        }

        return supported;
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

    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    dispose() {
        if (this.__disposed === undefined) {
            this.__disposed = true;

            // Template
            this.disconnectTemplate();

            // Device signals
            this.device.action_group.disconnect(this._actionAddedId);
            this.device.action_group.disconnect(this._actionRemovedId);

            // GActions/GMenu
            this.menu.run_dispose();
            this.actions.run_dispose();

            // GSettings
            for (let settings of Object.values(this._pluginSettings)) {
                settings.run_dispose();
            }

            this.settings.disconnect(this._keybindingsId);
            this.settings.disconnect(this._pluginsId);
            this.settings.run_dispose();
        }
    }

    pluginSettings(name) {
        if (this._pluginSettings === undefined) {
            this._pluginSettings = {};
        }

        if (!this._pluginSettings.hasOwnProperty(name)) {
            let meta = imports.service.plugins[name].Metadata;

            this._pluginSettings[name] = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(meta.id, -1),
                path: this.settings.path + 'plugin/' + name + '/'
            });
        }

        return this._pluginSettings[name];
    }

    _setupActions() {
        this.actions = new Gio.SimpleActionGroup();
        this.insert_action_group('settings', this.actions);

        let settings = this.pluginSettings('battery');
        this.actions.add_action(settings.create_action('send-statistics'));
        this.actions.add_action(settings.create_action('low-battery-notification'));
        this.actions.add_action(settings.create_action('full-battery-notification'));

        settings = this.pluginSettings('clipboard');
        this.actions.add_action(settings.create_action('send-content'));
        this.actions.add_action(settings.create_action('receive-content'));

        settings = this.pluginSettings('contacts');
        this.actions.add_action(settings.create_action('contacts-source'));

        settings = this.pluginSettings('mousepad');
        this.actions.add_action(settings.create_action('share-control'));

        settings = this.pluginSettings('mpris');
        this.actions.add_action(settings.create_action('share-players'));

        settings = this.pluginSettings('notification');
        this.actions.add_action(settings.create_action('send-notifications'));

        settings = this.pluginSettings('photo');
        this.actions.add_action(settings.create_action('share-camera'));

        settings = this.pluginSettings('share');
        this.actions.add_action(settings.create_action('receive-files'));

        settings = this.pluginSettings('sms');
        this.actions.add_action(settings.create_action('legacy-sms'));

        settings = this.pluginSettings('systemvolume');
        this.actions.add_action(settings.create_action('share-sinks'));

        settings = this.pluginSettings('telephony');
        this.actions.add_action(settings.create_action('ringing-volume'));
        this.actions.add_action(settings.create_action('ringing-pause'));

        this.actions.add_action(settings.create_action('talking-volume'));
        this.actions.add_action(settings.create_action('talking-pause'));
        this.actions.add_action(settings.create_action('talking-microphone'));

        // Pair Actions
        let encryption_info = new Gio.SimpleAction({name: 'encryption-info'});
        encryption_info.connect('activate', this._onEncryptionInfo.bind(this));
        this.actions.add_action(encryption_info);

        let status_pair = new Gio.SimpleAction({name: 'pair'});
        status_pair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_pair, 'enabled', 16);
        this.actions.add_action(status_pair);

        let status_unpair = new Gio.SimpleAction({name: 'unpair'});
        status_unpair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_unpair, 'enabled', 0);
        this.actions.add_action(status_unpair);
    }

    /**
     * Sharing Settings
     */
    _sharingSettings() {
        // Share Plugin
        let settings = this.pluginSettings('share');

        settings.connect(
            'changed::receive-directory',
            this._onReceiveDirectoryChanged.bind(this)
        );
        this._onReceiveDirectoryChanged(settings, 'receive-directory');

        // Visibility
        this.desktop_list.foreach(row => {
            let name = row.get_name();
            row.visible = this.device.get_outgoing_supported(`${name}.request`);
        });

        // Separators & Sorting
        this.desktop_list.set_header_func(rowSeparators);

        this.desktop_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
    }

    _onReceiveDirectoryChanged(settings, key) {
        let receiveDir = settings.get_string(key);

        if (receiveDir.length === 0) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            );

            // Account for some corner cases with a fallback
            if (!receiveDir || receiveDir === GLib.get_home_dir()) {
                receiveDir = GLib.build_filenamev([
                    GLib.get_home_dir(),
                    'Downloads'
                ]);
            }

            settings.set_string(key, receiveDir);
        }

        if (this.receive_directory.get_filename() !== receiveDir) {
            this.receive_directory.set_filename(receiveDir);
        }
    }

    _onReceiveDirectorySet(button) {
        let settings = this.pluginSettings('share');
        let receiveDir = settings.get_string('receive-directory');
        let filename = button.get_filename();

        if (filename !== receiveDir) {
            settings.set_string('receive-directory', filename);
        }
    }

    /**
     * Battery Settings
     */
    async _batterySettings() {
        try {
            this.battery_device_list.set_header_func(rowSeparators);
            this.battery_system_list.set_header_func(rowSeparators);

            // If the device can't handle statistics we're done
            if (!this.device.get_incoming_supported('battery')) {
                this.battery_system_label.visible = false;
                this.battery_system.visible = false;
                return;
            }

            // Check UPower for a battery
            let hasBattery = await new Promise((resolve, reject) => {
                Gio.DBus.system.call(
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower/devices/DisplayDevice',
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', [
                        'org.freedesktop.UPower.Device',
                        'IsPresent'
                    ]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, res) => {
                        try {
                            let variant = connection.call_finish(res);
                            let value = variant.deep_unpack()[0];
                            let isPresent = value.get_boolean();

                            resolve(isPresent);
                        } catch (e) {
                            resolve(false);
                        }
                    }
                );
            });

            this.battery_system_label.visible = hasBattery;
            this.battery_system.visible = hasBattery;
        } catch (e) {
            this.battery_system_label.visible = false;
            this.battery_system.visible = false;
        }
    }

    /**
     * RunCommand Page
     */
    _runcommandSettings() {
        // Scroll with keyboard focus
        let runcommand_box = this.runcommand_page.get_child().get_child();
        runcommand_box.set_focus_vadjustment(this.runcommand_page.vadjustment);

        // Local Command List
        let settings = this.pluginSettings('runcommand');
        this._commands = settings.get_value('command-list').full_unpack();
        this._commands = (typeof this._commands === 'string') ? {} : this._commands;

        this.command_list.set_sort_func(title_sort);
        this.command_list.set_header_func(rowSeparators);

        Object.keys(this._commands).map(uuid => this._insertCommand(uuid));
    }

    _resetCommandEditor() {
        // Reset the command editor
        delete this.command_editor.uuid;
        this.command_name.text = '';
        this.command_line.text = '';
        this.command_editor.visible = false;

        this.command_list.foreach(child => {
            if (child !== this.command_editor) {
                child.visible = true;
                child.sensitive = true;
            }
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

        this.pluginSettings('runcommand').set_value(
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

            this.pluginSettings('runcommand').set_value(
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
        let settings = this.pluginSettings('notification');

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
        this.notification_apps.set_header_func(rowSeparators);

        this._populateApplications(settings);
    }

    _onNotificationRowActivated(box, row) {
        let settings = this.pluginSettings('notification');
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

    _queryApplications(settings) {
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        // Scan applications that statically declare to show notifications
        let appInfos = [];
        let ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

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

        this.ringing_list.set_header_func(rowSeparators);
        this.talking_list.set_header_func(rowSeparators);
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
        this.shortcuts_actions_list.set_header_func(rowSeparators);
        this.shortcuts_actions_list.set_sort_func(title_sort);

        // Init
        for (let name in DEVICE_SHORTCUTS) {
            this._addPluginKeybinding(name);
        }

        this._setPluginKeybindings();

        // Watch for GAction and Keybinding changes
        this._actionAddedId = this.device.action_group.connect(
            'action-added',
            () => this.shortcuts_actions_list.invalidate_filter()
        );
        this._actionRemovedId = this.device.action_group.connect(
            'action-removed',
            () => this.shortcuts_actions_list.invalidate_filter()
        );
        this._keybindingsId = this.settings.connect(
            'changed::keybindings',
            this._setPluginKeybindings.bind(this)
        );
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
        return this.device.action_group.has_action(row.action);
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
        this.plugin_list.set_header_func(rowSeparators);

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
        let supported = this.supported_plugins;

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

        // if (plugin.Plugin.prototype.cacheClear) {
        //     let button = new Gtk.Button({
        //         image: new Gtk.Image({
        //             icon_name: 'edit-clear-all-symbolic',
        //             pixel_size: 16,
        //             visible: true
        //         }),
        //         valign: Gtk.Align.CENTER,
        //         vexpand: true,
        //         visible: true
        //     });
        //     button.connect('clicked', this._clearPluginCache.bind(this, name));
        //     button.get_style_context().add_class('flat');
        //     widget.bind_property('active', button, 'sensitive', 2);
        //     grid.add(button);
        // }

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
        let supported = this.supported_plugins;

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

