// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import Config from '../config.js';
import plugins from '../service/plugins/index.js';
import * as Keybindings from './keybindings.js';
import '../utils/filedialog.js';


// Build a list of plugins and shortcuts for devices
const DEVICE_PLUGINS = [];
const DEVICE_SHORTCUTS = {};

for (const name in plugins) {
    const module = plugins[name];

    if (module.Metadata === undefined)
        continue;

    // Plugins
    DEVICE_PLUGINS.push(name);

    // Shortcuts (GActions without parameters)
    for (const [name, action] of Object.entries(module.Metadata.actions)) {
        if (action.parameter_type === null)
            DEVICE_SHORTCUTS[name] = [action.icon_name, action.label];
    }
}


/**
 * Create an Adw.SwitchRow bound to a boolean GSettings key.
 *
 * @param {Gio.Settings} settings - The settings object
 * @param {string} key - A boolean key in @settings
 * @param {string} title - The row title
 * @param {string} [subtitle] - An optional row subtitle
 * @returns {Adw.SwitchRow} The new row
 */
function bindSwitchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);

    return row;
}


/**
 * Create an Adw.ComboRow bound to a string GSettings key.
 *
 * @param {Gio.Settings} settings - The settings object
 * @param {string} key - A string key in @settings
 * @param {string} title - The row title
 * @param {Array<[string, string]>} choices - Pairs of [value, label]
 * @returns {Adw.ComboRow} The new row
 */
function bindComboRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(choice => choice[1])),
    });

    const sync = () => {
        const index = choices.findIndex(choice => choice[0] === settings.get_string(key));

        if (index > -1 && row.selected !== index)
            row.selected = index;
    };
    sync();

    // The handler lives as long as @settings, which the panel disposes
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];

        if (choice && settings.get_string(key) !== choice[0])
            settings.set_string(key, choice[0]);
    });

    return row;
}


/**
 * Command Editor Dialog
 */
const CommandEditor = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesCommandEditor',
}, class CommandEditor extends Adw.Dialog {

    _init(onSave) {
        super._init({
            title: _('Edit Command'),
            content_width: 420,
        });

        this._onSave = onSave;

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this._saveButton = new Gtk.Button({label: _('Save'), sensitive: false});
        this._saveButton.add_css_class('suggested-action');
        this._saveButton.connect('clicked', () => {
            this._onSave(this.uuid, this.command_name, this.command_line);
            this.close();
        });
        header.pack_end(this._saveButton);

        const group = new Adw.PreferencesGroup({
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12,
        });
        toolbar.set_content(group);

        this._nameEntry = new Adw.EntryRow({title: _('Name')});
        this._commandEntry = new Adw.EntryRow({title: _('Command')});

        const browse = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: _('Select a command'),
            valign: Gtk.Align.CENTER,
        });
        browse.add_css_class('flat');
        browse.connect('clicked', this._onBrowseCommand.bind(this));
        this._commandEntry.add_suffix(browse);

        for (const entry of [this._nameEntry, this._commandEntry]) {
            entry.connect('changed', this._onEntryChanged.bind(this));
            group.add(entry);
        }

        this.set_child(toolbar);
        this.set_focus(this._nameEntry);
    }

    async _onBrowseCommand() {
        try {
            const dialog = new Gtk.FileDialog({title: _('Select a command')});
            const file = await dialog.open(this.get_root(), null);

            this._commandEntry.text = file.get_path();
        } catch (e) {
            // Dismissed
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                !e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                logError(e);
        }
    }

    _onEntryChanged() {
        this._saveButton.sensitive = !!(this.command_name && this.command_line);
    }

    get command_line() {
        return this._commandEntry.text;
    }

    set command_line(text) {
        this._commandEntry.text = text;
    }

    get command_name() {
        return this._nameEntry.text;
    }

    set command_name(text) {
        this._nameEntry.text = text;
    }
});


/**
 * A page for configuring a remote device.
 */
