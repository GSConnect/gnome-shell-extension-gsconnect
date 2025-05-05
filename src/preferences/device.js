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
 * A sorting function for Gtk.ListBox rows based on their titles.
 *
 * This function compares two rows by their titles and returns a value to determine their
 * order in the list. If either of the rows does not have a title, they are considered equal.
 * The comparison is done using locale-based string comparison, ensuring that the rows are
 * sorted alphabetically based on the title.
 *
 * @param {Gtk.ListBoxRow} row1 - The first row to compare.
 * @param {Gtk.ListBoxRow} row2 - The second row to compare.
 *
 * @returns {number} - A negative number if row1 should come before row2,
 *                     a positive number if row1 should come after row2,
 *                     or 0 if they are considered equal.
 */
export function titleSortFunc(row1, row2) {
    if (!row1.get_title() || !row2.get_title())
        return 0;

    return row1.get_title().localeCompare(row2.title);
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
    destroy() {
        this.model.disconnect(this._itemsChangedId);
        super.destroy();
    }
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
}, class CommandEditor extends Adw.Dialog {


    /**
     * Opens the file chooser dialog to browse for a command file.
     *
     * This method is triggered when the user interacts with the command entry field. It opens
     * the file chooser dialog to allow the user to select a file. Once a file is chosen, the
     * path is set in the command entry.
     *
     * @param {Gtk.Entry} entry - The entry widget where the command line is entered.
     * @param {number} icon_pos - The position of the icon in the entry widget.
     * @param {Gtk.Event} event - The event triggered when the entry is interacted with.
     * @returns {void}
     */
    _onBrowseCommand(entry, icon_pos, event) {
        this.command_chooser.present();
    }

    /**
     * Handles the file chosen in the file chooser dialog.
     *
     * This method is called when the user selects a file in the file chooser dialog. If the
     * response is OK, it sets the command entry text to the chosen file's path.
     *
     * @param {Gtk.FileChooserDialog} dialog - The file chooser dialog used to select the command.
     * @param {number} response_id - The response ID of the dialog, indicating the user's action.
     * @returns {void}
     */
    _onCommandChosen(dialog, response_id) {
        if (response_id === Gtk.ResponseType.OK)
            this.command_entry.text = dialog.get_filename();

        dialog.hide();
    }

    /**
     * Updates the state of the save button based on the changes in the entries.
     *
     * This method is triggered when there are changes in the command name or command line entries.
     * It updates the sensitivity of the save button, enabling it only when both the command name
     * and command line are non-empty.
     *
     * @param {Gtk.Entry} entry - The entry widget that was modified.
     * @param {GObject.ParamSpec} pspec - The parameter specification that triggered the change.
     * @returns {void}
     */
    _onEntryChanged(entry, pspec) {
        this.save_button.sensitive = (this.command_name && this.command_line);
    }

    /**
     * Gets or sets the command line text.
     *
     * The `command_line` represents the text entered in the command entry field. The getter retrieves the current
     * value of the command line, while the setter updates the command entry field with the new text.
     *
     * @type {string}
     */
    get command_line() {
        return this.command_entry.text;
    }


    set command_line(text) {
        this.command_entry.text = text;
    }

    /**
     * Gets or sets the command name.
     *
     * The `command_name` represents the name entered in the name entry field. The getter retrieves the current
     * value of the command name, while the setter updates the name entry field with the new text.
     *
     * @type {string}
     */
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
        super._init();
        Object.assign(this, params);
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

    /**
     * Configures actions for various plugins, such as battery management, clipboard, contacts, and more.
     *
     * This method sets up a series of actions for different plugins like battery, clipboard, contacts,
     * and telephony by creating actions and adding them to the action group for the settings.
     * These actions will be triggered based on user interaction.
     *
     * The method also includes conditional setup for cache clearing and pairing actions.
     *
     * @returns {void}
     */
    _setupActions() {
        this.actions = new Gio.SimpleActionGroup();
        this.insert_action_group('settings', this.actions);

        let settings = this._pluginSettings('battery');
        this.actions.add_action(settings.create_action('send-statistics'));
        this.actions.add_action(settings.create_action('low-battery-notification'));
        this.actions.add_action(settings.create_action('custom-battery-notification'));
        this.actions.add_action(settings.create_action('custom-battery-notification-value'));
        this.actions.add_action(settings.create_action('full-battery-notification'));

        settings = this._pluginSettings('clipboard');
        this.actions.add_action(settings.create_action('send-content'));
        this.actions.add_action(settings.create_action('receive-content'));

        settings = this._pluginSettings('contacts');
        this.actions.add_action(settings.create_action('contacts-source'));

        settings = this._pluginSettings('mousepad');
        this.actions.add_action(settings.create_action('share-control'));

        settings = this._pluginSettings('mpris');
        this.actions.add_action(settings.create_action('share-players'));

        settings = this._pluginSettings('notification');
        this.actions.add_action(settings.create_action('send-notifications'));
        this.actions.add_action(settings.create_action('send-active'));

        settings = this._pluginSettings('sftp');
        this.actions.add_action(settings.create_action('automount'));

        settings = this._pluginSettings('share');
        this.actions.add_action(settings.create_action('receive-files'));

        settings = this._pluginSettings('sms');
        this.actions.add_action(settings.create_action('legacy-sms'));

        settings = this._pluginSettings('systemvolume');
        this.actions.add_action(settings.create_action('share-sinks'));

        settings = this._pluginSettings('telephony');

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
     * Configures the toggle group for a specific action.
     *
     * This method sets up a toggle button to manage the state of a particular action. It checks the current
     * state of the action and sets the toggle's active state accordingly. Additionally, it connects a signal
     * to the toggle, so any changes to the toggle's active state will update the action's state.
     *
     * @param {object} toggle - The toggle button or widget to be configured. This object is typically a button
     *                           that can be either active or inactive.
     * @param {object} action - The action associated with the toggle. This action will change its state
     *                           based on the toggle's state.
     * @returns {void}
     */
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

    /**
     * Checks if the specified type is supported in the incoming capabilities.
     *
     * This method checks if a specific type of incoming capability, identified by `type`, is included in the
     * list of supported incoming capabilities defined in the settings. The type is expected to be in the format
     * `kdeconnect.<type>`, where `<type>` could represent various capabilities like file transfers, notifications, etc.
     *
     * @param {string} type - The type of incoming capability to check. This should be a string representing a capability,
     *                        such as 'file-transfer' or 'notifications'.
     * @returns {boolean} - Returns `true` if the specified type is supported in the incoming capabilities,
     *                      otherwise returns `false`.
     */
    get_incoming_supported(type) {
        const incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    /**
     * Configures the action for managing the device's battery.
     *
     * This method checks the device's battery settings, retrieves the current custom battery notification value,
     * and determines whether the device supports battery statistics. If the device supports battery statistics,
     * it checks the availability of a battery using UPower's DBus interface. If a battery is present, it configures
     * the UI elements accordingly.
     *
     * The method handles the following tasks:
     * 1. Retrieves and sets the custom battery notification value from the settings.
     * 2. Hides the battery-related UI elements if the device does not support battery statistics.
     * 3. Uses DBus to query UPower to determine if a battery is present on the device.
     * 4. Catches and logs any errors that occur during execution.
     *
     * @returns {void}
     */
    async _batterySettings() {
        try {
            const settings = this._pluginSettings('battery');
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

    /**
     * Configures and populates the notification settings.
     *
     * This method retrieves notification-related settings using the `_pluginSettings` method
     * and then populates the list of applications associated with the settings.
     *
     * @returns {void}
     */
    _notificationSettings() {
        const settings = this._pluginSettings('notification');
        this._populateApplications(settings);
    }

    /**
     * Configures and populates the run command settings page.
     *
     * This method retrieves run command-related settings using the `_pluginSettings` method,
     * unpacks the command list, and inserts each command into the UI. It also creates a button
     * to add a new command, connecting it to the `_onEditCommand` event handler.
     *
     * @returns {void}
     */
    _runcommandSettings() {
        // Local Command List
        const settings = this._pluginSettings('runcommand');
        this._commands = settings.get_value('command-list').recursiveUnpack();
        for (const uuid of Object.keys(this._commands))
            this._insertCommand(uuid);
        const row = new Adw.ButtonRow({
            title: _('Add Command'),
            start_icon_name: 'list-add-symbolic',
        });
        row.connect('activated', this._onEditCommand.bind(this));
        this.command_list.append(row);
    }

    /**
     * Handles the activation of a shortcut row.
     *
     * This method retrieves the current keybindings, checks if a keybinding exists for the given row's action,
     * and updates or removes the keybinding based on user input. The updated keybindings are then saved to settings.
     *
     * @param {object} box - The parent container of the row (not directly used in the method).
     * @param {object} row - The row object that was activated, containing details such as `action` and `title`.
     *
     * @returns {Promise<void>} A promise that resolves when the keybinding is updated or removed.
     */
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
     * Sharing Settings Configuration
     *
     * This method configures the sharing plugin settings by connecting a signal handler
     * for changes to the 'receive-directory' setting. The handler updates the configuration
     * whenever the setting changes. The current value of the setting is also checked at
     * the time of method execution.
     *
     * @returns {void}
     */
    _sharingSettings() {
        // Share Plugin
        const settings = this._pluginSettings('share');

        settings.connect(
            'changed::receive-directory',
            this._onReceiveDirectoryChanged.bind(this)
        );
        this._onReceiveDirectoryChanged(settings, 'receive-directory');
    }

    /**
     * Configures the keyboard shortcuts for the plugin and sets up listeners for changes.
     *
     * This method initializes and sets up keybindings for plugin actions, applies the settings to the UI, and establishes listeners
     * for changes to the keybindings and actions. It ensures that the UI remains in sync with any updates or modifications
     * to the available actions or keybindings. This method is typically called when setting up or updating the keybinding settings for a device.
     *
     * @returns {void}
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

    /**
     * Keyboard Shortcuts Configuration
     *
     * This method initializes keyboard shortcuts by adding keybindings for each entry
     * in `DEVICE_SHORTCUTS`. It also sets the plugin's keybindings and watches for
     * changes to keybindings and device actions, invalidating the shortcuts list filter
     * when an action is added or removed.
     *
     * @returns {void}
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

    /**
     * Handles the changes in plugin settings.
     *
     * This method is triggered when the plugin settings are modified. It updates the lists of disabled, supported,
     * and enabled plugins based on the changes. The method ensures that the enabled plugins are calculated by
     * filtering out the disabled plugins from the list of supported plugins. After updating the plugin states,
     * it triggers an update for the plugins if necessary.
     *
     * @param {Gio.Settings} settings - The settings object containing the plugin configurations.
     * @param {string} key - The key that was changed in the settings.
     * @returns {void}
     */
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

    /**
     * Handles changes in plugin settings.
     *
     * This method is triggered when there are changes to the plugin settings. It updates
     * the lists of disabled, supported, and enabled plugins based on the settings.
     * If a plugin's status has changed (i.e., it has been enabled or disabled), the list
     * of enabled plugins is updated, and the plugin update process is triggered.
     *
     * @param {string} name - The name of plugin
     * @returns {void}
     */
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

    /**
     * Toggles the status of a plugin (enable/disable).
     *
     * This method is responsible for adding or removing a plugin from the list of disabled plugins
     * based on the current state. It is typically invoked when the user toggles a plugin's
     * enabled/disabled state in the UI. The plugin's status is then saved back to the settings.
     *
     * @param {Gtk.Widget} widget - The widget that triggered the toggle action. The widget's name is used
     *                              to identify which plugin is being toggled.
     * @returns {void}
     */
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


    /**
     * Displays a dialog with encryption information for the device.
     *
     * This method is triggered when the user requests to view the encryption information of the device.
     * It creates a dialog window that shows details about the device's encryption status. The dialog
     * includes a heading, a body with the encryption information, and an "Ok" button to close the dialog.
     *
     * @returns {void}
     */
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

    /**
     * Activates a specified action in the device's action group.
     *
     * This method triggers the activation of a specific action within the device's action group.
     * The action is identified by its name, and an optional parameter can be passed to the action if required.
     * This method is typically used for executing predefined actions associated with a device,
     * such as enabling a feature or handling a specific command.
     *
     * @param {Gio.SimpleAction} action - The action to be activated.
     * @param {any} parameter - The parameter to pass to the action, if applicable.
     *
     * @returns {void}
     */

    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    /**
     * Updates the UI with the current keybindings.
     *
     * This method retrieves the current keybindings from the settings and applies them to the corresponding UI elements.
     * It updates the label for each action in the `shortcuts_actions_list_rows` to display the correct keyboard shortcut
     * or a "Disabled" label if no keybinding is set for the action.
     *
     * @returns {void}
     */
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

    /**
     * Populates the list of applications with notification settings.
     *
     * This method queries the available applications and dynamically creates a switch row for each application.
     * The switch row represents whether notifications are enabled for each application. When the active state of
     * the switch is toggled, it triggers the `_toggleNotification` method to handle the state change.
     *
     * @param {Gio.Settings} settings - The settings object used to query and configure notification settings for applications.
     * @returns {void}
     */
    _populateApplications(settings) {
        const applications = this._queryApplications(settings);

        for (const name in applications) {
            const row = new Adw.SwitchRow({
                title: name,
                icon_name: applications[name].iconName,
                active: applications[name].enabled,
            });
            row.connect('notify::active', this._toggleNotification.bind(this));
            this.notification_apps.add(row);
        }
    }

    /**
     * Toggles the notification setting for a specific application.
     *
     * This method is called when a notification toggle (such as a switch) is clicked. It retrieves
     * the current state of the application's notification setting, toggles it, and then updates the
     * settings to reflect the new state. If an error occurs, it is logged for debugging.
     *
     * @param {Gtk.Widget} widget - The widget that was clicked to toggle the notification setting.
     * @returns {void}
     */
    _toggleNotification(widget) {
        try {
            const row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            const settings = this._pluginSettings('notification');
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

    /**
     * Adds a keybinding entry for a given plugin.
     *
     * This method creates a new row for the specified plugin keybinding, including its icon and label,
     * and adds it to the list of shortcut actions. The row is configured with an accelerator label that
     * indicates whether the keybinding is enabled or not. The keybinding is stored as part of the
     * `shortcuts_actions_list_rows` for later reference.
     *
     * @param {string} name - The name of the plugin for which to add the keybinding.
     * @returns {void}
     */
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

    /**
     * Queries and returns a list of applications that support notifications.
     *
     * This method scans all installed applications and checks if they have declared the ability to show notifications.
     * Applications that don't support notifications or are excluded (e.g., GSConnect) are ignored. The method returns a
     * list of applications with their names, icons, and enabled status, and stores this data in the settings.
     *
     * @param {Gio.Settings} settings - The GSettings object used to store and retrieve the applications data.
     * @returns {object} applications - An object containing application names as keys, with values holding the icon name and enabled status.
     */
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
     * Handles the editing of a command.
     *
     * This method is triggered when the edit button is clicked. It either initializes a new `CommandEditor`
     * if one doesn't already exist, or updates the `CommandEditor` with the details of an existing command.
     * If the button is clicked on an existing command row, it fetches the UUID, name, and command line of the
     * command and loads them into the editor. If the button is not clicked on a specific row, it creates a new,
     * empty command for editing.
     *
     * @param {Gtk.Widget} widget - The widget that triggered the edit action (typically a button).
     */
    _onEditCommand(widget) {
        if (this._commandEditor === undefined)
            this._commandEditor = new CommandEditor();


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

    /**
     * Handles the command editing process, either opening an existing command for editing or preparing a new command.
     *
     * This method is invoked when a button related to a command is clicked. If the button is part of an existing command,
     * it initializes the command editor with the command's details (UUID, name, and command line). If the button is for
     * creating a new command, it prepares the editor with empty fields. The editor is then presented to the user in a dialog window.
     *
     * @param {Gio.ActionGroup} settings - The settings action group
     * @param {string} key - The param key
     */
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

    /**
     * Retrieves and caches the settings for a specific plugin.
     *
     * This method checks if the settings for the given plugin are already cached. If they are not cached,
     * it loads the plugin's metadata, retrieves its settings schema, and creates a new `Gio.Settings` object
     * to manage the plugin's settings. The settings are then cached for future use to improve performance.
     *
     * @param {string} name - The name of the plugin whose settings are to be retrieved.
     * @returns {Gio.Settings} The settings object for the specified plugin.
     */
    _pluginSettings(name) {
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

    /**
     * Handles the deletion of a command.
     *
     * This method is called when a command's delete button is clicked. It retrieves the corresponding
     * command row, removes the command from the `_commands` store, and then destroys the row. Afterward,
     * it calls `_storeCommands` to save the updated list of commands.
     *
     * @param {Gtk.Button} button - The button that triggered the deletion action.
     */
    _onDeleteCommand(button) {
        const row = button.get_ancestor(Gtk.ListBoxRow.$gtype);
        delete this._commands[row.command_name];
        row.destroy();
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

    /**
     * Sets a custom charge level for battery notifications.
     *
     * This method retrieves the current value from the `spin` widget and updates the
     * `custom-battery-notification-value` setting in the 'battery' plugin settings with
     * the new value. It allows users to define a specific battery charge level at which
     * notifications will be triggered.
     *
     * @param {Gtk.SpinButton} spin - The SpinButton widget used to set the custom charge level.
     * @returns {void}
     */
    _setCustomChargeLevel(spin) {
        const settings = this._pluginSettings('battery');
        settings.set_uint('custom-battery-notification-value', spin.get_value());
    }

    /**
     * Opens a file dialog to allow the user to select a directory for receiving files.
     *
     * When the user selects a folder, the method updates the 'receive-directory' setting with the chosen
     * folder path, if it differs from the current setting. The dialog is presented with the title "Seleziona
     * un file" (Select a file), and the selected directory path is stored in the plugin's settings.
     *
     * @param {Gtk.Button} button - The button that triggered the directory selection.
     * @returns {void}
     */
    _onReceiveDirectorySet(button) {
        const win = Gtk.Application.get_default().get_active_window();
        const fileDialog = new Gtk.FileDialog({
            title: _('Select Folder'),
        });

        fileDialog.select_folder(win, null, (dialog, response) => {
            const filename = fileDialog.select_folder_finish(response);
            const settings = this._pluginSettings('share');
            const receiveDir = settings.get_string('receive-directory');
            if (filename.get_path() !== receiveDir)
                settings.set_string('receive-directory', filename.get_path());
        });
    }

    /**
     * Cleans up and disposes of resources used by the device settings and plugins.
     *
     * This method ensures proper cleanup by:
     * - Destroying the command editor if it exists.
     * - Disconnecting device action signals.
     * - Running disposal for plugin settings.
     * - Disconnecting GSettings signals.
     *
     * It is important to call this method to release any allocated resources when the object is no longer needed.
     *
     * @returns {void}
     */
    /*
    vfunnc_finalize() {
        if (this._commandEditor !== undefined)
            this._commandEditor.destroy();

        // Device signals
        this.device.action_group.disconnect(this._actionAddedId);
        this.device.action_group.disconnect(this._actionRemovedId);

        // GSettings
        for (const settings of Object.values(this._pluginSettings))
            settings.destroy();

        this.settings.disconnect(this._keybindingsId);
        this.settings.disconnect(this._disabledPluginsId);
        this.settings.disconnect(this._supportedPluginsId);
        this.settings.destroy();
        super.vfunnc_finalize();
    }
*/

    /**
     * Updates the visibility and activity state of plugin rows based on supported and enabled plugins.
     *
     * This method iterates through each row in the plugin list, and for each row, it checks if the plugin is
     * included in the supported and enabled plugins. It updates the row's visibility and active state accordingly.
     *
     * @param {object} settings - The settings object, used to determine plugin states.
     * @param {string} key - The specific key that triggered the update (if applicable).
     * @returns {void}
     */
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
