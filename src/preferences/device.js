// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import Config from '../config.js';
import plugins from '../service/plugins/index.js';
import * as Keybindings from './keybindings.js';

// Build a list of plugins and shortcuts for devices
const DEVICE_PLUGINS = [];
const DEVICE_SHORTCUTS = {};

// Duration of the pairing spinner timer in seconds
const PAIR_SPINNER_SEC = 30;

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
 * A Gtk.ListBoxSortFunc for SectionRow rows
 *
 * @param {Gtk.ListBoxRow} row1 - The first row
 * @param {Gtk.ListBoxRow} row2 - The second row
 * @returns {number} -1, 0 or 1
 */
export function titleSortFunc(row1, row2) {
    if (!row1.title || !row2.title)
        return 0;

    return row1.title.localeCompare(row2.title);
}

const ActionRowBox = GObject.registerClass({
    GTypeName: 'GSConnectActionRowBox',
}, class ActionRowBox extends Gtk.ListBox {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.get_style_context().add_class('boxed-list');
        this._menuModels = new Set();

        // Watch the model for changes
        this._watchMenuModel(this.model);
        this._onItemsChanged();

        // GActions
        this._actionAddedId = this.action_group.connect(
            'action-added',
            this._onItemsChanged.bind(this)
        );
        this._actionEnabledChangedId = this.action_group.connect(
            'action-enabled-changed',
            this._onItemsChanged.bind(this)
        );
        this._actionRemovedId = this.action_group.connect(
            'action-removed',
            this._onItemsChanged.bind(this)
        );
    }

    _watchMenuModel(menuModel) {
        if (this._menuModels.has(menuModel))
            return;

        this._menuModels.add(menuModel);
        menuModel.connect('items-changed', this._onItemsChanged.bind(this));
    }

    _onItemsChanged(model, position, removed, added) {
        // Clear the menu
        this.remove_all();
        const rows = this.buildActionRowsFromMenuModel(this.model);
        this.visible = false;
        rows.forEach(row => {
            if (row.visible)
                this.visible = true;
            this.append(row);
        });
        if (this.visible)
            this.append(this._createEncryptionRow());
    }

    buildActionRowsFromMenuModel(menuModel) {
        const rows = [];

        const nItems = menuModel.get_n_items();
        for (let i = 0; i < nItems; i++) {
            const section = menuModel.get_item_link(i, 'section');
            if (section) {
                this._watchMenuModel(section);
                rows.push(...this.buildActionRowsFromMenuModel(section));
                continue;
            }

            const labelValue = menuModel.get_item_attribute_value(i, 'label', null);
            const iconName = menuModel.get_item_attribute_value(i, 'icon', null);
            const action = menuModel.get_item_attribute_value(i, 'action', null);
            const target = menuModel.get_item_attribute_value(i, 'target', null);
            const submenu = menuModel.get_item_link(i, 'submenu');

            const label = labelValue ? labelValue.get_string()[0] : null;
            const actionName = action ? action.get_string()[0].split('.')[1] : null;
            const icon = iconName ? Gio.Icon.deserialize(iconName) : null;

            if (!label)
                continue;

            if (submenu) {
                this._watchMenuModel(submenu);

                const childRows = this.buildActionRowsFromMenuModel(submenu);
                if (childRows.length > 0) {
                    const expander = new Adw.ExpanderRow({
                        activatable: false,
                        selectable: false,
                        title: label,
                    });

                    if (icon) {
                        const iconRow = new Gtk.Image({
                            gicon: icon,
                            visible: true,
                        });
                        expander.add_prefix(iconRow);
                    }

                    for (const row of childRows)
                        expander.add_row(row);

                    rows.push(expander);
                }
            } else {
                const row = new Adw.ActionRow({
                    title: label,
                    activatable: !!actionName,
                    selectable: false,
                });

                if (iconName) {
                    const iconRow = new Gtk.Image({
                        gicon: icon,
                        visible: true,
                    });
                    row.add_prefix(iconRow);
                }
                row.set_visible(
                    actionName ? this.action_group.get_action_enabled(actionName) : true
                );

                if (actionName)
                    row.connect('activated', this._onRowActivated.bind(this, actionName, target));

                rows.push(row);
            }
        }

        return rows;
    }

    _createEncryptionRow() {
        const row = new Adw.ActionRow({
            visible: true,
            title: _('Encryption Info'),
            selectable: false,
            activatable: true,
            action_name: 'settings.encryption-info',
        });

        const icon = new Gtk.Image({
            visible: true,
            icon_name: 'system-lock-screen-symbolic',
        });
        row.add_prefix(icon);
        return row;
    }

    _onRowActivated(action_name, target) {
        this.action_group.activate_action(action_name, target);
    }

});