export const Panel = GObject.registerClass({
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
}, class Panel extends Adw.NavigationPage {

    _init(device) {
        super._init({
            device: device,
            tag: device.id,
            title: device.name,
        });

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${device.id}/`,
        });

        // Widgets whose visibility follows the state of a plugin
        this._pluginWidgets = {};

        this._setupActions();
        this._buildLayout();

        // Settings Pages
        this._sharingSettings();
        this._batterySettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._telephonySettings();
        // --------------------------
        this._keybindingSettings();
        this._advancedSettings();

        // Keep the title in sync
        device.bind_property('name', this._windowTitle, 'title', GObject.BindingFlags.SYNC_CREATE);
        device.bind_property('name', this, 'title', GObject.BindingFlags.SYNC_CREATE);
        this._windowTitle.subtitle = this._getTypeLabel(device);

        this.connect('hidden', () => this._sidebarToggle.active = false);
    }

    get menu() {
        return this._menu;
    }

    /**
     * The split view used for the sidebar, exposed so the window can collapse
     * it with a breakpoint.
     *
     * @returns {Adw.OverlaySplitView} The sidebar/content split view
     */
    get split_view() {
        return this._splitView;
    }

    get_incoming_supported(type) {
        const incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    get_outgoing_supported(type) {
        const outgoing = this.settings.get_strv('outgoing-capabilities');
        return outgoing.includes(`kdeconnect.${type}`);
    }

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

    /*
     * Layout
     */
    _buildLayout() {
        const toolbar = new Adw.ToolbarView();
        this.set_child(toolbar);

        // HeaderBar
        const header = new Adw.HeaderBar();
        this._windowTitle = new Adw.WindowTitle({title: '', subtitle: ''});
        header.title_widget = this._windowTitle;

        this._sidebarToggle = new Gtk.ToggleButton({
            icon_name: 'sidebar-show-symbolic',
            tooltip_text: _('Show Sections'),
            visible: false,
        });
        header.pack_start(this._sidebarToggle);

        this._menu = new Gio.Menu();
        if (this.device.menu)
            this._menu.append_section(null, this.device.menu);

        const infoSection = new Gio.Menu();
        infoSection.append(_('Encryption Info'), 'settings.encryption-info');
        this._menu.append_section(null, infoSection);

        const pairSection = new Gio.Menu();
        pairSection.append(_('Pair'), 'settings.pair');
        pairSection.append(_('Unpair'), 'settings.unpair');
        this._menu.append_section(null, pairSection);

        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: this._menu,
            tooltip_text: _('Device Menu'),
        });
        header.pack_end(menuButton);
        toolbar.add_top_bar(header);

        // Unpaired banner
        const banner = new Adw.Banner({
            title: _('Device is unpaired. You may configure this device before pairing'),
            button_label: _('Pair'),
            action_name: 'settings.pair',
        });
        this.device.bind_property(
            'paired',
            banner,
            'revealed',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN
        );
        toolbar.add_top_bar(banner);

        // Sections: a sidebar and a stack of pages
        this._splitView = new Adw.OverlaySplitView({
            min_sidebar_width: 200,
            max_sidebar_width: 260,
            sidebar_width_fraction: 0.3,
        });
        toolbar.set_content(this._splitView);

        this._sidebarToggle.bind_property(
            'active',
            this._splitView,
            'show-sidebar',
            GObject.BindingFlags.BIDIRECTIONAL
        );
        this._splitView.bind_property(
            'collapsed',
            this._sidebarToggle,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this._sidebar = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.SINGLE});
        this._sidebar.add_css_class('navigation-sidebar');
        this._sidebar.connect('row-selected', this._onSwitcherRowSelected.bind(this));
        this._splitView.sidebar = this._sidebar;

        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            hexpand: true,
            vexpand: true,
        });
        this._splitView.content = this._stack;

        this._pages = {};
        const sections = [
            ['sharing', _('Sharing'), 'emblem-shared-symbolic'],
            ['battery', _('Battery'), 'battery-symbolic'],
            ['runcommand', _('Commands'), 'utilities-terminal-symbolic'],
            ['notification', _('Notifications'), 'preferences-system-notifications-symbolic'],
            ['telephony', _('Telephony'), 'call-start-symbolic'],
            ['shortcuts', _('Keyboard Shortcuts'), 'input-keyboard-symbolic'],
            ['advanced', _('Advanced'), 'applications-system-symbolic'],
        ];

        for (const [name, label, icon] of sections) {
            const page = new Adw.PreferencesPage();
            this._pages[name] = page;
            this._stack.add_named(page, name);

            const row = new Gtk.ListBoxRow();
            row.set_name(name);

            const box = new Gtk.Box({spacing: 12, margin_top: 6, margin_bottom: 6});
            box.append(new Gtk.Image({icon_name: icon}));
            box.append(new Gtk.Label({label, xalign: 0}));
            row.set_child(box);

            // Separate plugins and other settings
            if (name === 'shortcuts')
                row.set_header(new Gtk.Separator());

            this._sidebar.append(row);
            this._pluginWidgets[`sidebar:${name}`] = row;
        }

        this._sidebar.select_row(this._sidebar.get_row_at_index(0));
    }

    _onSwitcherRowSelected(box, row) {
        if (row === null)
            return;

        this._stack.set_visible_child_name(row.get_name());

        // In collapsed mode, dismiss the overlay sidebar after choosing
        if (this._splitView.collapsed)
            this._splitView.show_sidebar = false;
    }

    _setPluginVisible(name, visible) {
        const widget = this._pluginWidgets[name];

        if (widget)
            widget.visible = visible;

        const row = this._pluginWidgets[`sidebar:${name}`];

        if (row) {
            row.visible = visible;

            // Don't stay on a section that was just hidden
            if (!visible && this._sidebar.get_selected_row() === row)
                this._sidebar.select_row(this._sidebar.get_row_at_index(0));
        }
    }

    _onEncryptionInfo() {
        const dialog = new Adw.AlertDialog({
            heading: _('Encryption Info'),
            body: this.device.encryption_info,
        });
        dialog.add_response('close', _('_Close'));
        dialog.present(this);
    }

    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    dispose() {
        if (this._commandEditor !== undefined)
            this._commandEditor.force_close();

        // Device signals
        this.device.action_group.disconnect(this._actionAddedId);
        this.device.action_group.disconnect(this._actionRemovedId);

        // GSettings
        for (const settings of Object.values(this._pluginSettings))
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
            const meta = plugins[name].Metadata;

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
        this.insert_action_group('device', this.device.action_group);

        // Pair Actions
        const encryption_info = new Gio.SimpleAction({name: 'encryption-info'});
        encryption_info.connect('activate', this._onEncryptionInfo.bind(this));
        this.actions.add_action(encryption_info);

        const status_pair = new Gio.SimpleAction({name: 'pair'});
        status_pair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_pair, 'enabled', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this.actions.add_action(status_pair);

        const status_unpair = new Gio.SimpleAction({name: 'unpair'});
        status_unpair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_unpair, 'enabled', Gio.SettingsBindFlags.DEFAULT);
        this.actions.add_action(status_unpair);
    }

    /**
     * Sharing Settings
     */
    _sharingSettings() {
        const page = this._pages.sharing;

        // Desktop
        const desktop = new Adw.PreferencesGroup({title: _('Desktop')});
        page.add(desktop);

        const clipboard = new Adw.ExpanderRow({title: _('Clipboard Sync')});
        const clipboardSettings = this.pluginSettings('clipboard');
        clipboard.add_row(bindSwitchRow(clipboardSettings, 'send-content', _('To Device')));
        clipboard.add_row(bindSwitchRow(clipboardSettings, 'receive-content', _('From Device')));

        const rows = {
            clipboard,
            mpris: bindSwitchRow(this.pluginSettings('mpris'), 'share-players', _('Media Players')),
            mousepad: bindSwitchRow(this.pluginSettings('mousepad'), 'share-control', _('Mouse & Keyboard')),
            systemvolume: bindSwitchRow(this.pluginSettings('systemvolume'), 'share-sinks', _('Volume Control')),
        };

        // Sorted, and only shown if the device can request them
        const sorted = Object.entries(rows).sort(([, a], [, b]) => a.title.localeCompare(b.title));

        for (const [name, row] of sorted) {
            row.visible = this.get_outgoing_supported(`${name}.request`);
            this._pluginWidgets[name] = row;
            desktop.add(row);
        }

        // Files
        const files = new Adw.PreferencesGroup({title: _('Files')});
        page.add(files);
        this._pluginWidgets.share = files;

        const shareSettings = this.pluginSettings('share');
        files.add(bindSwitchRow(shareSettings, 'receive-files', _('Receive Files')));

        this._receiveDirectoryLabel = new Gtk.Label({
            ellipsize: Pango.EllipsizeMode.MIDDLE,
            max_width_chars: 24,
        });
        const directoryButton = new Gtk.Button({
            child: this._receiveDirectoryLabel,
            valign: Gtk.Align.CENTER,
        });
        directoryButton.connect('clicked', this._onReceiveDirectoryClicked.bind(this));

        const directoryRow = new Adw.ActionRow({
            title: _('Save files to'),
            activatable_widget: directoryButton,
        });
        directoryRow.add_suffix(directoryButton);
        files.add(directoryRow);

        shareSettings.connect(
            'changed::receive-directory',
            this._onReceiveDirectoryChanged.bind(this)
        );
        this._onReceiveDirectoryChanged(shareSettings, 'receive-directory');

        // Links
        const links = new Adw.PreferencesGroup({title: _('Links')});
        page.add(links);
        this._pluginWidgets.links = links;
        links.add(bindSwitchRow(shareSettings, 'launch-urls', _('Automatically open received URLs')));
    }

    _onReceiveDirectoryChanged(settings, key) {
        let receiveDir = settings.get_string(key);

        if (receiveDir.length === 0) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            );

            // Account for some corner cases with a fallback
            const homeDir = GLib.get_home_dir();

            if (!receiveDir || receiveDir === homeDir)
                receiveDir = GLib.build_filenamev([homeDir, 'Downloads']);

            settings.set_string(key, receiveDir);
        }

        this._receiveDirectoryLabel.label = GLib.path_get_basename(receiveDir);
        this._receiveDirectoryLabel.tooltip_text = receiveDir;
    }

    async _onReceiveDirectoryClicked() {
        try {
            const settings = this.pluginSettings('share');
            const receiveDir = settings.get_string('receive-directory');

            const dialog = new Gtk.FileDialog({
                title: _('Save files to'),
                initial_folder: Gio.File.new_for_path(receiveDir),
            });
            const folder = await dialog.select_folder(this.get_root(), null);
            const path = folder.get_path();

            if (path !== receiveDir)
                settings.set_string('receive-directory', path);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                !e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                logError(e);
        }
    }

    /**
     * Battery Settings
     */
    async _batterySettings() {
        const page = this._pages.battery;
        const settings = this.pluginSettings('battery');

        // Device Battery
        const device = new Adw.PreferencesGroup({title: _('Device Battery')});
        page.add(device);

        device.add(bindSwitchRow(settings, 'low-battery-notification', _('Low Battery Notification')));

        const custom = bindSwitchRow(
            settings,
            'custom-battery-notification',
            _('Charged Up to Custom Level Notification')
        );
        device.add(custom);

        const level = new Adw.SpinRow({
            title: _('Custom Level'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 99, step_increment: 1, page_increment: 10}),
        });
        settings.bind('custom-battery-notification-value', level, 'value', Gio.SettingsBindFlags.DEFAULT);
        custom.bind_property('active', level, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        device.add(level);

        device.add(bindSwitchRow(settings, 'full-battery-notification', _('Fully Charged Notification')));

        // System Battery
        const system = new Adw.PreferencesGroup({title: _('System Battery')});
        page.add(system);
        system.add(bindSwitchRow(settings, 'send-statistics', _('Share Statistics')));

        // If the device can't handle statistics we're done
        if (!this.get_incoming_supported('battery')) {
            system.visible = false;
            return;
        }

        try {
            // Check UPower for a battery
            system.visible = await new Promise(resolve => {
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
                            const variant = connection.call_finish(res);
                            const value = variant.deepUnpack()[0];

                            resolve(value.get_boolean());
                        } catch {
                            resolve(false);
                        }
                    }
                );
            });
        } catch {
            system.visible = false;
        }
    }

    /**
     * RunCommand Page
     */
    _runcommandSettings() {
        const settings = this.pluginSettings('runcommand');
        this._commands = settings.get_value('command-list').recursiveUnpack();

        this._commandGroup = new Adw.PreferencesGroup({title: _('Commands')});
        this._pages.runcommand.add(this._commandGroup);

        this._commandRows = [];
        this._commandAddRow = new Adw.ActionRow({
            title: _('Add Command'),
            activatable: true,
        });
        this._commandAddRow.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        this._commandAddRow.connect('activated', () => this._onEditCommand(null));

        this._renderCommands();
    }

    _renderCommands() {
        for (const row of this._commandRows)
            this._commandGroup.remove(row);

        this._commandRows = [];
        if (this._commandAddRow.get_parent() !== null)
            this._commandGroup.remove(this._commandAddRow);

        const uuids = Object.keys(this._commands).sort((a, b) =>
            this._commands[a].name.localeCompare(this._commands[b].name));

        for (const uuid of uuids) {
            const row = this._createCommandRow(uuid);
            this._commandRows.push(row);
            this._commandGroup.add(row);
        }

        this._commandGroup.add(this._commandAddRow);
    }

    _createCommandRow(uuid) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(this._commands[uuid].name, -1),
            subtitle: GLib.markup_escape_text(this._commands[uuid].command, -1),
            subtitle_lines: 1,
        });
        row.set_name(uuid);

        const edit = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Edit'),
            valign: Gtk.Align.CENTER,
        });
        edit.add_css_class('flat');
        edit.update_property([Gtk.AccessibleProperty.LABEL], [_('Edit')]);
        edit.connect('clicked', () => this._onEditCommand(uuid));
        row.add_suffix(edit);

        const remove = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            tooltip_text: _('Remove'),
            valign: Gtk.Align.CENTER,
        });
        remove.add_css_class('flat');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [_('Remove')]);
        remove.connect('clicked', () => this._onDeleteCommand(uuid));
        row.add_suffix(remove);

        return row;
    }

    _onEditCommand(uuid) {
        if (this._commandEditor === undefined) {
            this._commandEditor = new CommandEditor(this._onSaveCommand.bind(this));
            this._commandEditor.connect('closed', () => {
                this._commandEditor = undefined;
            });
        }

        if (uuid !== null) {
            this._commandEditor.uuid = uuid;
            this._commandEditor.command_name = this._commands[uuid].name;
            this._commandEditor.command_line = this._commands[uuid].command;
        } else {
            this._commandEditor.uuid = GLib.uuid_string_random();
            this._commandEditor.command_name = '';
            this._commandEditor.command_line = '';
        }

        this._commandEditor.present(this);
    }

    _storeCommands() {
        const variant = {};

        for (const [uuid, command] of Object.entries(this._commands))
            variant[uuid] = new GLib.Variant('a{ss}', command);

        this.pluginSettings('runcommand').set_value(
            'command-list',
            new GLib.Variant('a{sv}', variant)
        );
    }

    _onDeleteCommand(uuid) {
        delete this._commands[uuid];
        this._storeCommands();
        this._renderCommands();
    }

    _onSaveCommand(uuid, name, command) {
        this._commands[uuid] = {name, command};
        this._storeCommands();
        this._renderCommands();
    }

    /**
     * Notification Settings
     */
    _notificationSettings() {
        const settings = this.pluginSettings('notification');
        const page = this._pages.notification;

        const general = new Adw.PreferencesGroup();
        page.add(general);
        general.add(bindSwitchRow(settings, 'send-notifications', _('Share Notifications')));
        general.add(bindSwitchRow(settings, 'send-active', _('Share When Active')));

        this._notificationApps = new Adw.PreferencesGroup({title: _('Applications')});
        page.add(this._notificationApps);

        settings.bind(
            'send-notifications',
            this._notificationApps,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        this._populateApplications(settings);
    }

    _toggleNotification(name, enabled) {
        try {
            const settings = this.pluginSettings('notification');
            let applications = {};

            try {
                applications = JSON.parse(settings.get_string('applications'));
            } catch {
                applications = {};
            }

            if (!applications[name] || applications[name].enabled === enabled)
                return;

            applications[name].enabled = enabled;
            settings.set_string('applications', JSON.stringify(applications));
        } catch (e) {
            logError(e);
        }
    }

    _populateApplications(settings) {
        const applications = this._queryApplications(settings);

        for (const name of Object.keys(applications).sort((a, b) => a.localeCompare(b))) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(name, -1),
                active: applications[name].enabled,
            });

            const icon = new Gtk.Image({
                gicon: Gio.Icon.new_for_string(applications[name].iconName),
                pixel_size: 32,
            });
            row.add_prefix(icon);

            row.connect('notify::active', () => this._toggleNotification(name, row.active));
            this._notificationApps.add(row);
        }
    }

    _queryApplications(settings) {
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch {
            applications = {};
        }

        // Scan applications that statically declare to show notifications
        const ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

        for (const appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_id() === ignoreId)
                continue;

            if (!appInfo.get_boolean('X-GNOME-UsesNotifications'))
                continue;

            const appName = appInfo.get_name();

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
        const settings = this.pluginSettings('telephony');
        const page = this._pages.telephony;
        const volumes = [
            ['nothing', _('Nothing')],
            ['restore', _('Restore')],
            ['lower', _('Lower')],
            ['mute', _('Mute')],
        ];

        const ringing = new Adw.PreferencesGroup({title: _('Incoming Calls')});
        page.add(ringing);
        ringing.add(bindComboRow(settings, 'ringing-volume', _('Volume'), volumes));
        ringing.add(bindSwitchRow(settings, 'ringing-pause', _('Pause Media')));

        const talking = new Adw.PreferencesGroup({title: _('Ongoing Calls')});
        page.add(talking);
        talking.add(bindComboRow(settings, 'talking-volume', _('Volume'), volumes));
        talking.add(bindSwitchRow(settings, 'talking-pause', _('Pause Media')));
        talking.add(bindSwitchRow(settings, 'talking-microphone', _('Mute Microphone')));
    }

    /**
     * Keyboard Shortcuts
     */
    _keybindingSettings() {
        const page = this._pages.shortcuts;

        this._shortcutsGroup = new Adw.PreferencesGroup({title: _('Action Shortcuts')});
        page.add(this._shortcutsGroup);

        const reset = new Gtk.Button({label: _('Reset All…'), valign: Gtk.Align.CENTER});
        reset.add_css_class('flat');
        reset.connect('clicked', this._onResetActionShortcuts.bind(this));
        this._shortcutsGroup.header_suffix = reset;

        // Init
        this._shortcutRows = [];

        const names = Object.keys(DEVICE_SHORTCUTS).sort((a, b) =>
            DEVICE_SHORTCUTS[a][1].localeCompare(DEVICE_SHORTCUTS[b][1]));

        for (const name of names)
            this._addPluginKeybinding(name);

        this._setPluginKeybindings();
        this._filterPluginKeybindings();

        // Watch for GAction and Keybinding changes
        this._actionAddedId = this.device.action_group.connect(
            'action-added',
            () => this._filterPluginKeybindings()
        );
        this._actionRemovedId = this.device.action_group.connect(
            'action-removed',
            () => this._filterPluginKeybindings()
        );
        this._keybindingsId = this.settings.connect(
            'changed::keybindings',
            this._setPluginKeybindings.bind(this)
        );
    }

    _addPluginKeybinding(name) {
        const [icon_name, label] = DEVICE_SHORTCUTS[name];

        const widget = new Gtk.Label({label: _('Disabled')});
        widget.add_css_class('dim-label');

        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(label, -1),
            activatable: true,
        });
        row.add_prefix(new Gtk.Image({icon_name}));
        row.add_suffix(widget);
        row.action = name;
        row.accelLabel = widget;
        row.connect('activated', () => this._onShortcutRowActivated(row));

        this._shortcutRows.push(row);
        this._shortcutsGroup.add(row);
    }

    _filterPluginKeybindings() {
        for (const row of this._shortcutRows)
            row.visible = this.device.action_group.has_action(row.action);
    }

    _setPluginKeybindings() {
        const keybindings = this.settings.get_value('keybindings').deepUnpack();

        for (const row of this._shortcutRows) {
            const [ok, key, mods] = keybindings[row.action]
                ? Gtk.accelerator_parse(keybindings[row.action])
                : [false, 0, 0];

            row.accelLabel.label = ok
                ? Gtk.accelerator_get_label(key, mods)
                : _('Disabled');
        }
    }

    _onResetActionShortcuts() {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset All Shortcuts?'),
            body: _('All action shortcuts for this device will be disabled.'),
        });
        dialog.add_response('cancel', _('_Cancel'));
        dialog.add_response('reset', _('_Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (dialog, response) => {
            if (response !== 'reset')
                return;

            const keybindings = this.settings.get_value('keybindings').deepUnpack();

            for (const action in keybindings) {
                // Don't reset remote command shortcuts
                if (!action.includes('::'))
                    delete keybindings[action];
            }

            this.settings.set_value(
                'keybindings',
                new GLib.Variant('a{ss}', keybindings)
            );
        });
        dialog.present(this);
    }

    async _onShortcutRowActivated(row) {
        try {
            const keybindings = this.settings.get_value('keybindings').deepUnpack();
            let accel = keybindings[row.action] || null;

            accel = await Keybindings.getAccelerator(this, DEVICE_SHORTCUTS[row.action][1], accel);

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
        const page = this._pages.advanced;

        this._pluginGroup = new Adw.PreferencesGroup({title: _('Plugins')});
        page.add(this._pluginGroup);

        const experimental = new Adw.PreferencesGroup({title: _('Experimental')});
        page.add(experimental);

        const cache = new Adw.ActionRow({title: _('Device Cache')});
        const clear = new Gtk.Button({
            label: _('Clear Cache…'),
            valign: Gtk.Align.CENTER,
            action_name: 'device.clearCache',
        });
        cache.add_suffix(clear);
        experimental.add(cache);

        experimental.add(bindSwitchRow(
            this.pluginSettings('sms'),
            'legacy-sms',
            _('Legacy SMS Support')
        ));

        const sftp = bindSwitchRow(
            this.pluginSettings('sftp'),
            'automount',
            _('SFTP Automount')
        );
        this._pluginWidgets.sftp = sftp;
        experimental.add(sftp);

        this._disabledPluginsId = this.settings.connect(
            'changed::disabled-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._supportedPluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._onPluginsChanged(this.settings, null);

        this._pluginRows = {};

        const names = DEVICE_PLUGINS.slice().sort((a, b) =>
            plugins[a].Metadata.label.localeCompare(plugins[b].Metadata.label));

        for (const name of names)
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
        const plugin = plugins[name];

        const row = new Adw.SwitchRow({
            title: GLib.markup_escape_text(plugin.Metadata.label, -1),
            subtitle: GLib.markup_escape_text(plugin.Metadata.description || '', -1),
            visible: this._supportedPlugins.includes(name),
            active: this._enabledPlugins.includes(name),
        });
        row.connect('notify::active', () => this._togglePlugin(name, row.active));

        this._pluginRows[name] = row;
        this._setPluginVisible(name, row.active);
        this._pluginGroup.add(row);
    }

    _updatePlugins() {
        for (const [name, row] of Object.entries(this._pluginRows)) {
            row.visible = this._supportedPlugins.includes(name);
            row.active = this._enabledPlugins.includes(name);

            this._setPluginVisible(name, row.active);
        }
    }

    _togglePlugin(name, active) {
        try {
            const index = this._disabledPlugins.indexOf(name);

            // Either add or remove the plugin from the disabled list
            if (active && index > -1)
                this._disabledPlugins.splice(index, 1);
            else if (!active && index === -1)
                this._disabledPlugins.push(name);
            else
                return;

            this.settings.set_strv('disabled-plugins', this._disabledPlugins);
        } catch (e) {
            logError(e);
        }
    }
});
