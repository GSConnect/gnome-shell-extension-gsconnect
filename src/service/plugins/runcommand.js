'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Run Commands'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand',
    incomingCapabilities: ['kdeconnect.runcommand', 'kdeconnect.runcommand.request'],
    outgoingCapabilities: ['kdeconnect.runcommand', 'kdeconnect.runcommand.request'],
    actions: {
        commands: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request']
        },
        executeCommand: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request']
        }
    }
};


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommands
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/runcommand
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectRunCommandPlugin',
    Properties: {
        'remote-commands': GObject.param_spec_variant(
            'remote-commands',
            'Remote Command List',
            'A list of the device\'s remote commands',
            new GLib.VariantType('a{sv}'),
            null,
            GObject.ParamFlags.READABLE
        )
    }
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'runcommand');
        
        // Setup a launcher with env variables for commands
        let application = GLib.build_filenamev([
            gsconnect.extdatadir,
            'service',
            'daemon.js'
        ]);
        this._launcher = new Gio.SubprocessLauncher();
        this._launcher.setenv('GSCONNECT', application, false);
        this._launcher.setenv('GSCONNECT_DEVICE_ID', this.device.id, false);
        this._launcher.setenv('GSCONNECT_DEVICE_NAME', this.device.name, false);
        this._launcher.setenv('GSCONNECT_DEVICE_ICON', this.device.icon_name, false);
        this._launcher.setenv('GSCONNECT_DEVICE_DBUS', this.device.g_object_path, false);

        // Local Commands
        this._commandListChangedId = this.settings.connect(
            'changed::command-list',
            this.sendCommandList.bind(this)
        );

        // We cache remote commands so they can be used in the settings even
        // when the device is offline.
        this._remote_commands = {};
        this.cacheProperties(['_remote_commands']);
    }

    get remote_commands() {
        return this._remote_commands;
    }

    handlePacket(packet) {
        // A request...
        if (packet.type === 'kdeconnect.runcommand.request') {
            // ...for the local command list
            if (packet.body.hasOwnProperty('requestCommandList')) {
                this.sendCommandList();
            // ...to execute a command
            } else if (packet.body.hasOwnProperty('key')) {
                this._handleCommand(packet.body.key);
            }
        // A response to a request for the remote command list
        } else if (packet.type === 'kdeconnect.runcommand') {
            this._handleCommandList(packet.body.commandList);
        }
    }

    connected() {
        super.connected();

        // Disable the commands action until we know better
        this.sendCommandList();
        this.requestCommandList();

        this._handleCommandList(this.remote_commands);
    }

    cacheClear() {
        this._remote_commands = {};
        this.__cache_write();
        this.notify('remote-commands');
    }

    cacheLoaded() {
        if (this.device.connected) {
            this.connected();
        }
    }

    /**
     * Handle a request to execute the local command with the UUID @key
     * @param {String} key - The UUID of the local command
     */
    _handleCommand(key) {
        try {
            let commandList = this.settings.get_value('command-list').full_unpack();

            if (!commandList.hasOwnProperty(key)) {
                throw new Error(`Unknown command: ${key}`);
            }
            
            let proc = this._launcher.spawnv([
                '/bin/sh',
                '-c',
                commandList[key].command
            ]);
            proc.wait_check_async(null, this._commandExit);
        } catch (e) {
            logError(e, this.device.name);
        }
    }
    
    _commandExit(proc, res) {
        try {
            proc.wait_check_finish(res);
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Parse the response to a request for the remote command list. Remove the
     * command menu if there are no commands, otherwise amend the menu.
     */
    _handleCommandList(commandList) {
        this._remote_commands = commandList;
        this.notify('remote-commands');

        let commandEntries = Object.entries(this.remote_commands);

        // If there are no commands, hide the menu by disabling the action
        this.device.lookup_action('commands').enabled = (commandEntries.length > 0);

        // Commands Submenu
        let submenu = new Gio.Menu();

        for (let [uuid, info] of commandEntries) {
            let item = new Gio.MenuItem();
            item.set_label(info.name);
            item.set_icon(
                new Gio.ThemedIcon({name: 'application-x-executable-symbolic'})
            );
            item.set_detailed_action(`device.executeCommand::${uuid}`);
            submenu.append_item(item);
        }

        // Commands Item
        let item = new Gio.MenuItem();
        item.set_detailed_action('device.commands::menu');
        item.set_attribute_value(
            'hidden-when',
            new GLib.Variant('s', 'action-disabled')
        );
        item.set_icon(
            new Gio.ThemedIcon({name: 'system-run-symbolic'})
        );
        item.set_label(_('Commands'));
        item.set_submenu(submenu);

        // If the submenu item is already present it will be replaced
        let index = this.device.settings.get_strv('menu-actions').indexOf('commands');

        if (index > -1) {
            this.device.removeMenuAction('commands');
            this.device.addMenuItem(item, index);
        }
    }

    /**
     * Placeholder function for command action
     */
    commands() {}

    /**
     * Send a request to execute the remote command with the UUID @key
     * @param {String} key - The UUID of the remote command
     */
    executeCommand(key) {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {key: key}
        });
    }

    /**
     * Send a request for the remote command list
     */
    requestCommandList() {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {requestCommandList: true}
        });
    }

    /**
     * Send the local command list
     */
    sendCommandList() {
        let commands = this.settings.get_value('command-list').full_unpack();

        this.device.sendPacket({
            type: 'kdeconnect.runcommand',
            body: {commandList: commands}
        });
    }

    destroy() {
        if (this._commandListChangedId) {
            this.settings.disconnect(this._commandListChangedId);
        }

        super.destroy();
    }
});

