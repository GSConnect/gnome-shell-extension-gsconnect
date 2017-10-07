"use strict";

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

imports.searchPath.push(getPath());

const Client = imports.client;
const Common = imports.common;
const DeviceWidget = imports.widgets.device;
const KeybindingsWidget = imports.widgets.keybindings;
const PreferencesWidget = imports.widgets.preferences;


/** A GtkStack subclass with a pre-attached GtkStackSwitcher */
var PrefsWidget = new Lang.Class({
    Name: "PrefsWidget",
    Extends: PreferencesWidget.Stack,
    
    _init: function () {
        this.parent();
        
        // Watch for Service Provider
        this.daemon = new Client.Daemon();
        
        this._build();
        
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            Client.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );
    },
    
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        Common.debug("PrefsWidget._serviceAppeared()");
        
        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }
        
        if (this.daemon.version < Common.Me.metadata['version']) {
            this.daemon.quit();
        }
        
        for (let dbusPath of this.daemon.devices.keys()) {
            this.devicesStack.addDevice(this.daemon, dbusPath);
        }
        
        // Watch for new and removed devices
        this.daemon.connect(
            "device::added",
            Lang.bind(this.devicesStack, this.devicesStack.addDevice)
        );
        
        this.daemon.connect(
            "device::removed",
            Lang.bind(this.devicesStack, this.devicesStack.removeDevice)
        );
    },
    
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        Common.debug("PrefsWidget._serviceVanished()");
        
        if (this.daemon) {
            this.daemon.destroy();
            this.daemon = false;
        }
        
        if (!Common.Settings.get_boolean("debug")) {
            this.daemon = new Client.Daemon();
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
        keyView.addAccel("menu", _("Open Menu"), 0, 0);
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
        let devicesPage = this.add_titled(
            this.devicesStack,
            "devices", 
            _("Devices")
        );
        
        // Service Page
        let servicePage = this.addPage("service", _("Service"));
        let serviceSection = servicePage.addSection(_("Service"));
        servicePage.addSetting(serviceSection, "public-name");
        
        let restartButton = new Gtk.Button({
            label: _("Restart"),
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        restartButton.connect("clicked", Common.stopService);
        servicePage.addItem(
            serviceSection,
            _("Restart Service"),
            _("Stop the service and let the extension restart it"),
            restartButton
        );
        
        // About/Advanced
        let advancedPage = this.addPage("advanced", _("Advanced"));
        let develSection = advancedPage.addSection(_("Development"));
        advancedPage.addSetting(develSection, "debug");
    }
});


function init() {
    Common.debug("initializing extension preferences");
    
    Common.initConfiguration();
}

// Extension Preferences
function buildPrefsWidget() {
    Common.debug("Prefs: buildPrefsWidget()");
    
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

