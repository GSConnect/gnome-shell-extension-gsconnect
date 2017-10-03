"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext; // FIXME

const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Common = Me.imports.common;
const PreferencesWidget = Me.imports.widgets.preferences;


/** Gtk widget for plugin enabling/disabling */
var PluginSetting = new Lang.Class({
    Name: "GSConnectPluginSetting",
    Extends: Gtk.Box,
    
    _init: function (devicePage, pluginName) {
        this.parent({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12
        });
        
        this._page = devicePage;
        this._name = pluginName;
        this._info = PluginMetadata.get(this._name);
        this._freeze = false;
        
        if (this._info.hasOwnProperty("settings")) {
            let settingButton = new Gtk.Button({
                image: Gtk.Image.new_from_icon_name(
                    "open-menu-symbolic",
                    Gtk.IconSize.BUTTON
                ),
                visible: true,
                can_focus: true,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER
            });
            
            settingButton.get_style_context().add_class("circular");
            settingButton.connect("clicked", Lang.bind(this, this._configure));
            
            this.add(settingButton);
        }
        
        this.pluginSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        this.pluginSwitch.connect("notify::active", Lang.bind(this, this._toggle));
        this.add(this.pluginSwitch);
        
        //
        this._refresh();
    },
    
    _refresh: function () {
        this._freeze = true;
        
        this.pluginSwitch.active = this._page.config.plugins[this._name].enabled;
        
        this._freeze = false;
    },
    
    _toggle: function (widget) {
        if (!this._freeze) {
            let success;
            
            if (this.pluginSwitch.active) {
                success = this._page.device.enablePlugin(this._name);
            } else {
                success = this._page.device.disablePlugin(this._name);
            }
            
            if (!success) {
                this._refresh();
                return;
            }
            
            this._page._refresh();
        }
    },
    
    _configure: function () {
        let dialog = new this._info.settings(
            this._page,
            this._name,
            this._info,
            this.get_toplevel()
        );
        
        if (dialog.run() === Gtk.ResponseType.APPLY) {
            this._page.device.configurePlugin(this._name, dialog._settings);
            this._page._refresh();
        }
        
        dialog.close();
    }
});


var PluginDialog = new Lang.Class({
    Name: "GSConnectPluginDialog",
    Extends: Gtk.Dialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent({
            title: _("FIXME pluginInfo"),
            use_header_bar: true,
            transient_for: win,
            default_height: 320,
            default_width: 480
        });
        
        let headerBar = this.get_header_bar();
        headerBar.title = pluginInfo.summary;
        headerBar.subtitle = pluginInfo.description;
        headerBar.show_close_button = false;
        
        this.add_button(_("Apply"), Gtk.ResponseType.APPLY);
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        
        this._page = devicePage;
        this._name = pluginName;
        this._info = pluginInfo;
        this._settings = this._page.config.plugins[this._name].settings;
        
        this.content = new PreferencesWidget.Page({
            height_request: -1,
            valign: Gtk.Align.FILL,
            vexpand: true,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.content.box.margin_left = 40;
        this.content.box.margin_right = 40;
        this.get_content_area().add(this.content);
    }
});


var NotificationsPluginDialog = new Lang.Class({
    Name: "GSConnectNotificationsPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        // Receiving
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let receiveSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.receive.enabled
        });
        receiveSwitch.connect("notify::active", (widget) => {
            this._settings.receive.enabled = receiveSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Receive notifications"),
            _("Enable to receive notifications from other devices"),
            receiveSwitch
        );
        
        // Sending
        let sendingSection = this.content.addSection(_("Sending"));
        
        let sendSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.send.enabled
        });
        sendSwitch.connect("notify::active", (widget) => {
            this._settings.send.enabled = sendSwitch.active;
        });
        this.content.addItem(
            sendingSection,
            _("Send notifications"),
            _("Enable to send notifications to other devices"),
            sendSwitch
        );
        
        // Applications TreeView/Model
        let appRow = this.content.addRow(sendingSection);
        appRow.grid.row_spacing = 12;
        
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true,
            margin_top: 6,
            height_request: 100
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GdkPixbuf.Pixbuf,       // iconName
            GObject.TYPE_STRING,    // appName
            GObject.TYPE_BOOLEAN    // enabled
        ]);
        this.treeview.model = listStore;
        
        // Name column.
        this.appCell = new Gtk.CellRendererText({ editable: false });
        let appCol = new Gtk.TreeViewColumn({
            title: _("Application"),
            expand: true
        });
        
        // Icon
        let iconCell = new Gtk.CellRendererPixbuf();
        appCol.pack_start(iconCell, false);
        appCol.add_attribute(iconCell, "pixbuf", 0);
        appCol.pack_start(this.appCell, true);
        appCol.add_attribute(this.appCell, "text", 1);
        this.treeview.append_column(appCol);
        
        // Enabled column.
        this.sendCell = new Gtk.CellRendererToggle();
        let sendCol = new Gtk.TreeViewColumn({ title: _("Enabled") });
        sendCol.pack_start(this.sendCell, true);
        sendCol.add_attribute(this.sendCell, "active", 2);
        this.treeview.append_column(sendCol);
        this.sendCell.connect("toggled", Lang.bind(this, this._editSend));
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        appRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        // Buttons
        let buttonBox = new Gtk.ButtonBox({ halign: Gtk.Align.END });
        appRow.grid.attach(buttonBox, 0, 1, 1, 1);
        
        let removeButton = new Gtk.Button({ label: _("Remove") });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);
        
        this._populate();
        
        this.content.show_all();
    },
    
    _remove: function (button) {
        //
        let [has, model, iter] = this.treeview.get_selection().get_selected();
        
        if (has) {
            let name = this.treeview.model.get_value(iter, 1);
            delete this._settings.send.applications[name];
            this.treeview.model.remove(iter);
        }
    },
    
    _populate: function () {
        let theme = Gtk.IconTheme.get_default()
        
        for (let name in this._settings.send.applications) {
            let pixbuf;
            
            try {
                pixbuf = theme.load_icon(
                    this._settings.send.applications[name].iconName, 0, 0
                );
            } catch (e) {
                pixbuf = theme.load_icon("application-x-executable", 0, 0);
            }
        
            this.treeview.model.set(
                this.treeview.model.append(),
                [0, 1, 2], 
                [pixbuf,
                name,
                this._settings.send.applications[name].enabled]
            );
        }
    },
    
    _editSend: function (renderer, path, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            let enabled = this.treeview.model.get_value(iter, 2);
            this.treeview.model.set_value(iter, 2, !enabled);
            let name = this.treeview.model.get_value(iter, 1);
            this._settings.send.applications[name].enabled = !enabled;
        }
    }
});


