// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import system from 'system';

import Config from '../config.js';
import {Panel} from './device.js';
import {Service} from '../utils/remote.js';


/*
 * Header for support logs
 */
const LOG_HEADER = new GLib.Bytes(`
GSConnect: ${Config.PACKAGE_VERSION} (${Config.IS_USER ? 'user' : 'system'})
GJS:       ${system.version}
Session:   ${GLib.getenv('XDG_SESSION_TYPE')}
OS:        ${GLib.get_os_info('PRETTY_NAME')}
--------------------------------------------------------------------------------
`);


/**
 * Generate a support log.
 *
 * @param {string} time - Start time as a string (24-hour notation)
 */
async function generateSupportLog(time) {
    try {
        const [file, stream] = Gio.File.new_tmp('gsconnect.XXXXXX');
        const logFile = stream.get_output_stream();

        await new Promise((resolve, reject) => {
            logFile.write_bytes_async(LOG_HEADER, 0, null, (file, res) => {
                try {
                    resolve(file.write_bytes_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        // FIXME: BSD???
        const proc = new Gio.Subprocess({
            flags: (Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE),
            argv: ['journalctl', '--no-host', '--since', time],
        });
        proc.init(null);

        logFile.splice_async(
            proc.get_stdout_pipe(),
            Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, res) => {
                try {
                    source.splice_finish(res);
                } catch (e) {
                    logError(e);
                }
            }
        );

        await new Promise((resolve, reject) => {
            proc.wait_check_async(null, (proc, res) => {
                try {
                    resolve(proc.wait_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        const uri = file.get_uri();
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    } catch (e) {
        logError(e);
    }
}


/**
 * "Connect to..." Dialog
 */
const ConnectDialog = GObject.registerClass({
    GTypeName: 'GSConnectConnectDialog',
}, class ConnectDialog extends Adw.Dialog {

    _init(params = {}) {
        super._init({
            title: _('Connect to…'),
            content_width: 380,
            ...params,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        toolbar.add_top_bar(header);

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this._connectButton = new Gtk.Button({label: _('Connect'), sensitive: false});
        this._connectButton.add_css_class('suggested-action');
        this._connectButton.connect('clicked', this._onConnect.bind(this));
        header.pack_end(this._connectButton);

        const group = new Adw.PreferencesGroup({
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12,
        });
        toolbar.set_content(group);

        this._lanIp = new Adw.EntryRow({
            title: _('IP Address'),
            input_purpose: Gtk.InputPurpose.FREE_FORM,
        });
        this._lanIp.connect('changed', () => {
            this._connectButton.sensitive = !!this._lanIp.text.trim();
        });
        this._lanIp.connect('entry-activated', this._onConnect.bind(this));
        group.add(this._lanIp);

        this._lanPort = new Adw.SpinRow({
            title: _('Port'),
            adjustment: new Gtk.Adjustment({
                lower: 1716,
                upper: 1764,
                step_increment: 1,
                page_increment: 10,
                value: 1716,
            }),
        });
        group.add(this._lanPort);

        this.set_child(toolbar);
        this.set_focus(this._lanIp);
    }

    _onConnect() {
        const host = this._lanIp.text.trim();

        if (!host)
            return;

        try {
            const port = this._lanPort.value;
            const address = GLib.Variant.new_string(`lan://${host}:${port}`);

            Gio.Application.get_default().activate_action('connect', address);
        } catch (e) {
            logError(e);
        }

        this.close();
    }
});


export const Window = GObject.registerClass({
    GTypeName: 'GSConnectPreferencesWindow',
    Properties: {
        'display-mode': GObject.ParamSpec.string(
            'display-mode',
            'Display Mode',
            'Display devices in either the Panel or User Menu',
            GObject.ParamFlags.READWRITE,
            null
        ),
    },
}, class PreferencesWindow extends Adw.ApplicationWindow {

    _init(params = {}) {
        super._init({
            default_width: 640,
            default_height: 550,
            icon_name: 'org.gnome.Shell.Extensions.GSConnect-symbolic',
            ...params,
        });

        // Service Settings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                true
            ),
        });

        // Device pages, keyed by device id
        this._panels = new Map();
        this._deviceRows = new Map();

        // Collapses the sidebar of device pages on narrow windows
        this._narrow = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 600sp'),
        });
        this.add_breakpoint(this._narrow);

        this._buildLayout();

        // Service Proxy
        this.service = new Service();

        this._deviceAddedId = this.service.connect(
            'device-added',
            this._onDeviceAdded.bind(this)
        );

        this._deviceRemovedId = this.service.connect(
            'device-removed',
            this._onDeviceRemoved.bind(this)
        );

        this._serviceChangedId = this.service.connect(
            'notify::active',
            this._onServiceChanged.bind(this)
        );

        // Service Name
        this.settings.bind('name', this._windowTitle, 'title', Gio.SettingsBindFlags.GET);
        this._nameRow.text = this.settings.get_string('name');

        // Discoverable Banner
        this.settings.bind(
            'discoverable',
            this._bannerDiscoverable,
            'revealed',
            Gio.SettingsBindFlags.INVERT_BOOLEAN | Gio.SettingsBindFlags.GET
        );
        this.add_action(this.settings.create_action('discoverable'));

        // OpenSSL-missing banner
        this.settings.bind(
            'missing-openssl',
            this._bannerOpenssl,
            'revealed',
            Gio.SettingsBindFlags.GET
        );

        // Setting: Keep Alive When Locked
        this.settings.bind(
            'keep-alive-when-locked',
            this._keepAliveRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Application Menu
        this._initMenu();

        // Broadcast automatically every 5 seconds if there are no devices yet
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            this._refresh.bind(this)
        );

        // Restore window size/maximized/position
        this._restoreGeometry();

        // Prime the service
        this._initService();
    }

    get display_mode() {
        if (this.settings.get_boolean('show-indicators'))
            return 'panel';

        return 'user-menu';
    }

    set display_mode(mode) {
        this.settings.set_boolean('show-indicators', (mode === 'panel'));
    }

    vfunc_close_request() {
        if (this.service) {
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);
            this.service.disconnect(this._serviceChangedId);
            this.service.destroy();
            this.service = null;
        }

        this._saveGeometry();

        if (this._refreshSource) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = 0;
        }

        for (const panel of this._panels.values())
            panel.dispose();

        this._panels.clear();

        return super.vfunc_close_request();
    }

    /*
     * Layout
     */
    _buildLayout() {
        this._nav = new Adw.NavigationView();
        this.set_content(this._nav);

        const toolbar = new Adw.ToolbarView();
        const rootPage = new Adw.NavigationPage({
            title: 'GSConnect',
            tag: 'service',
            child: toolbar,
        });
        this._nav.add(rootPage);

        // HeaderBar
        const header = new Adw.HeaderBar();
        this._windowTitle = new Adw.WindowTitle({title: 'GSConnect', subtitle: ''});
        header.title_widget = this._windowTitle;

        this._refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Refresh'),
            action_name: 'app.refresh',
        });
        this._refreshButton.update_property([Gtk.AccessibleProperty.LABEL], [_('Refresh')]);
        header.pack_start(this._refreshButton);

        this._serviceMenu = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            primary: true,
            tooltip_text: _('Service Menu'),
        });
        header.pack_end(this._serviceMenu);
        toolbar.add_top_bar(header);

        // Banners
        this._bannerDiscoverable = new Adw.Banner({
            title: _('Discovery Disabled: This device is invisible to unpaired devices'),
            button_label: _('Enable'),
            action_name: 'win.discoverable',
        });
        toolbar.add_top_bar(this._bannerDiscoverable);

        this._bannerOpenssl = new Adw.Banner({
            title: _('OpenSSL not found: the <tt>openssl</tt> command-line tool does not appear to be installed. Use your distro\'s package manager to install it. For more information, visit <a href="https://github.com/gsconnect/gnome-shell-extension-gsconnect/wiki/Error#openssl-not-found">the GSConnect wiki</a>.'),
            button_label: _('Retry'),
            use_markup: true,
        });
        this._bannerOpenssl.connect('button-clicked', this._onRetryOpenssl.bind(this));
        toolbar.add_top_bar(this._bannerOpenssl);

        // Content
        const page = new Adw.PreferencesPage();
        toolbar.set_content(page);

        // This device
        const thisDevice = new Adw.PreferencesGroup();
        page.add(thisDevice);

        this._nameRow = new Adw.EntryRow({
            title: _('Device Name'),
            show_apply_button: true,
            input_purpose: Gtk.InputPurpose.NAME,
        });
        this._nameRow.connect('apply', this._onSetServiceName.bind(this));
        thisDevice.add(this._nameRow);

        // Devices
        this._deviceGroup = new Adw.PreferencesGroup({title: _('Devices')});
        page.add(this._deviceGroup);

        this._spinner = new Gtk.Spinner();
        this._deviceGroup.header_suffix = this._spinner;

        this._deviceList = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        this._deviceList.add_css_class('boxed-list');
        this._deviceList.connect('row-activated', this._onDeviceSelected.bind(this));

        this._placeholder = new Gtk.Label({
            label: _('Searching for devices…'),
            margin_top: 18,
            margin_bottom: 18,
        });
        this._placeholder.add_css_class('dim-label');
        this._deviceList.set_placeholder(this._placeholder);
        this._deviceGroup.add(this._deviceList);

        // Extension Settings
        const extension = new Adw.PreferencesGroup({title: _('Extension Settings')});
        page.add(extension);

        this._keepAliveRow = new Adw.SwitchRow({
            title: _('GSConnect remains active when GNOME Shell is locked'),
        });
        extension.add(this._keepAliveRow);

        // Browser Add-Ons
        const browsers = new Adw.PreferencesGroup({title: _('Browser Add-Ons')});
        page.add(browsers);
        browsers.add(this._createLinkRow(
            'Firefox',
            '',
            'https://addons.mozilla.org/firefox/addon/gsconnect/'
        ));
        browsers.add(this._createLinkRow(
            'Chrome',
            '',
            'https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec'
        ));

        // KDE Connect
        const kdeconnect = new Adw.PreferencesGroup({title: 'KDE Connect'});
        page.add(kdeconnect);
        kdeconnect.add(this._createLinkRow(
            'Play Store',
            'Android',
            'https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp'
        ));
        kdeconnect.add(this._createLinkRow(
            'F-Droid',
            'Android',
            'https://f-droid.org/packages/org.kde.kdeconnect_tp/'
        ));
        kdeconnect.add(this._createLinkRow(
            'OpenRepos',
            'Sailfish OS',
            'https://openrepos.net/content/r1tschy/sailfish-connect'
        ));
        kdeconnect.add(this._createLinkRow(
            'App Store',
            'iOS',
            'https://apps.apple.com/us/app/kde-connect/id1580245991'
        ));
    }

    _createLinkRow(title, subtitle, uri) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
            activatable: true,
            tooltip_text: uri,
        });
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
        });

        return row;
    }

    async _initService() {
        try {
            this._refreshButton.grab_focus();

            this._onServiceChanged(this.service, null);
            await this.service.reload();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _initMenu() {
        const menu = new Gio.Menu();

        const connect = new Gio.Menu();
        // TRANSLATORS: Open a dialog to connect to an IP or Bluez device
        connect.append(_('Add device by IP…'), 'win.connect');
        menu.append_section(null, connect);

        const mode = new Gio.Menu();
        // TRANSLATORS: Show device indicators in the top bar
        mode.append_item(Gio.MenuItem.new(_('Panel'), 'win.display-mode::panel'));
        // TRANSLATORS: Show devices in the user menu like Bluetooth
        mode.append_item(Gio.MenuItem.new(_('User Menu'), 'win.display-mode::user-menu'));
        menu.append_section(_('Display Mode'), mode);

        const misc = new Gio.Menu();
        // TRANSLATORS: Generate a support log
        misc.append(_('Generate Support Log'), 'win.support-log');
        misc.append(_('Help'), 'win.help');
        misc.append(_('About GSConnect'), 'win.about');
        menu.append_section(null, misc);

        this._serviceMenu.menu_model = menu;

        // Panel/User Menu mode
        const displayMode = new Gio.PropertyAction({
            name: 'display-mode',
            property_name: 'display-mode',
            object: this,
        });
        this.add_action(displayMode);

        // About Dialog
        const aboutDialog = new Gio.SimpleAction({name: 'about'});
        aboutDialog.connect('activate', this._aboutDialog.bind(this));
        this.add_action(aboutDialog);

        // "Connect to..." Dialog
        const connectDialog = new Gio.SimpleAction({name: 'connect'});
        connectDialog.connect('activate', this._connectDialog.bind(this));
        this.add_action(connectDialog);

        // "Generate Support Log" GAction
        const generateSupportLog = new Gio.SimpleAction({name: 'support-log'});
        generateSupportLog.connect('activate', this._generateSupportLog.bind(this));
        this.add_action(generateSupportLog);

        // "Help" GAction
        const help = new Gio.SimpleAction({name: 'help'});
        help.connect('activate', this._help);
        this.add_action(help);
    }

    _refresh() {
        if (!this.service)
            return GLib.SOURCE_REMOVE;

        const missing_openssl = this.settings.get_boolean('missing-openssl');
        const no_devices = this.service.active && this._deviceRows.size < 1;
        if (missing_openssl || no_devices) {
            this._spinner.spinning = true;
            this.service.activate_action('refresh', null);
        } else {
            this._spinner.spinning = false;
        }

        return GLib.SOURCE_CONTINUE;
    }

    /*
     * Window State
     */
    _restoreGeometry() {
        this._windowState = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.WindowState',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/preferences/',
        });

        // Size
        const [width, height] = this._windowState.get_value('window-size').deepUnpack();

        if (width && height)
            this.set_default_size(width, height);

        // Maximized State
        if (this._windowState.get_boolean('window-maximized'))
            this.maximize();
    }

    _saveGeometry() {
        // Maximized State
        const maximized = this.maximized;
        this._windowState.set_boolean('window-maximized', maximized);

        // Leave the size at the value before maximizing
        if (maximized || this.fullscreened)
            return;

        // Size
        const size = [this.get_width(), this.get_height()];
        this._windowState.set_value('window-size', new GLib.Variant('(ii)', size));
    }

    /**
     * About Dialog
     */
    _aboutDialog() {
        const dialog = new Adw.AboutDialog({
            application_name: 'GSConnect',
            application_icon: 'org.gnome.Shell.Extensions.GSConnect',
            developers: [
                'Andy Holmes <andrew.g.r.holmes@gmail.com>',
                'Bertrand Lacoste <getzze@gmail.com>',
                'Frank Dana <ferdnyc@gmail.com>',
            ],
            comments: _('A complete KDE Connect implementation for GNOME'),
            // TRANSLATORS: eg. 'Translator Name <your.email@domain.com>'
            translator_credits: _('translator-credits'),
            version: Config.PACKAGE_VERSION.toString(),
            website: Config.PACKAGE_URL,
            issue_url: Config.PACKAGE_BUGREPORT,
            license_type: Gtk.License.GPL_2_0,
        });

        dialog.present(this);
    }

    /**
     * Connect to..." Dialog
     */
    _connectDialog() {
        new ConnectDialog().present(this);
    }

    /*
     * "Generate Support Log" GAction
     */
    _generateSupportLog() {
        const dialog = new Adw.AlertDialog({
            heading: _('Generate Support Log'),
            body: _('Debug messages are being logged. Take any steps necessary to reproduce a problem then review the log.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('review', _('Review Log'));
        dialog.set_response_appearance('review', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('review');
        dialog.set_close_response('cancel');

        // Enable debug logging and mark the current time
        this.settings.set_boolean('debug', true);
        const now = GLib.DateTime.new_now_local().format('%R');

        dialog.connect('response', (dialog, response) => {
            // Disable debug logging
            this.settings.set_boolean('debug', false);

            // Only generate a log if instructed
            if (response === 'review')
                generateSupportLog(now);
        });

        dialog.present(this);
    }

    _validateName(name) {
        // None of the forbidden characters and at least one non-whitespace
        if (name.trim() && /^[^"',;:.!?()[\]<>]{1,32}$/.test(name))
            return true;

        const dialog = new Adw.AlertDialog({
            heading: _('Invalid Device Name'),
            // TRANSLATOR: %s is a list of forbidden characters
            body: _('Device name must not contain any of %s ' +
                    'and have a length of 1-32 characters')
                .format('<b><tt>^"\',;:.!?()[]&lt;&gt;</tt></b>'),
            body_use_markup: true,
        });
        dialog.add_response('ok', _('_OK'));
        dialog.present(this);

        return false;
    }

    /*
     * "Help" GAction
     */
    _help(action, parameter) {
        const uri = `${Config.PACKAGE_URL}/wiki/Help`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    /*
     * Service Callbacks
     */
    _onSetServiceName() {
        if (this._validateName(this._nameRow.text))
            this.settings.set_string('name', this._nameRow.text);
        else
            this._nameRow.text = this.settings.get_string('name');
    }

    _onRetryOpenssl() {
        this.settings.set_boolean('enabled', false);
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, 2, () => {
            this.settings.set_boolean('enabled', true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /*
     * Device List
     */
    _onDeviceChanged(row, device) {
        if (!device.paired)
            row.subtitle = _('Unpaired');
        else if (!device.connected)
            row.subtitle = _('Disconnected');
        else
            row.subtitle = _('Connected');
    }

    _createDeviceRow(device) {
        const row = new Adw.ActionRow({
            activatable: true,
        });
        row.set_name(device.id);

        row.add_prefix(new Gtk.Image({
            gicon: new Gio.ThemedIcon({name: device.icon_name}),
        }));
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));

        // Keep name up to date
        device.bind_property(
            'name',
            row,
            'title',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Keep status up to date
        row._connectedId = device.connect('notify::connected', () => this._onDeviceChanged(row, device));
        row._pairedId = device.connect('notify::paired', () => this._onDeviceChanged(row, device));
        this._onDeviceChanged(row, device);

        return row;
    }

    _onDeviceAdded(service, device) {
        try {
            if (this._panels.has(device.id))
                return;

            // Add the device preferences
            const prefs = new Panel(device);
            this._narrow.add_setter(prefs.split_view, 'collapsed', true);
            this._panels.set(device.id, prefs);

            // Add a row to the device list
            const row = this._createDeviceRow(device);
            this._deviceRows.set(device.id, row);
            this._deviceList.append(row);
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceRemoved(service, device) {
        try {
            const prefs = this._panels.get(device.id);

            if (prefs === undefined)
                return;

            if (this._nav.visible_page === prefs)
                this._nav.pop();

            const row = this._deviceRows.get(device.id);
            device.disconnect(row._connectedId);
            device.disconnect(row._pairedId);
            this._deviceList.remove(row);
            this._deviceRows.delete(device.id);

            this._panels.delete(device.id);
            prefs.dispose();
        } catch (e) {
            logError(e);
        }
    }

    _onDeviceSelected(box, row) {
        try {
            const prefs = this._panels.get(row.get_name());

            if (prefs)
                this._nav.push(prefs);
        } catch (e) {
            logError(e);
        }
    }

    _onServiceChanged(service, pspec) {
        if (this.service.active)
            this._placeholder.label = _('Searching for devices…');
        else
            this._placeholder.label = _('Waiting for service…');
    }
});
