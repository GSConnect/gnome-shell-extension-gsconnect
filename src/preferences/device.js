// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw';

import Config from '../config.js';
import plugins from '../service/plugins/index.js';
import * as Keybindings from './keybindings.js';

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

function getIcon(name) {
    if (getIcon._resource === undefined) {
        getIcon._desktop = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        getIcon._resource = {};

        const iconPath = 'resource://org/gnome/Shell/Extensions/GSConnect/icons';
        const dirFile = Gio.File.new_for_uri(iconPath);

        try {
            const enumerator = dirFile.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const filename = info.get_name();

                if (filename.endsWith('.svg')) {
                    const iconName = filename.replace(/\.svg$/, '');
                    getIcon._resource[iconName] = new Gio.FileIcon({
                        file: dirFile.get_child(filename),
                    });
                }
            }

            enumerator.close(null);
        } catch (e) {
            logError(e);
        }
    }

    if (getIcon._desktop.has_icon(name)) {
        return new Gio.ThemedIcon({ name });
    }

    if (getIcon._resource[name] !== undefined) {
        return getIcon._resource[name];
    }

    return new Gio.ThemedIcon({ name });
}

/**
 * A Gtk.ListBoxSortFunc for SectionRow rows
 *
 * @param {Gtk.ListBoxRow} row1 - The first row
 * @param {Gtk.ListBoxRow} row2 - The second row
 * @returns {number} -1, 0 or 1
 */
export function titleSortFunc(row1, row2) {
    if (!row1.get_title() || !row2.get_title())
        return 0;

    return row1.get_title().localeCompare(row2.title);
}

/**
 *
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

    _onItemsChanged(model, position, removed, added) {
        // Clear the menu
        this.remove_all();
        this.buildActionRowsFromMenuModel(this.model).forEach(row => {
            this.append(row);
        });
        this.append(this._create_encription_row());
    }
    
    buildActionRowsFromMenuModel(menuModel) {
        const rows = [];
    
        const nItems = menuModel.get_n_items();
        for (let i = 0; i < nItems; i++) {
            const label = menuModel.get_item_attribute_value(i, 'label', null).get_string()[0];
            const iconName = menuModel.get_item_attribute_value(i, 'icon', null);
            const actionName = menuModel.get_item_attribute_value(i, 'action', null).get_string()[0].split('.')[1];
            const target = menuModel.get_item_attribute_value(i, 'target', null);
            const submenu = menuModel.get_item_link(i, 'submenu');

            let icon = Gio.Icon.deserialize(iconName);
            if (icon instanceof Gio.ThemedIcon)
                icon = getIcon(icon.names[0]);

            if (!label) continue;
        
            if (submenu) {
                submenu.connect(
                    'items-changed',
                    this._onItemsChanged.bind(this)
                );
                if(submenu.get_n_items() > 0) {
                
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
                    for (const row of childRows) {
                        expander.add_row(row);
                    }
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
                row.connect('activated',this._onRowActivated.bind(this, actionName, target));
                rows.push(row);
            }
        }
    
        return rows;
    }

    _create_encription_row() {
        const row = new Adw.ActionRow({
            visible: true,
            title: 'Encryption Info',
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

    destroy() {
        this.model.disconnect(this._itemsChangedId);
        super.destroy();
    }
});

/**
 * Command Editor Dialog
 */
