"use strict";

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const KeybindingsWidget = Me.imports.widgets.keybindings;
const PluginsWidget = Me.imports.widgets.plugins;
const Client = Me.imports.client;
const Common = Me.imports.common;
const PreferencesWidget = Me.imports.widgets.preferences;
const DeviceWidget = Me.imports.widgets.device;


/** A GtkStack subclass with a pre-attached GtkStackSwitcher */
var PrefsWidget = new Lang.Class({
    Name: "PrefsWidget",
    Extends: PreferencesWidget.Stack,
    
    _init: function () {
        this.parent();
        
        // Watch for Service Provider
        this.manager = new Client.DeviceManager();
        
        this._build();
        
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            Client.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );
    },
    
    // The DBus interface has appeared
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        Common.debug("extension.SystemIndicator._serviceAppeared()");
        
        if (!this.manager) {
            this.manager = new Client.DeviceManager();
        }
        
        for (let dbusPath of this.manager.devices.keys()) {
            this.devicesStack.addDevice(this.manager, dbusPath);
        }
        
        // Watch for new and removed devices
        this.manager.connect(
            "device::added",
            Lang.bind(this.devicesStack, this.devicesStack.addDevice)
        );
        
        this.manager.connect(
            "device::removed",
            Lang.bind(this.devicesStack, this.devicesStack.removeDevice)
        );
        
        this.manager.bind_property(
            "name",
            this.nameEntry,
            "placeholder_text",
            GObject.BindingFlags.DEFAULT
        );
    },
    
    // The DBus interface has vanished
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        Common.debug("extension.SystemIndicator._serviceVanished()");
        
        if (this.manager) {
            this.manager.destroy();
            this.manager = false;
        }
        
        if (!Settings.get_boolean("debug")) {
            this.manager = new Client.DeviceManager();
        }
    },
    
    _build: function () {
        // General Page
        let generalPage = this.addPage("general", _("General"));
        
        // Appearance
        let appearanceSection = generalPage.addSection(_("Appearance"));
        generalPage.addSetting(appearanceSection, "show-indicators");
        generalPage.addSetting(appearanceSection, "show-offline");
        generalPage.addSetting(appearanceSection, "show-unpaired");
        
        // Files
        let filesSection = generalPage.addSection(_("Files"));
        generalPage.addSetting(filesSection, "nautilus-integration");
        
        // Keyboard Shortcuts
        let keySection = generalPage.addSection(_("Keyboard Shortcuts"));
        let keyRow = generalPage.addRow(keySection);
        let keyView = new KeybindingsWidget.TreeView();
        keyView.addAccel("menu", _("Open Extension Menu"), 0, 0);
        keyView.addAccel("discover", _("Discover Devices"), 0, 0);
        keyView.addAccel("settings", _("Open Extension Settings"), 0, 0);
        keyView.setAccels(
            JSON.parse(
                Common.Settings.get_string("extension-keybindings")
            )
        );
        keyView.setCallback((profile) => {
            Common.Settings.set_string(
                "extension-keybindings",
                JSON.stringify(profile)
            );
        });
        keyRow.grid.attach(keyView, 0, 0, 1, 1);
        
        // Devices Page
        this.devicesStack = new DeviceWidget.Stack();
        let devicesPage = this.add_titled(this.devicesStack, "devices", _("Devices"));
        
        // Service Page
        let servicePage = this.addPage("service", _("Service"));
        let serviceSection = servicePage.addSection(_("Service"));
        
        this.nameEntry = new Gtk.Entry({
            placeholder_text: this.manager.name,
            valign: Gtk.Align.CENTER
        });
        this.nameEntry.connect("activate", (entry) => {
            this.manager.name = entry.text
            entry.text = "";
            this.get_toplevel().set_focus(null);
        });
        this.nameEntry.connect("changed", (entry) => {
            if (entry.text.length) {
                entry.secondary_icon_name = "edit-undo-symbolic";
            } else {
                entry.text = "";
                entry.secondary_icon_name = "";
                this.get_toplevel().set_focus(null);
            }
        });
        this.nameEntry.connect("icon-release", (entry) => {
            entry.text = "";
            entry.secondary_icon_name = "";
            this.get_toplevel().set_focus(null);
        });
        
        servicePage.addItem(
            serviceSection,
            _("Public Name"),
            _("The name broadcast to other devices"),
            this.nameEntry
        );
        
        servicePage.addSetting(serviceSection, "persistent-discovery");
        
        // About/Advanced
        let advancedPage = this.addPage("advanced", _("Advanced"));
        let develSection = advancedPage.addSection(_("Development"));
        advancedPage.addSetting(develSection, "debug");
    }
});


function init() {
    Common.initConfiguration();
    Common.initTranslations();
}

// Extension Preferences
function buildPrefsWidget() {
    let prefsWidget = new PrefsWidget();
    
    // HeaderBar
    Mainloop.timeout_add(0, () => {
        let headerBar = prefsWidget.get_toplevel().get_titlebar();
        headerBar.custom_title = prefsWidget.switcher;
        return false;
    });
    
    prefsWidget.show_all();
    return prefsWidget;
}