var RunCommandPluginDialog = new Lang.Class({
    Name: "GSConnectRunCommandPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        let commandsSection = this.content.addSection(_("Commands"));
        // TreeView/Model
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true,
            margin_top: 6,
            height_request: 100
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // UUID
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING     // Command
        ]);
        this.treeview.model = listStore;
        
        // Name column.
        this.nameCell = new Gtk.CellRendererText({ editable: true });
        let nameCol = new Gtk.TreeViewColumn({
            title: _("Name"),
            expand: true
        });
        nameCol.pack_start(this.nameCell, true);
        nameCol.add_attribute(this.nameCell, "text", 1);
        this.treeview.append_column(nameCol);
        this.nameCell.connect("edited", Lang.bind(this, this._editName));
        
        // Command column.
        this.cmdCell = new Gtk.CellRendererText({ editable: true });
        let cmdCol = new Gtk.TreeViewColumn({
            title: _("Command"),
            expand: true
        });
        cmdCol.pack_start(this.cmdCell, true);
        cmdCol.add_attribute(this.cmdCell, "text", 2);
        this.treeview.append_column(cmdCol);
        this.cmdCell.connect("edited", Lang.bind(this, this._editCmd));
        
        let commandRow = this.content.addRow(commandsSection);
        commandRow.grid.row_spacing = 12;
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        commandRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        // Buttons
        let buttonBox = new Gtk.ButtonBox({
            halign: Gtk.Align.END,
            spacing: 12
        });
        commandRow.grid.attach(buttonBox, 0, 1, 1, 1);
        
        let removeButton = new Gtk.Button({ label: _("Remove") });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);
        
        let addButton = new Gtk.Button({ label: _("Add") });
        addButton.connect("clicked", Lang.bind(this, this._add, false));
        buttonBox.add(addButton);
        
        this._populate();
        
        this.content.show_all();
    },
    
    _add: function (button, row) {
        if (row === false) {
            row = ["{" + GLib.uuid_string_random() + "}", _("New command"), ""];
            this._settings.commands[row[0]] = { name: row[1], command: row[2]};
        }
        
        this.treeview.model.set(this.treeview.model.append(), [0, 1, 2], row);
    },
    
    _remove: function (button) {
        //
        let [has, model, iter] = this.treeview.get_selection().get_selected();
        
        if (has) {
            let uuid = this.treeview.model.get_value(iter, 0);
            delete this._settings.commands[uuid];
            this.treeview.model.remove(iter);
        }
    },
    
    _editName: function (renderer, path, new_text, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            this.treeview.model.set_value(iter, 1, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this._settings.commands[uuid].name = new_text;
        }
    },
    
    _editCmd: function (renderer, path, new_text, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            this.treeview.model.set_value(iter, 2, new_text);
            let uuid = this.treeview.model.get_value(iter, 0);
            this._settings.commands[uuid].command = new_text;
        }
    },
    
    _populate: function () {
        for (let uuid in this._settings.commands) {
            this._add(null, [
                uuid,
                this._settings.commands[uuid].name,
                this._settings.commands[uuid].command
            ]);
        }
    }
});


