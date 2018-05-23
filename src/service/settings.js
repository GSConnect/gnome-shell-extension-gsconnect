'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

// Local Imports
imports.searchPath.unshift(gsconnect.datadir);
const DBus = imports.modules.dbus;


const AllowMap = new Map([
    [1, _('Off')],
    [2, _('To Device')],
    [4, _('From Device')],
    [6, _('Both')]
]);


function section_separators(row, before) {
    if (before) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


function switcher_separators(row, before) {
    if (before && row.type !== before.type) {
        row.set_header(new Gtk.Separator({ visible: true }));
    }
};


function actionSwitch(settings, widget, name) {
    widget.active = (settings.get_strv('action-blacklist').indexOf(name) < 0);

    settings.bind_with_mapping(
        'action-blacklist',
        widget,
        'active',
        0,
        variant => { widget.active = (variant.deep_unpack().indexOf(name) < 0); },
        value => {
            let current = settings.get_strv('action-blacklist');

            if (!value) {
                current.push(name);
            } else {
                current.splice(current.indexOf(name), 1);
            }

            settings.set_strv('action-blacklist', current)
        }
    );
}


/**
 * A simple dialog for selecting a device
 */
var DeviceChooser = GObject.registerClass({
    GTypeName: 'GSConnectDeviceChooser'
}, class DeviceChooserDialog extends Gtk.Dialog {

    _init(params) {
        super._init({
            use_header_bar: true,
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        // HeaderBar
        let headerBar = this.get_header_bar();
        headerBar.title = _('Select a Device');
        headerBar.subtitle = params.title;
        headerBar.show_close_button = false;

        let selectButton = this.add_button(_('Select'), Gtk.ResponseType.OK);
        selectButton.sensitive = false;
        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        // Device List
        let scrolledWindow = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.get_content_area().add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect('row-activated', (list, row) => {
            this.response(Gtk.ResponseType.OK);
        });
        this.list.connect('selected-rows-changed', (list) => {
            selectButton.sensitive = (list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        this._populate(params.devices);
        scrolledWindow.show_all();
    }

    _populate(devices) {
        for (let device of devices) {
            let row = new Gtk.ListBoxRow();
            row.device = device;
            this.list.add(row);

            let box = new Gtk.Box({
                margin: 6,
                spacing: 6
            });
            row.add(box);

            let icon = new Gtk.Image({
                icon_name: device.type,
                pixel_size: 32
            });
            box.add(icon);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true
            });
            box.add(name);
        }
    }
});


/**
 * A row for a stack sidebar
 */
var SidebarRow = GObject.registerClass({
    GTypeName: 'GSConnectSidebarRow'
}, class SidebarRow extends Gtk.ListBoxRow {

    _init(params) {
        super._init({
            selectable: true,
            visible: true
        });

        this.type = params.type || undefined;
        this.set_name(params.name);

        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_left: 8,
            margin_right: 8,
            margin_bottom: 12,
            margin_top: 12,
            visible: true
        });
        this.add(this.box);

        this.icon = new Gtk.Image({
            icon_name: params.icon,
            pixel_size: 16,
            visible: true
        });
        this.box.add(this.icon);

        this.title = new Gtk.Label({
            label: params.title,
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        this.box.add(this.title);

        // A '>' image for rows that are like submenus
        if (params.show_go_next) {
            this.go_next = new Gtk.Image({
                icon_name: 'go-next-symbolic',
                pixel_size: 16,
                halign: Gtk.Align.END,
                visible: true
            });
            this.box.add(this.go_next);
        }
    }
});


/**
 * A row for a section of settings
 */
var SectionRow = GObject.registerClass({
    GTypeName: 'GSConnectSectionRow'
}, class SidebarRow extends Gtk.ListBoxRow {

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
        'headerbar',
        'headerbar-title', 'headerbar-subtitle', 'headerbar-edit', 'headerbar-entry',
        'prev-button', 'device-menu',
        'stack', 'switcher', 'sidebar',
        'shell-list',
        'show-indicators', 'show-offline', 'show-unpaired', 'show-battery',
        'extensions-list',
        'nautilus-integration',
        'advanced-list',
        'debug', 'debug-window', 'debug-restart',
        'help', 'help-list'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(this));
        });

        super._init(params);

        // Header Bar
        this.headerbar_title.label = this.application.name;
        this.headerbar_subtitle.label = null;

        // Sidebar
        this.help.type = 'device';
        this.switcher.set_header_func(switcher_separators);
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // Init UI Elements
        this._serviceSettings();

        // Broadcasting
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            this._onRefresh.bind(this)
        );

        // Setup devices
        this._serviceDevices = this.application.connect(
            'notify::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged();
    }

    _onRefresh() {
        if (this.visible && this.sidebar.get_visible_child_name() === 'switcher') {
            this.application.broadcast();
        }

        return true;
    }

    /**
     * HeaderBar Callbacks
     */
    _onPrevious(button, event) {
        this.headerbar_title.label = this.application.name;
        this.headerbar_subtitle.visible = false;
        this.headerbar_edit.visible = true;
        this.sidebar.set_visible_child_name('switcher');

        this.switcher.get_row_at_index(0).emit('activate');
        this.prev_button.visible = false;

        this.device_menu.visible = false;
        this.device_menu.insert_action_group('device', null);
        this.device_menu.menu_model = null;
    }

    _onEditServiceName(button, event) {
        this.headerbar_entry.text = this.application.name;
        this.headerbar_entry.visible = true;
        this.headerbar_title.visible = false;
        this.headerbar_edit.visible = false;
    }

    _onSetServiceName(button, event) {
        this.application.name = this.headerbar_entry.text;
        this.headerbar_title.label = this.application.name;

        this.headerbar_entry.visible = false;
        this.headerbar_title.visible = true;
        this.headerbar_edit.visible = true;
    }

    /**
     * Context Switcher
     */
    _onSwitcherRowSelected(box, row) {
        // I guess this is being called before the template children are ready
        if (!this.stack) { return; }

        row = row || this.switcher.get_row_at_index(0);
        let name = row.get_name() || null;

        this.stack.set_visible_child_name(name);

        if (this.sidebar.get_child_by_name(name)) {
            let device = this.stack.get_visible_child().device;

            this.headerbar_title.label = row.title.label;
            this.headerbar_subtitle.label = this.stack.get_visible_child().device_type.label;
            this.headerbar_subtitle.visible = true;
            this.headerbar_edit.visible = false;

            this.sidebar.set_visible_child_name(name);
            this.prev_button.visible = true;

            this.device_menu.insert_action_group('device', device);
            this.device_menu.set_menu_model(device.menu);
            this.device_menu.visible = true;
        }
    }

    /**
     * UI Setup and template connecting
     */
    _serviceSettings() {
        // Shell
        this.shell_list.foreach(this._setGlobalRow);
        this.shell_list.set_header_func(section_separators);

        // Extensions
        // TODO: these should go..
        this.extensions_list.foreach(this._setGlobalRow);
        this.extensions_list.set_header_func(section_separators);

        // Advanced/Debug
        this.advanced_list.foreach(this._setGlobalRow);
        this.debug_window.connect('clicked', () => {
            GLib.spawn_command_line_async(
                'gnome-terminal ' +
                '--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ' +
                '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
            );
        });
        this.debug_restart.connect('clicked', () => this.application.quit());
        this.advanced_list.set_header_func(section_separators);
    }

    _setGlobalRow(row) {
        let label = row.get_child().get_child_at(1, 0);
        let name = label.get_name();

        if (!(label instanceof Gtk.Label)) {
            return;
        }

        label.label = gsconnect.settings.get_boolean(name) ? _('On') : _('Off');
    }

    _onGlobalRowActivated(box, row) {
        let label = row.get_child().get_child_at(1, 0);
        let name = label.get_name();

        gsconnect.settings.set_boolean(name, !gsconnect.settings.get_boolean(name));
        label.label = (label.label === _('On')) ? _('Off') : _('On');
    }

    _onDevicesChanged() {
        for (let dbusPath of this.application.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(dbusPath);
            }
        }

        this.stack.foreach(child => {
            if (child.row) {
                let name = child.row.get_name();
                if (this.application.devices.indexOf(name) < 0) {
                    this.stack.get_child_by_name(name).destroy();
                }
            }
        });

        this.help.visible = !this.application.devices.length;
    }

    addDevice(dbusPath) {
        let device = this.application._devices.get(dbusPath);

        // Create a new device widget
        let panel = new DeviceSettings(device);

        // Add device to switcher, and panel stack
        this.stack.add_titled(panel, dbusPath, device.name);
        this.sidebar.add_named(panel.switcher, dbusPath);
        this.switcher.add(panel.row);
    }
});