const CommandEditor = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesCommandEditor',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-command-editor.ui',
    Children: [
        'command_entry', 'name_entry', 'save_button'
    ],
}, class CommandEditor extends Adw.Dialog {

    _init(params = {}) {
        super._init(params);
    }

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
 * Device Navigation Page
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
        'talking-volume-toogle'
    ],
}, class DeviceNavigationPage extends Adw.NavigationPage {

    _init(params = {}) {
        super._init();
        Object.assign(this, params);
        this.shortcuts_actions_list_rows = [];
        this.plugin_list_rows = [];
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${this.device.id}/`,
        });
        this._setWindowTitle()
        this._setupActions();
        this._sharingSettings();
        this._batterySettings();
        this._runcommandSettings();
        this._notificationSettings();
        // --------------------------
        this._keybindingSettings();
        this._advancedSettings();

        this.action_row_box.add(new ActionRowBox({
            action_group: this.device.action_group,
            model: this.device.menu,
        }));
    }
    
    /*
     *
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

    /*
     *
     */
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
        this._setupToggleGroup(this.ringing_volume_toogle, ringing_action)
        this.actions.add_action(settings.create_action('ringing-pause'));
        const talking_action = settings.create_action('talking-volume');
        this.actions.add_action(talking_action);
        this._setupToggleGroup(this.talking_volume_toogle, talking_action) 
        this.actions.add_action(settings.create_action('talking-pause'));
        this.actions.add_action(settings.create_action('talking-microphone'));

        if (this.device.action_group.get_action_enabled('clearCache')) {
            this.device_cache.connect("clicked", () => {
                this.device.action_group.activate_action('clearCache', null)
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

    /*
     *
     */
    _setupToggleGroup(toggle, action) {
        const state = action.get_state() ? action.get_state().deep_unpack() : null;
        if (state) {
            toggle.set_active_name(state);
            toggle.connect('notify::active-name', () => {
                const name = toggle.active_name;
                if (name && action) {
                    action.change_state(new GLib.Variant('s', name));
                }
            });
        }
    }
    
    /*
     *
     */
    get_incoming_supported(type) {
        const incoming = this.settings.get_strv('incoming-capabilities');
        return incoming.includes(`kdeconnect.${type}`);
    }

    /*
     *
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
            const hasBattery = await new Promise((resolve, reject) => {
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
                        } catch (e) {
                            resolve(false);
                        }
                    }
                );
            });

        } catch (e) {
            console.log(e)
        }
    }

    /**
     * Notification Settings
     */
    _notificationSettings() {
        const settings = this.pluginSettings('notification');
        this._populateApplications(settings);
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
            title : "Add command" ,
            start_icon_name: "list-add-symbolic"
        })
        row.connect('activated', this._onEditCommand.bind(this));
        this.command_list.add(row);
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

    /**
     * Keyboard Shortcuts
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

    /*
     *
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

    /*
     *
     */
    _addPlugin(name) {
        const plugin = plugins[name];

        const row = new Adw.SwitchRow({
            title: plugin.Metadata.label,
            subtitle: plugin.Metadata.description || '',
            visible: this._supportedPlugins.includes(name),
            active: this._enabledPlugins.includes(name)
        });
        row.connect('notify::active', this._togglePlugin.bind(this));
        row.set_name(name);

        this.plugin_list.add(row);
        this.plugin_list_rows.push(row)
    }

    /*
     *
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


    /*
     *
     */
    _onEncryptionInfo() {
        const win = Gtk.Application.get_default().get_active_window();

        const dialog = new Adw.MessageDialog({
            heading: _('Encryption Info'),
            body: this.device.encryption_info,
            transient_for: win
        });
        
        dialog.add_response("ok",  _("Ok"));

        dialog.present();
    }

    /*
     *
     */
    _deviceAction(action, parameter) {
        this.action_group.activate_action(action.name, parameter);
    }

    /*
     *
     */
    _setPluginKeybindings() {
        const keybindings = this.settings.get_value('keybindings').deepUnpack();

        this.shortcuts_actions_list_rows.forEach(row => {
            if (keybindings[row.action]) {
                const accel = Gtk.accelerator_parse(keybindings[row.action]);
                row.label.set_label(labelGtk.accelerator_get_label(...accel));
            } else {
                row.label.set_label(_('Disabled'));
            }
        });
    }

    /*
     *
     */
    _populateApplications(settings) {
        const applications = this._queryApplications(settings);

        for (const name in applications) {
            const row = new Adw.SwitchRow({
                title: name, 
                icon_name: applications[name].iconName,
                active: applications[name].enabled
            });
            row.connect('notify::active', this._toggleNotification.bind(this));
            this.notification_apps.add(row);
        }
    }

    /*
     *
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
            this.receive_directory.set_subtitle();
    }
   
    /*
     *
     */ 
    _toggleNotification(widgeclickedt) {
        try {
            const row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            const settings = this.pluginSettings('notification');
            let applications = {};
            try {
                applications = JSON.parse(settings.get_string('applications'));
            } catch (e) {
                applications = {};
            }
            applications[row.title].enabled = !applications[row.title].enabled;
            row.set_active(applications[row.title].enabled);
            settings.set_string('applications', JSON.stringify(applications));

        } catch (e) {
            logError(e);
        }
    }
    
    /*
     *
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
        })
        row.add_suffix(acc_label);
        row.action = name;
        row.label = acc_label;
        
        this.shortcuts_actions_list.append(row);
        this.shortcuts_actions_list_rows.push(row);
    }

    /*
     *
     */
    _queryApplications(settings) {
        let applications = {};

        try {
            applications = JSON.parse(settings.get_string('applications'));
        } catch (e) {
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

    /*
     *
     */
    _onEditCommand(widget) {
        if (this._commandEditor === undefined) {
            this._commandEditor = new CommandEditor();
        }

        if (widget instanceof Gtk.Button) {
            const row = widget.get_ancestor(Gtk.ListBoxRow.$gtype);
            const uuid = row.get_command_name();
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

    /*
     *
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

    /*
     *
     */
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

    /*
     *
     */
    _onDeleteCommand(button) {
        const row = button.get_ancestor(Gtk.ListBoxRow.$gtype);
        delete this._commands[row.get_command_name()];
        row.destroy();
        this._storeCommands();
    }

    /*
     *
     */
    _insertCommand(uuid) {
        const row = new CommandActionRow({
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            command_name: uuid
        });
        row.get_edit_button().connect('clicked', this._onEditCommand.bind(this));
        row.get_delete_button().connect('clicked', this._onDeleteCommand.bind(this));
        this.command_list.add(row);
    }

    /*
     *
     */
    _setCustomChargeLevel(spin) {
        const settings = this.pluginSettings('battery');
        settings.set_uint('custom-battery-notification-value', spin.get_value());
    }

    /*
     *
     */
    _onReceiveDirectorySet(button) {
        const win = Gtk.Application.get_default().get_active_window();
        const fileDialog = new Gtk.FileDialog({
            title: "Seleziona un file",
        });
    
        fileDialog.select_folder(win, null, (dialog, response) => {
            const filename = fileDialog.select_folder_finish(response);
            console.log(filename);
            console.log(response);
            const settings = this.pluginSettings('share');
            const receiveDir = settings.get_string('receive-directory');
            if (filename.get_path() !== receiveDir)
                settings.set_string('receive-directory', filename.get_path());
        });
    }

    /*
     *
     */
    dispose() {
        if (this._commandEditor !== undefined)
            this._commandEditor.destroy();

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

    _updatePlugins(settings, key) {
        for (const row of this.plugin_list_rows) {
            const name = row.get_name();

            row.visible = this._supportedPlugins.includes(name);
            row.active = this._enabledPlugins.includes(name);
        }
    }
});

/**
 * Command Action Row
 */
export const CommandActionRow = GObject.registerClass({
    GTypeName: 'GSConnectCommandActionRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/command-row.ui',
    Children: [
        'edit_button',
        'delete_button'
    ]
}, class CommandActionRow extends Adw.ActionRow {

    _init(params = {}) {
        const command_name = params.command_name;
        delete params.command_name;
        super._init(params);
        this.command_name = command_name;
    }

    get_command_name() {
        return this.command_name
    }

    get_edit_button() {
        return this.edit_button;
    } 

    get_delete_button() {
        return this.delete_button;
    } 

});

/**
 * Device Pair Page
 */
export const DevicePairPage = GObject.registerClass({
    GTypeName: 'GSConnectDevicePairPage',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/preferences-device-pair.ui',
    Children: [
        'pair_label', 'spinner',  'pair-button'
    ]
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

    /*
     *
     */
    _pairDevice() {
        this.device.action_group.activate_action('pair', null);
        this.spinner.set_visible(true);
        this.pair_button.set_visible(false);
        this._stopSpinner();
    }

    _stopSpinner() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {      
            this.spinner.set_visible(false);
            this.pair_button.set_visible(true);
            return false;
        });
    }
    
});
