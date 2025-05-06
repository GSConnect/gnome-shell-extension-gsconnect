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

// Duration of the pairing spinner timer in secon
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

/**
 * A GtkListBox widget that displays a list of action rows based on a menu model.
 *
 * This custom widget listens for changes in the model and updates the list of rows accordingly.
 * It supports hierarchical menu structures by creating expandable rows for submenus.
 * Additionally, it adds a special row for encryption information. Each action row can be activated
 * and is linked to a corresponding action in the associated action group.
 *
 * The widget handles dynamic updates when actions are added, removed, or enabled/disabled,
 * and rebuilds the list of rows in response to these changes.
 *
 * @class ActionRowBox
 * @augments Gtk.ListBox
 */
const ActionRowBox = GObject.registerClass({
    GTypeName: 'GSConnectActionRowBox',
}, class ActionRowBox extends Gtk.ListBox {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.get_style_context().add_class('boxed-list');

        // Watch the model for changes
        this._itemsChangedId = this.model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
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

    /**
     * Rebuilds all the rows in the list based on the model.
     *
     * This method handles changes in the menu model, and when items are added or removed,
     * it rebuilds the list of rows. It clears the existing rows and appends new ones based
     * on the updated menu model. After updating the rows, it adds a specific encryption row.
     *
     * @param {Gio.MenuModel} model - The menu model that has been changed. This model contains the updated list of menu items.
     * @param {number} position - The position at which the change (addition or removal) occurred in the menu model.
     * @param {number} removed - The number of items that were removed from the menu model.
     * @param {number} added - The number of items that were added to the menu model.
     *
     * @returns {void} - This method does not return anything. It updates the UI by rebuilding the rows.
     */
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
            this.append(this._create_encription_row());
    }

    /**
     * Builds an array of rows from a menu model.
     *
     * This method processes a `Gio.MenuModel` and constructs a list of rows (either `Adw.ActionRow` or `Adw.ExpanderRow`)
     * to be added to a UI, based on the items in the menu model. It handles submenus by creating expandable rows
     * for hierarchical menu structures and adds appropriate action rows for each item in the model.
     *
     * @param {Gio.MenuModel} menuModel - The menu model from which items will be extracted to create the rows.
     *
     * @returns {Array<Adw.ActionRow|Adw.ExpanderRow>} - A list of rows (`Adw.ActionRow` or `Adw.ExpanderRow`)
     * that can be added to a UI component. These rows represent the actions or submenus in the menu model.
     */
    buildActionRowsFromMenuModel(menuModel) {
        const rows = [];

        const nItems = menuModel.get_n_items();
        for (let i = 0; i < nItems; i++) {
            const label = menuModel.get_item_attribute_value(i, 'label', null).get_string()[0];
            const iconName = menuModel.get_item_attribute_value(i, 'icon', null);
            const actionName = menuModel.get_item_attribute_value(i, 'action', null).get_string()[0].split('.')[1];
            const target = menuModel.get_item_attribute_value(i, 'target', null);
            const submenu = menuModel.get_item_link(i, 'submenu');

            const icon = Gio.Icon.deserialize(iconName);

            if (!label)
                continue;

            if (submenu) {
                submenu.connect(
                    'items-changed',
                    this._onItemsChanged.bind(this)
                );
                if (submenu.get_n_items() > 0) {

                    // Expander row con contenuto da submenu
                    const expander = new Adw.ExpanderRow({
                        title: label,
                        activatable: false,
                        selectable: false,
                    });

                    if (icon) {
                        const icon_row = new Gtk.Image({
                            gicon: icon,
                            visible: true,
                        });
                        expander.add_prefix(icon_row);
                    }

                    const childRows = this.buildActionRowsFromMenuModel(submenu);
                    for (const row of childRows)
                        expander.add_row(row);

                    if (childRows.length > 0)
                        rows.push(expander);
                }
            } else {
                const row = new Adw.ActionRow({
                    title: label,
                    activatable: !!actionName,
                    selectable: false,
                });

                if (iconName) {
                    const icon_row = new Gtk.Image({
                        gicon: icon,
                        visible: true,
                    });
                    row.add_prefix(icon_row);
                }
                row.set_visible(this.action_group.get_action_enabled(actionName));
                row.connect('activated', this._onRowActivated.bind(this, actionName, target));
                rows.push(row);
            }
        }

        return rows;
    }

    /**
     * Creates an encryption information row.
     *
     * This method creates a row that contains encryption-related information. It returns
     * an `Adw.ActionRow` containing a title and an icon that indicates encryption status.
     * The row is activatable and connected to an action that will trigger the encryption info action when activated.
     *
     * @returns {Adw.ActionRow} The encryption info row, which is an instance of `Adw.ActionRow`.
     */
    _create_encription_row() {
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

    /**
     * Activates an action from the action group.
     *
     * This method is called when a row in the list is activated. It uses the action group
     * to activate the specified action by its name. If there is a target associated with
     * the action, it is passed along during activation; otherwise, `null` is used.
     *
     * @param {string} action_name - The name of the action to activate. It should match
     *                               the name of an action in the action group.
     * @param {*} target - The target associated with the action (can be `null`).
     *                     This is typically the data or object the action should operate on.
     *
     * @returns {void} - This method does not return anything.
     */
    _onRowActivated(action_name, target) {
        this.action_group.activate_action(action_name, target);
    }

    /**
     * Disconnects signals and destroys the widget.
     *
     * This method cleans up resources when the widget is no longer needed. It disconnects
     * any connected signals (like the `items-changed` signal in this case) and then calls
     * the superclass's `destroy` method to properly dispose of the widget.
     *
     * @returns {void} - This method does not return anything.
     */
});