var DeviceSettings = GObject.registerClass({
    GTypeName: 'GSConnectDeviceSettings',
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
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/device.ui',
    Children: [
        'switcher',
        // Device
        'device-icon', 'device-name', 'device-type',
        'battery-level', 'battery-percent', 'battery-condition',
        'device-status-list',
        'device-connected', 'device-connected-image', 'device-connected-text',
        'device-paired', 'device-paired-image', 'device-paired-text',
        // RunCommand
        'commands', 'runcommand-allow', 'command-list',
        'command-new', 'command-editor',
        'command-icon', 'command-name', 'command-line',
        'command-trash', 'command-save',
        // Notifications
        'notification', 'notification-page',
        'notification-allow', 'notification-apps',
        // Sharing
        'sharing', 'sharing-page', 'sharing-list',
        'battery-allow', 'share-allow', 'clipboard-allow', 'mpris-allow',
        'mousepad-allow', 'findmyphone-allow',
        // Telephony
        'telephony',
        'sms-list',
        'ringing-list', 'ringing-volume', 'ringing-pause',
        'talking-list', 'talking-volume', 'talking-microphone', 'talking-pause',
        // Events
        'events-list',
        //TODO
        // Shortcuts
        'action-shortcuts-list', 'command-shortcuts-list',
        // Advanced
        'action-blacklist', 'event-blacklist'
    ]
}, class DeviceSettings extends Gtk.Stack {

    _init(device) {
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(this));
        });

        super._init();

        this.service = Gio.Application.get_default();
        this.device = device;

        // Device Status
        this.connect('notify::connected', this._onConnected.bind(this));
        this.device.bind_property('connected', this, 'connected', GObject.BindingFlags.SYNC_CREATE);

        this.connect('notify::paired', this._onPaired.bind(this));
        this.device.bind_property('paired', this, 'paired', GObject.BindingFlags.SYNC_CREATE);

        this.device_status_list.set_header_func(section_separators);

        // Sidebar Row
        this.row = new SidebarRow({
            icon: this._getSymbolicIcon(),
            title: device.name,
            type: 'device',
            name: device._dbus.get_object_path(),
            show_go_next: true
        });

        // Info Pane
        this.device_name.label = this.device.name;
        this.device_type.label = this.device.display_type;
        this.device_icon.icon_name = this.device.icon_name;

        // Settings Pages
        //this._batteryBar();
        this._sharingSettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._telephonySettings();

        this._keybindingSettings();
        this._eventsSettings();
        this._actionSettings();

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

        // Cleanup
        this.connect('destroy', (widget) => {

            widget.switcher.destroy();
            widget.row.destroy();
            widget.device.disconnect(widget._actionAddedId);
            widget.device.disconnect(widget._actionRemovedId);
            widget.device.disconnect(widget._actionEnabledId);
            widget.device.settings.disconnect(widget._keybindingsId);

            if (widget._batteryId) {
                widget.device._plugins.get('battery').disconnect(
                    widget._batteryId
                );
            }
        });
    }

    _getSymbolicIcon(widget) {
        if (!this.paired) {
            let icon = this.device.icon_name;
            icon = (icon === 'computer') ? 'desktop' : icon;
            return icon + 'disconnected';
        }

        return this.device.icon_name + '-symbolic';
    }

    _getSettings(name) {
        if (this._gsettings === undefined) {
            this._gsettings = {};
        }

        if (this._gsettings[name]) {
            return this._gsettings[name];
        }

        if (this.device.supportedPlugins().indexOf(name) > -1) {
            let meta = imports.service.plugins[name].Metadata;

            this._gsettings[name] = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(meta.id, -1),
                path: `${gsconnect.settings.path}device/${this.device.id}/plugin/${name}/`
            });
        }

        return this._gsettings[name] || false;
    }

    _onActionsChanged() {
        this._populateKeybindings();
        this._populateActions();
    }

    _onConnected() {
        if (this.connected) {
            this.device_connected_image.icon_name = 'emblem-ok-symbolic';
            this.device_connected_text.label = _('Device is connected');
            this.device_connected.set_tooltip_markup(null);
        } else {
            this.device_connected_image.icon_name = 'emblem-synchronizing-symbolic';
            this.device_connected_text.label = _('Device is disconnected');
            this.device_connected.set_tooltip_markup(
                // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                _('Reconnect <b>%s</b>').format(this.device.name)
            );
        }

        this._onPaired();
    }

    _onPaired() {
        if (this.paired) {
            this.device_paired_image.icon_name = 'application-certificate-symbolic';
            this.device_paired_text.label = _('Device is paired');
            this.device_paired.set_tooltip_markup(
                // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                _('Unpair <b>%s</b>').format(this.device.name)
            );

            this.device_paired.sensitive = true;
        } else {
            this.device_paired_image.icon_name = 'channel-insecure-symbolic';
            this.device_paired_text.label = _('Device is unpaired');
            this.device_paired.set_tooltip_markup(
                // TRANSLATORS: eg. Pair <b>Google Pixel</b>
                _('Pair <b>%s</b>').format(this.device.name) + '\n\n' +
                // TRANSLATORS: Remote and local TLS Certificate fingerprint
                // PLEASE KEEP NEWLINE CHARACTERS (\n)
                //
                // Example:
                //
                // <b>Google Pixel Fingerprint:</b>
                // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                //
                // <b>Local Fingerprint:</b>
                // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                _('<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s').format(
                    this.device.name,
                    this.device.fingerprint,
                    this.service.fingerprint
                )
            );

            this.device_paired.sensitive = this.connected;
        }

        if (this.row) {
            this.row.icon_name = this._getSymbolicIcon();
        }
    }

    _onStatusRowActivated(box, row) {
        if (row === this.device_connected) {
            this.device.activate();
        } else if (row === this.device_paired) {
            this.device.paired ? this.device.unpair() : this.device.pair();
        }
    }

    _onSwitcherRowSelected(box, row) {
        this.set_visible_child_name(row.get_name());
    }

    /**
     * Battery Level
     */
    _batteryBar() {
        let battery = this.device._plugins.get('battery');

        if (battery) {
            this.battery_level.get_style_context().add_class('battery-bar');

            this._batteryId = battery.connect('notify', (plugin) => {
                let level = plugin.level;

                this.battery_level.visible = (level > -1);
                this.battery_condition.visible = (level > -1);
                this.battery_percent.visible = (level > -1);

                if (level > -1) {
                    this.battery_level.value = level;
                    this.battery_percent.label = _('%d%%').format(level);

                    if (battery.charging) {
                        this.battery_condition.label = _('Charging…');
                    } else if (level < 10) {
                        this.battery_condition.label = _('Caution');
                    } else if (level < 30) {
                        this.battery_condition.label = _('Low');
                    } else if (level < 60) {
                        this.battery_condition.label = _('Good');
                    } else if (level >= 60) {
                        this.battery_condition.label = _('Full');
                    }
                }
            });

            battery.notify('level');
            battery.connect('destroy', () => {
                this.battery_level.visible = false;
                this.battery_condition.visible = false;
                this.battery_percent.visible = false;
            });
        } else {
            this.battery_level.visible = false;
            this.battery_condition.visible = false;
            this.battery_percent.visible = false;
        }
    }

    /**
     * Basic Settings
     */
    _sharingSettings() {
        // Battery
        if (!this.device.get_action_enabled('reportStatus')) {
            this.battery_allow.get_parent().get_parent().visible = false;
        }

        // Separators & Sorting
        this.sharing_list.set_header_func(section_separators);

        this.sharing_list.set_sort_func((row1, row2) => {
            row1 = row1.get_child().get_child_at(0, 0);
            row2 = row2.get_child().get_child_at(0, 0);
            return row1.label.localeCompare(row2.label);
        });

        this.sharing_list.foreach(row => {
            let label = row.get_child().get_child_at(1, 0);
            let name = label.get_name().split('-')[0];
            let settings = this._getSettings(name);
            let blacklist = this.device.settings.get_strv('action-blacklist');

            if (name === 'clipboard') {
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
            } else if (name ==='findmyphone') {
                if (blacklist.indexOf('locationAnnounce') < 0) {
                    label.label = _('On');
                } else {
                    label.label = _('Off');
                }
            } else if (name === 'share') {
                if (blacklist.indexOf('shareDialog') < 0) {
                    label.label = _('On');
                } else {
                    label.label = _('Off');
                }
            }
        });
    }

    _onSharingRowActivated(box, row) {
        let label = row.get_child().get_child_at(1, 0);
        let name = label.get_name().split('-')[0];
        let settings = this._getSettings(name);
        let blacklist = this.device.settings.get_strv('action-blacklist');
        let index;

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

            case 'findmyphone':
                index = blacklist.indexOf('locationAnnounce');

                if (index < 0) {
                    blacklist.push('locationAnnounce');
                    label.label = _('Off');
                } else {
                    blacklist.splice(index, 1);
                    label.label = _('On');
                }

                this.device.settings.set_strv('action-blacklist', blacklist);
                break;

            case 'share':
                index = blacklist.indexOf('shareDialog');

                if (index < 0) {
                    blacklist.push('shareDialog');
                    label.label = _('Off');
                } else {
                    blacklist.splice(index, 1);
                    label.label = _('On');
                }

                this.device.settings.set_strv('action-blacklist', blacklist);
                break;
        }
    }

    /**
     * RunCommand Page
     * TODO: maybe action<->commands?
     */
    _runcommandSettings() {
        let runcommand = (this.device.supportedPlugins().indexOf('runcommand') > -1);

        if (runcommand) {
            let settings = this._getSettings('runcommand');
            actionSwitch(this.device.settings, this.runcommand_allow, 'executionRequest');

            // Local Command List
            this._commands = gsconnect.full_unpack(
                settings.get_value('command-list')
            );

            this.runcommand_allow.bind_property(
                'active',
                this.command_list,
                'sensitive',
                GObject.BindingFlags.SYNC_CREATE
            );

            this.command_list.set_sort_func((row1, row2) => {
                // The [+] button
                if (row1.get_child() instanceof Gtk.Image) {
                    return 1;
                } else if (row2.get_child() instanceof Gtk.Image) {
                    return -1;
                // Compare uuid???
                } else if (row1.uuid && row1.uuid === row2.get_name()) {
                    return 1;
                } else if (row2.uuid && row2.uuid === row1.get_name()) {
                    return -1;
                // Shouldn't happen?!
                } else if (!row1.title || !row2.title) {
                    return 0;
                }

                return row1.title.localeCompare(row2.title);
            });
            this.command_list.set_header_func(section_separators);
            this._populateCommands();
        } else {
            this.commands.visible = false;
        }
    }

    _onCommandNameChanged(entry) {
        this.command_icon.gicon = new Gio.ThemedIcon({
            names: [ entry.text.toLowerCase(), 'application-x-executable' ]
        });
    }

    _insertCommand(uuid) {
        let row = new SectionRow({
            icon_name: this._commands[uuid].name.toLowerCase(),
            title: this._commands[uuid].name,
            subtitle: this._commands[uuid].command,
            widget: new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: 'document-edit-symbolic',
                    pixel_size: 16,
                    visible: true
                }),
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            }),
            activatable: false
        });
        row.set_name(uuid);
        row._subtitle.ellipsize = Pango.EllipsizeMode.MIDDLE;
        row.widget.get_style_context().add_class('circular');
        row.widget.get_style_context().add_class('flat');
        row.widget.connect('clicked', this._onEditCommand.bind(this));

        this.command_list.add(row);

        return row;
    }

    // The '+' row at the bottom of the command list
    _onAddCommand(box, row) {
        if (row === this.command_new) {
            let uuid = GLib.uuid_string_random();
            this._commands[uuid] = { name: '', command: '' };
            this._onEditCommand(this._insertCommand(uuid).widget, uuid);
        }
    }

    // The 'edit' icon in the GtkListBoxRow of a command
    _onEditCommand(button) {
        let row = button.get_parent().get_parent();
        let uuid = row.get_name();

        this.command_editor.uuid = uuid;
        this.command_name.text = this._commands[uuid].name.slice(0);
        this.command_line.text = this._commands[uuid].command.slice(0);

        this.command_editor.title = { label: this.command_name.text };
        row.visible = false;

        this.command_new.visible = false;
        this.command_editor.visible = true;
        this.command_list.invalidate_sort();
    }

    // The 'folder' GtkEntry icon in the command editor
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

    // The 'trash' icon in the command editor
    _onRemoveCommand(button) {
        delete this._commands[this.command_editor.uuid];

        this._getSettings('runcommand').set_value(
            'command-list',
            gsconnect.full_pack(this._commands)
        );

        this._populateCommands();
    }

    // The 'save' icon in the command editor
    _onSaveCommand() {
        if (this.command_name.text && this.command_line.text) {
            let cmd = this._commands[this.command_editor.uuid];
            cmd.name = this.command_name.text.slice(0);
            cmd.command = this.command_line.text.slice(0);
        } else {
            delete this._commands[this.command_editor.uuid];
        }

        this._getSettings('runcommand').set_value(
            'command-list',
            gsconnect.full_pack(this._commands)
        );

        this._populateCommands();
    }

    _populateCommands() {
        delete this.command_editor.title;
        delete this.command_editor.uuid;
        this.command_name.text = '';
        this.command_line.text = '';

        this.command_list.foreach(row => {
            if (row !== this.command_new && row !== this.command_editor) {
                row.destroy();
            }
        });

        this.command_new.visible = true;
        this.command_editor.visible = false;

        for (let uuid in this._commands) {
            this._insertCommand(uuid);
        }
    }

    /**
     * Notification Settings
     */
    _notificationSettings() {
        let settings = this._getSettings('notification');

        actionSwitch(
            this.device.settings,
            this.notification_allow,
            'sendNotification'
        );

        this.notification_allow.bind_property(
            'active',
            this.notification_apps,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Populate, sort and separate
        this._populateApplications(settings);
        this.notification_apps.set_sort_func((row1, row2) => {
            return row1.title.localeCompare(row2.title);
        });
        this.notification_apps.set_header_func(section_separators);
    }

    _onNotificationRowActivated(box, row) {
        let settings = this._getSettings('notification');
        let applications = JSON.parse(settings.get_string('applications'));
        applications[row.title].enabled = !applications[row.title].enabled;
        row.widget.label = (applications[row.title].enabled) ? _('On') : _('Off');


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

    _queryApplications(notification) {
        let applications = {};

        try {
            applications = JSON.parse(notification.get_string('applications'));
        } catch (e) {
            applications = {};
        }

        let appInfos = [];
        let ignoreId = 'org.gnome.Shell.Extensions.GSConnect.desktop';

        // Query Gnome's notification settings
        for (let app of this.service._desktopNotificationSettings.get_strv('application-children')) {
            let appSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications.application',
                path: '/org/gnome/desktop/notifications/application/' + app + '/'
            });

            let appId = appSettings.get_string('application-id');

            if (appId !== ignoreId) {
                let appInfo = Gio.DesktopAppInfo.new(appId);

                if (appInfo) {
                    appInfos.push(appInfo);
                }
            }
        }

        // Include applications that statically declare to show notifications
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

        notification.set_string('applications', JSON.stringify(applications));

        return applications;
    }

    /**
     * Telephony Settings
     */
    _telephonySettings() {
        if (this.device.supportedPlugins().indexOf('telephony') > -1) {
            let settings = this._getSettings('telephony');

            // SMS
            this.sms_list.set_header_func(section_separators);

            // Incoming Calls
            settings.bind(
                'ringing-volume',
                this.ringing_volume,
                'active-id',
                Gio.SettingsBindFlags.DEFAULT
            );
            settings.bind(
                'ringing-pause',
                this.ringing_pause,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            this.ringing_list.set_header_func(section_separators);

            // In Progress Calls
            settings.bind(
                'talking-volume',
                this.talking_volume,
                'active-id',
                Gio.SettingsBindFlags.DEFAULT
            );
            settings.bind(
                'talking-microphone',
                this.talking_microphone,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            settings.bind(
                'talking-pause',
                this.talking_pause,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            this.talking_list.set_header_func(section_separators);
        } else {
            this.telephony.visible = false;
        }
    }

    /**
     * Keyboard Shortcuts
     */
    _keybindingSettings() {
        this._keybindingsId = this.device.settings.connect(
            'changed::keybindings',
            this._populateKeybindings.bind(this)
        );
        this._populateKeybindings();
    }

    _populateKeybindings() {
        this.action_shortcuts_list.foreach(row => row.destroy());

        let keybindings = gsconnect.full_unpack(
            this.device.settings.get_value('keybindings')
        );

        if (typeof keybindings === 'string') {
            iface.settings.set_value(
                'keybindings',
                new GLib.Variant('a{sv}', {})
            );
            return;
        }

        for (let name of this.device.list_actions().sort()) {
            let action = this.device.lookup_action(name)

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
                row.action = action;
                this.action_shortcuts_list.add(row);
            }
        }

        this.action_shortcuts_list.set_header_func(section_separators);
        this.action_shortcuts_list.set_sort_func((row1, row2) => {
            return row1.title.localeCompare(row2.title);
        });
    }

    _onShortcutRowActivated(box, row) {
        let dialog = new ShortcutEditor({
            summary: row.action.summary,
            transient_for: box.get_toplevel()
        });

        dialog.connect('response', (dialog, response) => {
            if (response !== Gtk.ResponseType.CANCEL) {
                // Get current keybindings
                let keybindings = gsconnect.full_unpack(
                    this.device.settings.get_value('keybindings')
                );

                if (response === Gtk.ResponseType.OK) {
                    keybindings[row.action.name] = dialog.accelerator;
                // Reset (Backspace)
                } else if (response === 1) {
                    delete keybindings[row.action.name];
                }

                this.device.settings.set_value(
                    'keybindings',
                    gsconnect.full_pack(keybindings)
                );
            }

            dialog.destroy();
        });

        dialog.run();
    }

    /**
     * Events Settings
     */
    _eventsSettings() {
        this.events_list.set_header_func(section_separators);
    }

    _onEventRowActivated(box, row) {
    }

    /**
     * Actions
     */
    _actionSettings() {
        this._populateActions();

        this.action_blacklist.connect('row-activated', (box, row) => {
            let action = this.device.lookup_action(row.action.name);
            let blacklist = this.device.settings.get_strv('action-blacklist');
            let index = blacklist.indexOf(row.action.name);

            if (index < 0) {
                blacklist.push(row.action.name);
            } else {
                blacklist.splice(index, 1);
            }

            this.device.settings.set_strv('action-blacklist', blacklist);
        });

        this.action_blacklist.set_header_func(section_separators);
    }

    _populateActions() {
        this.action_blacklist.foreach(row => row.destroy());

        for (let name of this.device.list_actions().sort()) {
            let action = this.device.lookup_action(name);
            let blacklist = this.device.settings.get_strv('action-blacklist');
            let status;

            if (blacklist.indexOf(name) > -1) {
                status = _('Blocked');
            } else {
                status = action.enabled ? _('Enabled'): _('Disabled');
            }

            let widget = new Gtk.Label({
                label: status,
                visible: true
            });
            widget.get_style_context().add_class('dim-label');

            let row = new SectionRow({
                icon_name: action.icon_name,
                title: action.summary,
                subtitle: action.description,
                widget: widget
            });
            row._icon.pixel_size = 16;
            row.action = action;
            this.action_blacklist.add(row);
        }
    }
});