var SFTPPluginDialog = new Lang.Class({
    Name: "GSConnectSFTPPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        let generalSection = this.content.addSection(_("General"));
        
        let automountSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.automount
        });
        automountSwitch.connect("notify::active", (widget) => {
            this._settings.automount = automountSwitch.automount;
        });
        this.content.addItem(
            generalSection,
            _("Auto-mount"),
            _("Attempt to mount the device as soon as it connects"),
            automountSwitch
        );
        
        this.content.show_all();
    }
});


var SharePluginDialog = new Lang.Class({
    Name: "GSConnectSharePluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let fbutton = new Gtk.FileChooserButton({
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        fbutton.set_current_folder(this._settings.download_directory);
        fbutton.connect("current-folder-changed", (button) => {
            this._settings.download_directory = fbutton.get_current_folder();
        });
        this.content.addItem(
            receivingSection,
            _("Download location"),
            _("Choose a location to save received files"),
            fbutton
        );
        
        let subdirsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.download_subdirs
        });
        subdirsSwitch.connect("notify::active", (widget) => {
            this._settings.download_subdirs = subdirsSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Subdirectories"),
            _("Save files in device subdirectories"),
            subdirsSwitch
        );
        
        this.content.show_all();
    }
});


var TelephonyPluginDialog = new Lang.Class({
    Name: "GSConnectTelephonyPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        // Phone Calls
        let callsSection = this.content.addSection(_("Phone Calls"));
        
        let notifyMissedCallSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_missedCall
        });
        notifyMissedCallSwitch.connect("notify::active", (widget) => {
            this._settings.notify_missedCall = notifyMissedCallSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Missed call notification"),
            _("Show a notification for missed calls"),
            notifyMissedCallSwitch
        );
        
        let notifyRingingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_ringing
        });
        notifyRingingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_ringing = notifyRingingSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Ringing notification"),
            _("Show a notification when the phone is ringing"),
            notifyRingingSwitch
        );
        
        let notifyTalkingSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_talking
        });
        notifyTalkingSwitch.connect("notify::active", (widget) => {
            this._settings.notify_talking = notifyTalkingSwitch.active;
        });
        this.content.addItem(
            callsSection,
            _("Talking notification"),
            _("Show a notification when talking on the phone"),
            notifyTalkingSwitch
        );
        
        // SMS
        let smsSection = this.content.addSection(_("SMS"));
        
        let notifySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.notify_sms
        });
        notifySMSSwitch.connect("notify::active", (widget) => {
            this._settings.notify_sms = notifySMSSwitch.active;
        });
        this.content.addItem(
            smsSection,
            _("SMS notification"),
            _("Show a notification when an SMS is received"),
            notifySMSSwitch
        );
        
        let autoreplySMSSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this._settings.autoreply_sms
        });
        autoreplySMSSwitch.connect("notify::active", (widget) => {
            this._settings.autoreply_sms = autoreplySMSSwitch.active;
        });
        this.content.addItem(
            smsSection,
            _("Autoreply to SMS"),
            _("Open a new SMS window when an SMS is received"),
            autoreplySMSSwitch
        );
        
        this.content.show_all();
    }
});


var PluginMetadata = new Map([
    ["battery", {
        summary: _("Battery"),
        description: _("Monitor battery level and charging state")
    }],
    ["clipboard", {
        summary: _("Clipboard"),
        description: _("Sync the clipboard between devices")
    }],
    ["findmyphone", {
        summary: _("Find My Phone"),
        description: _("Locate device by ringing")
    }],
    ["mousepad", {
        summary: _("Remote Input"),
        description: _("Control the mouse and keyboard from your device")
    }],
    ["mpris", {
        summary: _("MPRIS"),
        description: _("Control music players from your device")
    }],
    ["notifications", {
        summary: _("Notifications"),
        description: _("Sync notifications with other devices"),
        settings: NotificationsPluginDialog
    }],
    ["ping", {
        summary: _("Ping"),
        description: _("Send and receive pings")
    }],
    ["runcommand", {
        summary: _("Run Commands"),
        description: _("Run local commands from remote devices"),
        settings: RunCommandPluginDialog
    }],
    ["sftp", {
        summary: _("SFTP"),
        description: _("Browse remote devices"),
        settings: SFTPPluginDialog
    }],
    ["share", {
        summary: _("Share"),
        description: _("Send and receive files and URLs"),
        settings: SharePluginDialog
    }],
    ["telephony", {
        summary: _("Telephony"),
        description: _("Send and receive SMS and be notified of phone calls"),
        settings: TelephonyPluginDialog
    }]
]);

