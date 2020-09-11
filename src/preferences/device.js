'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Config = imports.config;
const Keybindings = imports.preferences.keybindings;


// Build a list of plugins and shortcuts for devices
const DEVICE_PLUGINS = [];
const DEVICE_SHORTCUTS = {};

for (let name in imports.service.plugins) {
    let module = imports.service.plugins[name];

    // Plugins
    DEVICE_PLUGINS.push(name);

    // Shortcuts (GActions without parameters)
    for (let [name, action] of Object.entries(module.Metadata.actions)) {
        if (action.parameter_type === null)
            DEVICE_SHORTCUTS[name] = [action.icon_name, action.label];
    }
}


/**
 * A Gtk.ListBoxHeaderFunc for sections that adds separators between each row.
 *
 * @param {Gtk.ListBoxRow} row - The current row
 * @param {Gtk.ListBoxRow} before - The previous row
 */
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


/**
 * A Gtk.ListBoxSortFunc for SectionRow rows
 *
 * @param {Gtk.ListBoxRow} row1 - The first row
 * @param {Gtk.ListBoxRow} row2 - The second row
 * @return {number} -1, 0 or 1
 */
function titleSortFunc(row1, row2) {
    if (!row1.title || !row2.title)
        return 0;

    return row1.title.localeCompare(row2.title);
}


/**
 * A row for a section of settings
 */
const SectionRow = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesSectionRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-section-row.ui',
    Children: ['icon-image', 'title-label', 'subtitle-label'],
    Properties: {
        'gicon': GObject.ParamSpec.object(
            'gicon',
            'GIcon',
            'A GIcon for the row',
            GObject.ParamFlags.READWRITE,
            Gio.Icon.$gtype
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'Icon Name',
            'An icon name for the row',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'subtitle': GObject.ParamSpec.string(
            'subtitle',
            'Subtitle',
            'A subtitle for the row',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'title': GObject.ParamSpec.string(
            'title',
            'Title',
            'A title for the row',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'widget': GObject.ParamSpec.object(
            'widget',
            'Widget',
            'An action widget for the row',
            GObject.ParamFlags.READWRITE,
            Gtk.Widget.$gtype
        ),
    },
}, class SectionRow extends Gtk.ListBoxRow {

    _init(params = {}) {
        super._init();

        // NOTE: we can't pass construct properties to _init() because the
        //       template children are not assigned until after it runs.
        this.freeze_notify();
        Object.assign(this, params);
        this.thaw_notify();
    }

    get icon_name() {
        return this.icon_image.icon_name;
    }

    set icon_name(icon_name) {
        if (this.icon_name === icon_name)
            return;

        this.icon_image.visible = !!icon_name;
        this.icon_image.icon_name = icon_name;
        this.notify('icon-name');
    }

    get gicon() {
        return this.icon_image.gicon;
    }

    set gicon(gicon) {
        if (this.gicon === gicon)
            return;

        this.icon_image.visible = !!gicon;
        this.icon_image.gicon = gicon;
        this.notify('gicon');
    }

    get title() {
        return this.title_label.label;
    }

    set title(text) {
        if (this.title === text)
            return;

        this.title_label.visible = !!text;
        this.title_label.label = text;
        this.notify('title');
    }

    get subtitle() {
        return this.subtitle_label.label;
    }

    set subtitle(text) {
        if (this.subtitle === text)
            return;

        this.subtitle_label.visible = !!text;
        this.subtitle_label.label = text;
        this.notify('subtitle');
    }

    get widget() {
        if (this._widget === undefined)
            this._widget = null;

        return this._widget;
    }

    set widget(widget) {
        if (this.widget === widget)
            return;

        if (this.widget instanceof Gtk.Widget)
            this.widget.destroy();

        // Add the widget
        this._widget = widget;
        this.get_child().attach(widget, 2, 0, 1, 2);
        this.notify('widget');
    }
});


/**
 * Command Editor Dialog
 */
const CommandEditor = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesCommandEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-command-editor.ui',
    Children: [
        'cancel-button', 'save-button',
        'command-entry', 'name-entry', 'command-chooser',
    ],
}, class CommandEditor extends Gtk.Dialog {

    _onBrowseCommand(entry, icon_pos, event) {
        this.command_chooser.present();
    }

    _onCommandChosen(dialog, response_id) {
        if (response_id === Gtk.ResponseType.OK)
            this.command_entry.text = dialog.get_filename();

        dialog.hide();
    }

    _onEntryChanged(entry, pspec) {
        this.save_button.sensitive = (this.command_name && this.command_line);
    }

    get command_line() {
        return this.command_entry.text;
    }

    set command_line(text) {
        this.command_entry.text = text;
    }

    get command_name() {
        return this.name_entry.text;
    }

    set command_name(text) {
        this.name_entry.text = text;
    }
});