var ShellProxy = DBus.makeInterfaceProxy(
    gsconnect.dbusinfo.lookup_interface('org.gnome.Shell')
);


/**
 * Keyboard Shortcut Editor Dialog
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
        // Hack until template callbacks are supported (GJS 1.54?)
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(this));
        });

        super._init({
            transient_for: params.transient_for,
            use_header_bar: true,
            modal: true
        });

        this.seat = Gdk.Display.get_default().get_default_seat();

        this.shell = new ShellProxy({
            g_connection: Gio.DBus.session,
            g_name: 'org.gnome.Shell',
            g_object_path: '/org/gnome/Shell'
        });
        this.shell.init(null);

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

    _onKeyPressEvent(widget, event) {
        if (!this._gdkDevice) {
            return false;
        }

        let keyval = event.get_keyval()[1];
        let keyvalLower = Gdk.keyval_to_lower(keyval);

        let state = event.get_state()[1];
        let realMask = state & Gtk.accelerator_get_default_mod_mask();

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
            this.accelerator = Gtk.accelerator_name(keyvalLower, realMask);

            // Switch to confirm/conflict page
            this.stack.set_visible_child_name('confirm-shortcut');
            // Show shortcut icons
            this.shortcut_label.accelerator = this.accelerator;

            // Show the Set button if available
            if (this.check(this.accelerator)) {
                this.set_button.visible = true;
            // Otherwise report the conflict
            } else {
                this.conflict_label.visible = true;
                this.conflict_label.label = _('%s is already being used').format(
                    Gtk.accelerator_get_label(keyvalLower, realMask)
                );
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

    response(id) {
        this.hide();
        this.ungrab();
        Gtk.Dialog.prototype.response.call(this, id);

        return true;
    }

    check(accelerator) {
        // Check someone else isn't already using the binding
        let action = this.shell.GrabAcceleratorSync(accelerator, 0);

        if (action !== 0) {
            this.shell.UngrabAcceleratorSync(action);
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