/**
 * A dialog for editing commands in the GSConnect preferences.
 *
 * This class represents a command editor dialog that allows users to define and edit
 * custom commands. The dialog includes fields for entering the command name and command
 * line, as well as a button to browse for the command file. The dialog provides functionality
 * for selecting a command file and updating the entries accordingly. The save button is enabled
 * only when both the command name and command line are valid.
 *
 * @class CommandEditor
 * @augments Adw.Dialog
 */
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

/**
 * The DeviceNavigationPage manages navigation and settings for a device in the context of the GSConnect extension.
 * This class extends Adw.NavigationPage and handles device-specific configurations,
 * including sharing settings, battery, commands, and notifications.
 *
 * @class DeviceNavigationPage
 * @augments Adw.NavigationPage
 */
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
        'device-cache',
        'command-list',
        'shortcuts-actions-list',
        'battery-system',
        'battery-custom-notification-value',
        'action-row-box',
        'ringing-volume-toogle',
        'talking-volume-toogle',
    ],

}, class DeviceNavigationPage extends Adw.NavigationPage {

    _init(params = {}) {
        super._init(params);

        this.shortcuts_actions_list_rows = [];
        this.plugin_list_rows = [];

        // GSetting
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
        const action_list_box = new ActionRowBox({
            action_group: this.device.action_group,
            model: this.device.menu,
        });
        action_list_box.bind_property(
            'visible',
            this.action_row_box,
            'visible',
            GObject.BindingFlags.SYNC_CREATE

        );
        this.action_row_box.child = action_list_box;
    }

    /**
     * Sets the window title and subtitle based on the device type.
     *
     * This function sets the main title of the window to the device's name,
     * and updates the subtitle based on the type of device (e.g., laptop, phone, etc.).
     * The subtitle is translated into the current language using the _() function.
     *
     * @returns {void}
     */
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

        const dialog = new Adw.MessageDialog({
            heading: _('Encryption Info'),
            body: this.device.encryption_info,
            transient_for: win,
        });

        dialog.add_response('ok',  _('Ok'));

        dialog.present();
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

        settings = this.pluginSettings('sms');
        this.actions.add_action(settings.create_action('legacy-sms'));

        settings = this.pluginSettings('systemvolume');
        this.actions.add_action(settings.create_action('share-sinks'));

        settings = this.pluginSettings('telephony');

        const ringing_action = settings.create_action('ringing-volume');
        this.actions.add_action(ringing_action);
        this._setupToggleGroup(this.ringing_volume_toogle, ringing_action);
        this.actions.add_action(settings.create_action('ringing-pause'));

        const talking_action = settings.create_action('talking-volume');
        this.actions.add_action(talking_action);
        this._setupToggleGroup(this.talking_volume_toogle, talking_action);
        this.actions.add_action(settings.create_action('talking-pause'));
        this.actions.add_action(settings.create_action('talking-microphone'));

        if (this.device.action_group.get_action_enabled('clearCache')) {
            this.device_cache.connect('clicked', () => {
                this.device.action_group.activate_action('clearCache', null);
            });
        } else {
            this.device_cache.sensitive = false;
        }

        // Pair Actions
        const encryption_info = new Gio.SimpleAction({name: 'encryption-info'});
        encryption_info.connect('activate', this._onEncryptionInfo.bind(this));
        this.actions.add_action(encryption_info);

        const status_unpair = new Gio.SimpleAction({name: 'unpair'});
        status_unpair.connect('activate', this._deviceAction.bind(this.device));
        this.settings.bind('paired', status_unpair, 'enabled', 0);
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
        this.command_list.set_sort_func(this._sortCommands);
        this.command_list.append(row);
    }

    _sortCommands(row1, row2) {
        if (!row1.title || !row2.title)
            return 1;

        return row1.title.localeCompare(row2.title);
    }

    _onDeleteCommand(button) {
        const row = button.get_ancestor(Gtk.ListBoxRow.$gtype);
        delete this._commands[row.command_name];
        this._storeCommands();
    }

    /**
     * Inserts a new command row into the command list.
     *
     * This method creates a `CommandActionRow` for the command identified by the given `uuid`. The row is
     * populated with the command's name as the title and the command line as the subtitle. It also attaches the
     * `edit` and `delete` button click events to their respective handler methods (`_onEditCommand` and `_onDeleteCommand`).
     * After setting up the row, it is added to the `command_list` to be displayed in the UI.
     *
     * @param {string} uuid - The unique identifier of the command to insert into the list.
     */
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
        const keybindings = this.settings.get_value('keybindings').deepUnpack();

        this.shortcuts_actions_list_rows.forEach(row => {
            if (keybindings[row.action]) {
                const accel = Gtk.accelerator_parse(keybindings[row.action]);
                row.label.set_label(Gtk.accelerator_get_label(...accel));
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

    async _onShortcutRowActivated(box, row) {
        try {
            const keybindings = this.settings.get_value('keybindings').deepUnpack();
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
        this._disabledPluginsId = this.settings.connect(
            'changed::disabled-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._supportedPluginsId = this.settings.connect(
            'changed::supported-plugins',
            this._onPluginsChanged.bind(this)
        );
        this._onPluginsChanged(this.settings, null);

        for (const name of DEVICE_PLUGINS)
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

    _updatePlugins(settings, key) {
        for (const row of this.plugin_list_rows) {
            const name = row.get_name();

            row.visible = this._supportedPlugins.includes(name);
            row.active = this._enabledPlugins.includes(name);
        }
    }
});

/**
 * CommandActionRow represents a row in the command list, providing a UI element for each command.
 *
 * This class extends the `Adw.ActionRow` and provides buttons for editing and deleting commands.
 * It uses a custom UI template located at 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/command-row.ui'.
 * The class is designed to manage command-related actions within a list (such as adding, editing, and deleting commands).
 * It provides methods to access the command's name and the associated edit and delete buttons.
 *
 * @class CommandActionRow
 * @augments Adw.ActionRow
 */
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

/**
 * DevicePairPage handles the user interface for pairing a device within the GSConnect extension.
 *
 * This page is part of the preferences UI where users can see the device's status and initiate pairing.
 * The page includes a label showing the device's name, a spinner that indicates progress while pairing,
 * and a button that allows the user to start the pairing process. The class interacts with the GSConnect
 * settings and handles the device pairing action.
 *
 * @class DevicePairPage
 * @augments Adw.NavigationPage
 */
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
        this.settings.bind('paired', status_pair, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        this.actions.add_action(status_pair);
    }

    /**
     * Pair Device Callback
     *
     * This method is invoked when the user clicks the "Pair" button to initiate the device pairing process.
     * It performs the following actions:
     * - Activates the 'pair' action in the device's action group, triggering the pairing process.
     * - Displays a spinner to indicate that the pairing is in progress.
     * - Hides the "Pair" button to prevent the user from clicking it again while the pairing is ongoing.
     * - Calls `_stopSpinner()` to hide the spinner and show the "Pair" button again after a specified timeout.
     *
     * @returns {void}
     */
    _pairDevice() {
        this.device.action_group.activate_action('pair', null);
        this.spinner.set_visible(true);
        this.pair_button.set_visible(false);
        this._stopSpinner();
    }

    /**
     * Stop Pair Millis Timer
     *
     * This method stops the spinner and restores the "Pair" button after a timeout to simulate
     * the completion of the pairing process. It is called after initiating the pairing process
     * to provide feedback to the user by updating the UI.
     * The timeout duration is specified in milliseconds, so `PAIR_SPINNER_SEC` is multiplied by
     * 1000 to convert seconds to milliseconds.
     *
     * @returns {void}
     */
    _stopSpinner() {
        const PAIR_SPINNER_MILLIS = PAIR_SPINNER_SEC * 1000;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAIR_SPINNER_MILLIS, () => {
            this.spinner.set_visible(false);
            this.pair_button.set_visible(true);
            return false;
        });
    }

});