const CommandEditor = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesCommandEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-command-editor.ui',
    Children: [
        'command_entry', 'name_entry', 'save_button',
    ],
    Signals: {
        'response': {
            param_types: [GObject.TYPE_INT],
        },
    },
}, class CommandEditor extends Adw.Dialog {

    /**
     * Updates the state of the save button based on the changes in the entries.
     *
     * @returns {void}
     */
    _onAddCommand() {
        this.response = Gtk.ResponseType.OK;
    }

    _onEntryChanged(entry, pspec) {
        this.save_button.sensitive = (this.command_name && this.command_line);
    }

    get response() {
        if (this._response === undefined)
            return Gtk.ResponseType.CANCEL;
        return this._response;
    }

    set response(response) {
        this._response = response;
        this.emit('response', response);
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

export const DeviceNavigationPage = GObject.registerClass({
    GTypeName: 'GSConnectDeviceNavigationPage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-device-page.ui',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device being configured',
            GObject.ParamFlags.READWRITE,
            GObject.Object.$gtype
        ),
    },
    Children: [
        'window-title',
        'notification-apps',
        'receive-directory',
        'plugin-list',
        'disable_all_plugins',
        'device-cache',
        'command-list',
        'shortcuts-actions-list',
        'battery-system',
        'battery-custom-notification-value',
        'action-row-box',
        'ringing-volume-toggle',
        'talking-volume-toggle',
    ],

}, class DeviceNavigationPage extends Adw.NavigationPage {

    _init(params = {}) {
        super._init(params);

        this.shortcuts_actions_list_rows = [];
        this.plugin_list_rows = [];

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${this.device.id}/`,
        });

        this._setupActions();

        // Settings Pages
        this._setWindowTitle();
        this._sharingSettings();
        this._batterySettings();
        this._runcommandSettings();
        this._notificationSettings();
        // --------------------------
        this._keybindingSettings();
        this._advancedSettings();

        // Add device's action rows
        const actionListBox = new ActionRowBox({
            action_group: this.device.action_group,
            model: this.device.menu,
        });
        actionListBox.bind_property(
            'visible',
            this.action_row_box,
            'visible',
            GObject.BindingFlags.SYNC_CREATE

        );
        this.action_row_box.child = actionListBox;
    }

    _setWindowTitle() {
        this.window_title.set_title(this.device.name);
        let device_type = _('Desktop');
        switch (this.device.type) {
            case 'laptop':
                device_type = _('Laptop');
                break;
            case 'phone':
                device_type = _('Smartphone');
                break;
            case 'tablet':
                device_type = _('Tablet');
                break;
            case 'tv':
                device_type = _('Television');
                break;
        }
        this.window_title.set_subtitle(device_type);
    }

    _onEncryptionInfo() {
        const win = Gtk.Application.get_default().get_active_window();

        const dialog = new Adw.AlertDialog({
            heading: _('Encryption Info'),
            body: this.device.encryption_info,
        });

        dialog.add_response('ok',  _('Ok'));

        dialog.present(win);
    }

    get_incoming_supported(type) {
        const incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    get_outgoing_supported(type) {
        const outgoing = this.settings.get_strv('outgoing-capabilities');
        return outgoing.includes(`kdeconnect.${type}`);
    }

    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    _setupToggleGroup(toggle, action) {
        const state = action.get_state() ? action.get_state().deep_unpack() : null;
        if (state) {
            toggle.set_active_name(state);
            toggle.connect('notify::active-name', () => {
                const name = toggle.active_name;
                if (name && action)
                    action.change_state(new GLib.Variant('s', name));

            });
        }
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

        let settings = this.pluginSettings('battery');
        this.actions.add_action(settings.create_action('send-statistics'));
        this.actions.add_action(settings.create_action('low-battery-notification'));
        this.actions.add_action(settings.create_action('custom-battery-notification'));
        this.actions.add_action(settings.create_action('custom-battery-notification-value'));
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

        settings = this.pluginSettings('sftp');
        this.actions.add_action(settings.create_action('automount'));

        settings = this.pluginSettings('share');
        this.actions.add_action(settings.create_action('receive-files'));
        this.actions.add_action(settings.create_action('launch-urls'));

        settings = this.pluginSettings('sms');
        this.actions.add_action(settings.create_action('legacy-sms'));

        settings = this.pluginSettings('systemvolume');
        this.actions.add_action(settings.create_action('share-sinks'));

        settings = this.pluginSettings('telephony');

        const ringing_action = settings.create_action('ringing-volume');
        this.actions.add_action(ringing_action);
        this._setupToggleGroup(this.ringing_volume_toggle, ringing_action);
        this.actions.add_action(settings.create_action('ringing-pause'));

        const talking_action = settings.create_action('talking-volume');
        this.actions.add_action(talking_action);
        this._setupToggleGroup(this.talking_volume_toggle, talking_action);
        this.actions.add_action(settings.create_action('talking-pause'));
        this.actions.add_action(settings.create_action('talking-microphone'));

        // Pair Actions
        const encryption_info = new Gio.SimpleAction({name: 'encryption-info'});
        encryption_info.connect('activate', this._onEncryptionInfo.bind(this));
        this.actions.add_action(encryption_info);

        const status_unpair = new Gio.SimpleAction({name: 'unpair'});
        status_unpair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_unpair, 'enabled', GObject.BindingFlags.DEFAULT);
        this.actions.add_action(status_unpair);
    }

    /**
     * Sharing Settings
     */
    _sharingSettings() {
        // Share Plugin
        const settings = this.pluginSettings('share');

        settings.connect(
            'changed::receive-directory',
            this._onReceiveDirectoryChanged.bind(this)
        );
        this._onReceiveDirectoryChanged(settings, 'receive-directory');
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

        if (this.receive_directory.get_subtitle() !== receiveDir)
            this.receive_directory.set_subtitle(receiveDir);
    }

    _onReceiveDirectorySet(button) {
        const win = Gtk.Application.get_default().get_active_window();
        const fileDialog = new Gtk.FileDialog({
            title: _('Select Folder'),
        });

        fileDialog.select_folder(win, null, (dialog, response) => {
            const filename = fileDialog.select_folder_finish(response);
            const settings = this.pluginSettings('share');
            const receiveDir = settings.get_string('receive-directory');
            if (filename.get_path() !== receiveDir)
                settings.set_string('receive-directory', filename.get_path());
        });
    }

    /**
     * Battery Settings
     */
    async _batterySettings() {
        try {
            const settings = this.pluginSettings('battery');
            const oldLevel = settings.get_uint('custom-battery-notification-value');
            this.battery_custom_notification_value.set_value(oldLevel);

            // If the device can't handle statistics we're done
            if (!this.get_incoming_supported('battery')) {
                this.battery_system.visible = false;
                return;
            }

            // Check UPower for a battery
            await new Promise((resolve, reject) => {
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
                            const isPresent = value.get_boolean();

                            resolve(isPresent);
                        } catch {
                            resolve(false);
                        }
                    }
                );
            });

        } catch (e) {
            console.log(e + ' - ' + this.device.name);
        }
    }

    _setCustomChargeLevel(spin) {
        const settings = this.pluginSettings('battery');
        settings.set_uint('custom-battery-notification-value', spin.get_value());
    }

    /**
     * RunCommand Page
     */
    _runcommandSettings() {
        // Local Command List
        const settings = this.pluginSettings('runcommand');
        this._commands = settings.get_value('command-list').recursiveUnpack();
        for (const uuid of Object.keys(this._commands))
            this._insertCommand(uuid);
        const row = new Adw.ButtonRow({
            title: _('Add Command'),
            start_icon_name: 'list-add-symbolic',
        });
        row.connect('activated', this._onEditCommand.bind(this));
        this.command_list.prepend(row);
        this.command_list.set_sort_func(this._sortCommands);
    }

    _sortCommands(row1, row2) {
        if (!row1.title || row1.title === _('Add Command'))
            return 1;
        if (!row2.title || row2.title === _('Add Command'))
            return 0;
        return row1.title.localeCompare(row2.title);
    }

    _onDeleteCommand(button) {
        const row = button.get_ancestor(Gtk.ListBoxRow.$gtype);
        delete this._commands[row.command_name];
        this._storeCommands();
    }

    _insertCommand(uuid) {
        const row = new CommandActionRow({
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            command_name: uuid,
        });
        row.edit_button.connect('clicked', this._onEditCommand.bind(this));
        row.delete_button.connect('clicked', this._onDeleteCommand.bind(this));
        this.command_list.append(row);
    }

    _onEditCommand(widget) {
        if (this._commandEditor === undefined) {
            this._commandEditor = new CommandEditor();
            this._commandEditor.connect('response', this._onSaveCommand);
        }

        if (widget instanceof Gtk.Button) {
            const row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            const uuid = row.command_name;
            this._commandEditor.uuid = uuid;
            this._commandEditor.command_name = this._commands[uuid].name;
            this._commandEditor.command_line = this._commands[uuid].command;
        } else {
            this._commandEditor.uuid = GLib.uuid_string_random();
            this._commandEditor.command_name = '';
            this._commandEditor.command_line = '';
        }

        this._commandEditor.present(Gtk.Application.get_default().get_active_window());
    }


    _onSaveCommand(dialog, response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            this._commands[dialog.uuid] = {
                name: dialog.command_name,
                command: dialog.command_line,
            };

            this._storeCommands();

            //
            let row = null;

            for (const child of this.command_list.get_children()) {
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
        const settings = this.pluginSettings('notification');

        settings.bind(
            'send-notifications',
            this.notification_apps,
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        this.notification_apps.set_sort_func(titleSortFunc);

        this._populateApplications(settings);
    }

    _toggleNotification(widget) {
        try {
            const row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            const settings = this.pluginSettings('notification');
            let applications = {};
            try {
                applications = JSON.parse(settings.get_string('applications'));
            } catch {
                applications = {};
            }
            applications[row.title].enabled = !applications[row.title].enabled;
            row.set_active(applications[row.title].enabled);
            settings.set_string('applications', JSON.stringify(applications));

        } catch (e) {
            logError(e);
        }
    }

    _populateApplications(settings) {
        const applications = this._queryApplications(settings);

        for (const name in applications) {
            const row = new Adw.SwitchRow({
                title: name,
                icon_name: applications[name].iconName,
                active: applications[name].enabled,
            });
            row.connect('notify::active', this._toggleNotification.bind(this));
            this.notification_apps.append(row);
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
     * Keybinding Shortcuts
     */
    _keybindingSettings() {
        // Init
        for (const name in DEVICE_SHORTCUTS)
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
        const [icon_name, label] = DEVICE_SHORTCUTS[name];
        const row = new Adw.ActionRow({
            height_request: 48,
            icon_name: icon_name,
            selectable: false,
            activatable: true,
            title: label,
        });
        const acc_label = new Gtk.Label({
            label: _('Disabled'),
            visible: true,
        });
        row.add_suffix(acc_label);
        row.action = name;
        row.label = acc_label;

        this.shortcuts_actions_list.append(row);
        this.shortcuts_actions_list_rows.push(row);
    }

    _setPluginKeybindings() {
        if (this._keybindingsSuspended)
            return;

        const keybindings = this.settings.get_value('keybindings').deepUnpack();

        this.shortcuts_actions_list_rows.forEach(row => {
            if (keybindings[row.action]) {
                const [, key, mods] = Gtk.accelerator_parse(keybindings[row.action]);
                row.label.set_label(Gtk.accelerator_get_label(key, mods));
            } else {
                row.label.set_label(_('Disabled'));
            }
        });
    }

    _onResetActionShortcuts(button) {
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
    }

    _suspendKeybindings() {
        this._keybindingsSuspended = true;
        this.settings.set_value(
            'keybindings',
            new GLib.Variant('a{ss}', {})
        );
        Gio.Settings.sync();
    }

    _restoreKeybindings(keybindings) {
        this._keybindingsSuspended = false;
        this.settings.set_value(
            'keybindings',
            new GLib.Variant('a{ss}', keybindings)
        );
        Gio.Settings.sync();
        this._setPluginKeybindings();
    }

    async _waitForKeybindingsChanged() {
        await new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _getShortcutConflict(action, accelerator, keybindings) {
        const [valid, key, mods] = Gtk.accelerator_parse(accelerator);
        if (!valid)
            return null;

        const acceleratorName = Gtk.accelerator_name(key, mods);
        const acceleratorLabel = Gtk.accelerator_get_label(key, mods);
        const conflict = Object.entries(keybindings).find(([candidateAction, binding]) => {
            const [bindingValid, bindingKey, bindingMods] = Gtk.accelerator_parse(binding);

            return candidateAction !== action &&
                bindingValid &&
                Gtk.accelerator_name(bindingKey, bindingMods) === acceleratorName;
        });

        if (conflict === undefined)
            return null;

        // TRANSLATORS: When a keyboard shortcut is unavailable
        // Example: [Ctrl]+[S] is already being used
        return _('%s is already being used').format(acceleratorLabel);
    }

    async _onShortcutRowActivated(box, row) {
        let suspended = false;
        let nextKeybindings = null;

        try {
            const keybindings = this.settings.get_value('keybindings').deepUnpack();
            let accel = keybindings[row.action] || null;
            nextKeybindings = keybindings;

            suspended = true;
            this._suspendKeybindings();
            await this._waitForKeybindingsChanged();

            accel = await Keybindings.getAccelerator(row.title, accel, accelerator => {
                return this._getShortcutConflict(row.action, accelerator, keybindings);
            });

            if (accel) {
                if (this._getShortcutConflict(row.action, accel, keybindings))
                    return;

                keybindings[row.action] = accel;
            } else {
                delete keybindings[row.action];
            }
        } catch (e) {
            logError(e);
        } finally {
            if (suspended)
                this._restoreKeybindings(nextKeybindings);
        }
    }

    /**
     * Advanced Page
     */
    _advancedSettings() {
        this._updatingPlugins = false;

        this._disabledPluginsId = this.settings.connect(
            'changed::disabled-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._supportedPluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._onPluginsChanged.bind(this)
        );

        this.disable_all_plugins.connect(
            'notify::active',
            this._toggleAllPlugins.bind(this)
        );

        this._onPluginsChanged(this.settings, null);

        for (const name of DEVICE_PLUGINS)
            this._addPlugin(name);

        this._updatePlugins();
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
            title: plugin.Metadata.label,
            subtitle: plugin.Metadata.description || '',
            visible: this._supportedPlugins.includes(name),
            active: this._enabledPlugins.includes(name),
        });
        row.connect('notify::active', this._togglePlugin.bind(this));
        row.set_name(name);

        this.plugin_list.add(row);
        this.plugin_list_rows.push(row);
    }

    _togglePlugin(widget) {
        if (this._updatingPlugins)
            return;

        try {
            const name = widget.get_name();
            const index = this._disabledPlugins.indexOf(name);

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

    _toggleAllPlugins(widget) {
        if (this._updatingPlugins)
            return;

        try {
            if (widget.active) {
                this._disabledPlugins = this._disabledPlugins.filter(name => {
                    return !this._supportedPlugins.includes(name);
                });
            } else {
                this._disabledPlugins = [
                    ...new Set([
                        ...this._disabledPlugins,
                        ...this._supportedPlugins,
                    ]),
                ];
            }

            this.settings.set_strv('disabled-plugins', this._disabledPlugins);
        } catch (e) {
            logError(e);
        }
    }

    _updatePlugins(settings, key) {
        this._updatingPlugins = true;

        try {
            const pluginsEnabled = this._enabledPlugins.length > 0;

            this.disable_all_plugins.sensitive = this._supportedPlugins.length > 0;
            this.disable_all_plugins.active = pluginsEnabled;

            for (const row of this.plugin_list_rows) {
                const name = row.get_name();

                row.visible = this._supportedPlugins.includes(name);
                row.active = this._enabledPlugins.includes(name);
            }
        } finally {
            this._updatingPlugins = false;
        }
    }
});

export const CommandActionRow = GObject.registerClass({
    GTypeName: 'GSConnectCommandActionRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/command-row.ui',
    Children: [
        'edit_button',
        'delete_button',
    ],
}, class CommandActionRow extends Adw.ActionRow {

    _init(params = {}) {
        super._init();
        Object.assign(this, params);
    }

});

export const DevicePairPage = GObject.registerClass({
    GTypeName: 'GSConnectDevicePairPage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-device-pair.ui',
    Children: [
        'pair_label', 'spinner',  'pair-button',
    ],
}, class DevicePairPage extends Adw.NavigationPage {

    _init(params = {}) {
        super._init();
        Object.assign(this, params);

        this.pair_label.label = this.device.name;
        this.actions = new Gio.SimpleActionGroup();
        this.insert_action_group('settings', this.actions);

        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${this.device.id}/`,
        });

        const status_pair = new Gio.SimpleAction({name: 'pair'});
        this.settings.bind('paired', status_pair, 'enabled', GObject.BindingFlags.INVERT_BOOLEAN);
        this.actions.add_action(status_pair);
    }

    _pairDevice() {
        this.device.action_group.activate_action('pair', null);
        this.spinner.set_visible(true);
        this.pair_button.set_visible(false);
        this._stopSpinner();
    }

    _stopSpinner() {
        const PAIR_SPINNER_MILLIS = PAIR_SPINNER_SEC * 1000;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAIR_SPINNER_MILLIS, () => {
            this.spinner.set_visible(false);
            this.pair_button.set_visible(true);
            return false;
        });
    }

});