/**
 * A widget for configuring a remote device.
 */
var Panel = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesDevicePanel',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device being configured',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object.$gtype
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-device-panel.ui',
    Children: [
        'sidebar', 'stack', 'infobar',

        // Sharing
        'sharing', 'sharing-page',
        'desktop-list', 'clipboard', 'clipboard-sync', 'mousepad', 'mpris', 'systemvolume',
        'share', 'share-list', 'receive-files', 'receive-directory',

        // Battery
        'battery',
        'battery-device-label', 'battery-device', 'battery-device-list',
        'battery-system-label', 'battery-system', 'battery-system-list',

        // RunCommand
        'runcommand', 'runcommand-page',
        'command-list', 'command-add',

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
        'plugin-list', 'experimental-list',

        'device-menu',
    ],
}, class Panel extends Gtk.Grid {

    _init(device) {
        super._init({
            device: device,
        });

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${device.id}/`,
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
            if (row.get_name() === 'shortcuts')
                row.set_header(new Gtk.Separator({visible: true}));
        });
    }

    get menu() {
        if (this._menu === undefined) {
            this._menu = this.device_menu;
            this._menu.prepend_section(null, this.device.menu);
            this.insert_action_group('device', this.device.action_group);
        }

        return this._menu;
    }

    get_incoming_supported(type) {
        let incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    get_outgoing_supported(type) {
        let outgoing = this.settings.get_strv('outgoing-capabilities');
        return outgoing.includes(`kdeconnect.${type}`);
    }

    _onKeynavFailed(widget, direction) {
        if (direction === Gtk.DirectionType.UP && widget.prev)
            widget.prev.child_focus(direction);

        else if (direction === Gtk.DirectionType.DOWN && widget.next)
            widget.next.child_focus(direction);

        return true;
    }

    _onSwitcherRowSelected(box, row) {
        this.stack.set_visible_child_name(row.get_name());
    }

    _onSectionRowActivated(box, row) {
        if (row.widget !== undefined)
            row.widget.active = !row.widget.active;
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
            transient_for: this.get_toplevel(),
        });
        dialog.connect('response', (dialog) => dialog.destroy());
        dialog.present();
    }

    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    dispose() {
        if (this._commandEditor !== undefined)
            this._commandEditor.destroy();

        // Device signals
        this.device.action_group.disconnect(this._actionAddedId);
        this.device.action_group.disconnect(this._actionRemovedId);

        // GSettings
        for (let settings of Object.values(this._pluginSettings))
            settings.run_dispose();

        this.settings.disconnect(this._keybindingsId);
        this.settings.disconnect(this._disabledPluginsId);
        this.settings.disconnect(this._supportedPluginsId);
        this.settings.run_dispose();
    }

    pluginSettings(name) {
        if (this._pluginSettings === undefined)
            this._pluginSettings = {};

        if (!this._pluginSettings.hasOwnProperty(name)) {
            let meta = imports.service.plugins[name].Metadata;

            this._pluginSettings[name] = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(meta.id, -1),
                path: `${this.settings.path}plugin/${name}/`,
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
        this.actions.add_action(settings.create_action('send-active'));

        settings = this.pluginSettings('photo');
        this.actions.add_action(settings.create_action('share-camera'));

        settings = this.pluginSettings('sftp');
        this.actions.add_action(settings.create_action('automount'));

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
            row.visible = this.get_outgoing_supported(`${name}.request`);
        });

        // Separators & Sorting
        this.desktop_list.set_header_func(rowSeparators);

        this.desktop_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });
        this.share_list.set_header_func(rowSeparators);

        // Scroll with keyboard focus
        let sharing_box = this.sharing_page.get_child().get_child();
        sharing_box.set_focus_vadjustment(this.sharing_page.vadjustment);

        // Continue focus chain between lists
        this.desktop_list.next = this.share_list;
        this.share_list.prev = this.desktop_list;
    }

    _onReceiveDirectoryChanged(settings, key) {
        let receiveDir = settings.get_string(key);

        if (receiveDir.length === 0) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            );

            // Account for some corner cases with a fallback
            let homeDir = GLib.get_home_dir();

            if (!receiveDir || receiveDir === homeDir)
                receiveDir = GLib.build_filenamev([homeDir, 'Downloads']);

            settings.set_string(key, receiveDir);
        }

        if (this.receive_directory.get_filename() !== receiveDir)
            this.receive_directory.set_filename(receiveDir);
    }

    _onReceiveDirectorySet(button) {
        let settings = this.pluginSettings('share');
        let receiveDir = settings.get_string('receive-directory');
        let filename = button.get_filename();

        if (filename !== receiveDir)
            settings.set_string('receive-directory', filename);
    }

    /**
     * Battery Settings
     */
    async _batterySettings() {
        try {
            this.battery_device_list.set_header_func(rowSeparators);
            this.battery_system_list.set_header_func(rowSeparators);

            // If the device can't handle statistics we're done
            if (!this.get_incoming_supported('battery')) {
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
                        'IsPresent',
                    ]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (connection, res) => {
                        try {
                            let variant = connection.call_finish(res);
                            let value = variant.deepUnpack()[0];
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
        this._commands = settings.get_value('command-list').recursiveUnpack();

        this.command_list.set_sort_func(this._sortCommands);
        this.command_list.set_header_func(rowSeparators);

        for (let uuid of Object.keys(this._commands))
            this._insertCommand(uuid);
    }

    _sortCommands(row1, row2) {
        if (!row1.title || !row2.title)
            return 1;

        return row1.title.localeCompare(row2.title);
    }

    _insertCommand(uuid) {
        let row = new SectionRow({
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            activatable: false,
        });
        row.set_name(uuid);
        row.subtitle_label.ellipsize = Pango.EllipsizeMode.MIDDLE;

        let editButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: 'document-edit-symbolic',
                pixel_size: 16,
                visible: true,
            }),
            tooltip_text: _('Edit'),
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true,
        });
        editButton.connect('clicked', this._onEditCommand.bind(this));
        editButton.get_accessible().set_name(_('Edit'));
        row.get_child().attach(editButton, 2, 0, 1, 2);

        let deleteButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: 'edit-delete-symbolic',
                pixel_size: 16,
                visible: true,
            }),
            tooltip_text: _('Remove'),
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true,
        });
        deleteButton.connect('clicked', this._onDeleteCommand.bind(this));
        deleteButton.get_accessible().set_name(_('Remove'));
        row.get_child().attach(deleteButton, 3, 0, 1, 2);

        this.command_list.add(row);
    }

    _onEditCommand(widget) {
        if (this._commandEditor === undefined) {
            this._commandEditor = new CommandEditor({
                modal: true,
                transient_for: this.get_toplevel(),
                use_header_bar: true,
            });

            this._commandEditor.connect(
                'response',
                this._onSaveCommand.bind(this)
            );

            this._commandEditor.resize(1, 1);
        }

        if (widget instanceof Gtk.Button) {
            let row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            let uuid = row.get_name();

            this._commandEditor.uuid = uuid;
            this._commandEditor.command_name = this._commands[uuid].name;
            this._commandEditor.command_line = this._commands[uuid].command;
        } else {
            this._commandEditor.uuid = GLib.uuid_string_random();
            this._commandEditor.command_name = '';
            this._commandEditor.command_line = '';
        }

        this._commandEditor.present();
    }

    _storeCommands() {
        let variant = {};

        for (let [uuid, command] of Object.entries(this._commands))
            variant[uuid] = new GLib.Variant('a{ss}', command);

        this.pluginSettings('runcommand').set_value(
            'command-list',
            new GLib.Variant('a{sv}', variant)
        );
    }

    _onDeleteCommand(button) {
        let row = button.get_ancestor(Gtk.ListBoxRow.$gtype);
        delete this._commands[row.get_name()];
        row.destroy();

        this._storeCommands();
    }

    _onSaveCommand(dialog, response_id) {
        if (response_id === Gtk.ResponseType.ACCEPT) {
            this._commands[dialog.uuid] = {
                name: dialog.command_name,
                command: dialog.command_line,
            };

            this._storeCommands();

            //
            let row = null;

            for (let child of this.command_list.get_children()) {
                if (child.get_name() === dialog.uuid) {
                    row = child;
                    break;
                }
            }

            if (row === null) {
                this._insertCommand(dialog.uuid);
            } else {
                row.set_name(dialog.uuid);
                row.title = dialog.command_name;
                row.subtitle = dialog.command_line;
            }
        }

        dialog.hide();
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

        // Separators & Sorting
        this.notification_list.set_header_func(rowSeparators);

        // Scroll with keyboard focus
        let notification_box = this.notification_page.get_child().get_child();
        notification_box.set_focus_vadjustment(this.notification_page.vadjustment);

        // Continue focus chain between lists
        this.notification_list.next = this.notification_apps;
        this.notification_apps.prev = this.notification_list;

        this.notification_apps.set_sort_func(titleSortFunc);
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
                gicon: Gio.Icon.new_for_string(applications[name].iconName),
                title: name,
                height_request: 48,
                widget: new Gtk.Label({
                    label: applications[name].enabled ? _('On') : _('Off'),
                    margin_start: 12,
                    margin_end: 12,
                    halign: Gtk.Align.END,
                    valign: Gtk.Align.CENTER,
                    vexpand: true,
                    visible: true,
                }),
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
        let ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

        for (let appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_id() === ignoreId)
                continue;

            if (!appInfo.get_boolean('X-GNOME-UsesNotifications'))
                continue;

            let appName = appInfo.get_name();

            if (appName === null || applications.hasOwnProperty(appName))
                continue;

            let icon = appInfo.get_icon();
            icon = (icon) ? icon.to_string() : 'application-x-executable';

            applications[appName] = {
                iconName: icon,
                enabled: true,
            };
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
        this.shortcuts_actions_list.set_sort_func(titleSortFunc);

        // Init
        for (let name in DEVICE_SHORTCUTS)
            this._addPluginKeybinding(name);

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
            visible: true,
        });
        widget.get_style_context().add_class('dim-label');

        let row = new SectionRow({
            height_request: 48,
            icon_name: icon_name,
            title: label,
            widget: widget,
        });
        row.icon_image.pixel_size = 16;
        row.action = name;
        this.shortcuts_actions_list.add(row);
    }

    _filterPluginKeybindings(row) {
        return this.device.action_group.has_action(row.action);
    }

    _setPluginKeybindings() {
        let keybindings = this.settings.get_value('keybindings').deepUnpack();

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
        let keybindings = this.settings.get_value('keybindings').deepUnpack();

        for (let action in keybindings) {
            // Don't reset remote command shortcuts
            if (!action.includes('::'))
                delete keybindings[action];
        }

        this.settings.set_value(
            'keybindings',
            new GLib.Variant('a{ss}', keybindings)
        );
    }

    async _onShortcutRowActivated(box, row) {
        try {
            let keybindings = this.settings.get_value('keybindings').deepUnpack();
            let accel = keybindings[row.action] || null;

            accel = await Keybindings.getAccelerator(row.title, accel);

            if (accel)
                keybindings[row.action] = accel;
            else
                delete keybindings[row.action];

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

        // Sort & Separate
        this.plugin_list.set_header_func(rowSeparators);
        this.plugin_list.set_sort_func(titleSortFunc);
        this.experimental_list.set_header_func(rowSeparators);

        // Continue focus chain between lists
        this.plugin_list.next = this.experimental_list;
        this.experimental_list.prev = this.plugin_list;

        this._disabledPluginsId = this.settings.connect(
            'changed::disabled-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._supportedPluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._onPluginsChanged(this.settings, null);

        for (let name of DEVICE_PLUGINS)
            this._addPlugin(name);
    }

    _onPluginsChanged(settings, key) {
        if (key === 'disabled-plugins' || this._disabledPlugins === undefined)
            this._disabledPlugins = settings.get_strv('disabled-plugins');

        if (key === 'supported-plugins' || this._supportedPlugins === undefined)
            this._supportedPlugins = settings.get_strv('supported-plugins');

        this._enabledPlugins = this._supportedPlugins.filter(name => {
            return !this._disabledPlugins.includes(name);
        });

        if (key !== null)
            this._updatePlugins();
    }

    _addPlugin(name) {
        let plugin = imports.service.plugins[name];

        let row = new SectionRow({
            height_request: 48,
            title: plugin.Metadata.label,
            visible: this._supportedPlugins.includes(name),
            widget: new Gtk.Switch({
                active: this._enabledPlugins.includes(name),
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true,
            }),
        });
        row.widget.connect('notify::active', this._togglePlugin.bind(this));
        row.set_name(name);

        if (this.hasOwnProperty(name))
            this[name].visible = row.widget.active;

        this.plugin_list.add(row);
    }

    _updatePlugins(settings, key) {
        for (let row of this.plugin_list.get_children()) {
            let name = row.get_name();

            row.visible = this._supportedPlugins.includes(name);
            row.widget.active = this._enabledPlugins.includes(name);

            if (this.hasOwnProperty(name))
                this[name].visible = row.widget.active;
        }
    }

    _togglePlugin(widget) {
        try {
            let name = widget.get_ancestor(Gtk.ListBoxRow.$gtype).get_name();
            let index = this._disabledPlugins.indexOf(name);

            // Either add or remove the plugin from the disabled list
            if (index > -1)
                this._disabledPlugins.splice(index, 1);
            else
                this._disabledPlugins.push(name);

            this.settings.set_strv('disabled-plugins', this._disabledPlugins);
        } catch (e) {
            logError(e);
        }
    }
});

