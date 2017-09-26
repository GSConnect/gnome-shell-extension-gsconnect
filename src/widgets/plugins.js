"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext; // FIXME

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


/** A composite widget resembling A Gnome Control Center panel. */
var PluginPage = new Lang.Class({
    Name: "GSConnectPluginPage",
    Extends: Gtk.ScrolledWindow,
    
    _init: function () {
        this.parent({
            height_request: -1,
            valign: Gtk.Align.FILL,
            vexpand: true,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        
        this.box = new Gtk.Box({
            visible: true,
            can_focus: false,
            margin_left: 40,
            margin_right: 40,
            margin_top: 18,
            margin_bottom: 18,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18
        });
        this.add(this.box);
    },
    
    /**
     * Add and return a new section widget. If @title is given, a bold title
     * will be placed above the section.
     *
     * @param {String} title - Optional bold label placed above the section
     * @return {Gtk.Frame} section - The new Section object.
     */
    addSection: function (title) {
        if (title) {
            let label = new Gtk.Label({
                visible: true,
                can_focus: false,
                margin_start: 3,
                xalign: 0,
                use_markup: true,
                label: "<b>" + title + "</b>"
            });
            this.box.pack_start(label, false, true, 0);
        }
        
        let section = new Gtk.Frame({
            visible: true,
            can_focus: false,
            margin_bottom: 12,
            hexpand: true,
            label_xalign: 0,
            shadow_type: Gtk.ShadowType.IN
        });
        this.box.add(section);
        
        section.list = new Gtk.ListBox({
            visible: true,
            can_focus: false,
            hexpand: true,
            selection_mode: Gtk.SelectionMode.NONE,
            activate_on_single_click: false
        });
        section.add(section.list);
        
        return section;
    },
    
    /**
     * Add and return new row with a Gtk.Grid child
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addRow: function (section) {
        // Row
        let row = new Gtk.ListBoxRow({
            visible: true,
            can_focus: true,
            activatable: false,
            selectable: false
        });
        section.list.add(row);
        
        // Row Layout
        row.grid = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 16,
            row_spacing: 0,
            margin_left: 12,
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12
        });
        row.add(row.grid);
        
        return row;
    },
    
    /**
     * Add a new row to @section and return the row. @summary will be placed on
     * top of @description (dimmed) on the left, @widget to the right of them. 
     *
     * @param {Gtk.Frame} section - The section widget to attach to
     * @param {String} summary - A short summary for the item
     * @param {String} description - A short description for the item
     * @return {Gtk.ListBoxRow} row - The new row
     */
    addOption: function (section, summary, description, widget) {
        let row = this.addRow(section);
        
        // Setting Summary
        let summaryLabel = new Gtk.Label({
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true,
            label: summary
        });
        row.grid.attach(summaryLabel, 0, 0, 1, 1);
        
        // Setting Description
        if (description !== undefined) {
            let descriptionLabel = new Gtk.Label({
                visible: true,
                can_focus: false,
                xalign: 0,
                hexpand: true,
                label: description,
                wrap: true
            });
            descriptionLabel.get_style_context().add_class("dim-label");
            row.grid.attach(descriptionLabel, 0, 1, 1, 1);
        }
        
        let widgetHeight = (description !== null) ? 2 : 1;
        row.grid.attach(widget, 1, 0, 1, widgetHeight);
        
        return row;
    }
});


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
        
        this.pluginSwitch.active = this._page._config.plugins[this._name].enabled;
        
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
        this._settings = this._page._config.plugins[this._name].settings;
        
        this.content = new PluginPage();
        this.content.box.margin_left = 40;
        this.content.box.margin_right = 40;
        this.get_content_area().add(this.content);
    }
});


var BatteryPluginDialog = new Lang.Class({
    Name: "GSConnectBatteryPluginDialog",
    Extends: PluginDialog,
    
    _init: function (devicePage, pluginName, pluginInfo, win) {
        this.parent(devicePage, pluginName, pluginInfo, win);
        
        this.section = this.content.addSection(_("Receiving"));
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
        this.content.addOption(
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
        this.content.addOption(
            sendingSection,
            _("Send notifications"),
            _("Enable to send notifications to other devices"),
            sendSwitch
        );
        
        // Applications TreeView/Model
        let appRow = this.content.addRow(sendingSection);
        
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
        let buttonBox = new Gtk.ButtonBox();
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
            let pixbuf = theme.load_icon(
                this._settings.send.applications[name].iconName,
                0,
                0
            );
        
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
        let nameCol = new Gtk.TreeViewColumn({ expand: true, clickable: false });
        nameCol.pack_start(this.nameCell, true);
        nameCol.add_attribute(this.nameCell, "text", 1);
        this.treeview.append_column(nameCol);
        this.nameCell.connect("edited", Lang.bind(this, this._editName));
        
        // Command column.
        this.cmdCell = new Gtk.CellRendererText({ editable: true });
        let cmdCol = new Gtk.TreeViewColumn({ expand: true, clickable: false });
        cmdCol.pack_start(this.cmdCell, true);
        cmdCol.add_attribute(this.cmdCell, "text", 2);
        this.treeview.append_column(cmdCol);
        this.cmdCell.connect("edited", Lang.bind(this, this._editCmd));
        
        let commandRow = this.content.addRow(commandsSection);
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        commandRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        let buttonBox = new Gtk.ButtonBox();
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
        this.content.addOption(
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
        this.content.addOption(
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
        this.content.addOption(
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
        this.content.addOption(
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
        this.content.addOption(
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
        this.content.addOption(
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
        this.content.addOption(
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
        description: _("Monitor battery level and charging state"),
        settings: BatteryPluginDialog
    }],
    ["findmyphone", {
        summary: _("Find My Phone"),
        description: _("Locate device by ringing")
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

