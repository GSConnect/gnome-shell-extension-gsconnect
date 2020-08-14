'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginBase = imports.service.plugin;


var Metadata = {
    label: _('Run Commands'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand',
    incomingCapabilities: [
        'kdeconnect.runcommand',
        'kdeconnect.runcommand.request',
    ],
    outgoingCapabilities: [
        'kdeconnect.runcommand',
        'kdeconnect.runcommand.request',
    ],
    actions: {
        commands: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request'],
        },
        executeCommand: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request'],
        },
    },
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
        ),
    },
}, class Plugin extends PluginBase.Plugin {

    _init(device) {
        super._init(device, 'runcommand');

        // Local Commands
        this._commandListChangedId = this.settings.connect(
            'changed::command-list',
            this._sendCommandList.bind(this)
        );

        // We cache remote commands so they can be used in the settings even
        // when the device is offline.
        this._remote_commands = {};
        this.cacheProperties(['_remote_commands']);
    }

    get remote_commands() {
        return this._remote_commands;
    }

    connected() {
        super.connected();

        this._sendCommandList();
        this._requestCommandList();
        this._handleCommandList(this.remote_commands);
    }

    clearCache() {
        this._remote_commands = {};
        this.notify('remote-commands');
    }

    cacheLoaded() {
        if (!this.device.connected)
            return;

        this._sendCommandList();
        this._requestCommandList();
        this._handleCommandList(this.remote_commands);
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.runcommand':
                this._handleCommandList(packet.body.commandList);
                break;

            case 'kdeconnect.runcommand.request':
                if (packet.body.hasOwnProperty('key'))
                    this._handleCommand(packet.body.key);

                else if (packet.body.hasOwnProperty('requestCommandList'))
                    this._sendCommandList();

                break;
        }
    }

    /**
     * Handle a request to execute the local command with the UUID @key
     *
     * @param {string} key - The UUID of the local command
     */
    _handleCommand(key) {
        try {
            let commands = this.settings.get_value('command-list');
            let commandList = commands.recursiveUnpack();

            if (!commandList.hasOwnProperty(key)) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.PERMISSION_DENIED,
                    message: `Unknown command: ${key}`,
                });
            }

            this.device.launchProcess([
                '/bin/sh',
                '-c',
                commandList[key].command,
            ]);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /**
     * Parse the response to a request for the remote command list. Remove the
     * command menu if there are no commands, otherwise amend the menu.
     *
     * @param {Object[]} commandList - A list of remote commands
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
        item.set_icon(new Gio.ThemedIcon({name: 'system-run-symbolic'}));
        item.set_label(_('Commands'));
        item.set_submenu(submenu);

        // If the submenu item is already present it will be replaced
        let menuActions = this.device.settings.get_strv('menu-actions');
        let index = menuActions.indexOf('commands');

        if (index > -1) {
            this.device.removeMenuAction('commands');
            this.device.addMenuItem(item, index);
        }
    }

    /**
     * Send a request for the remote command list
     */
    _requestCommandList() {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {requestCommandList: true},
        });
    }

    /**
     * Send the local command list
     */
    _sendCommandList() {
        let commands = this.settings.get_value('command-list').recursiveUnpack();

        this.device.sendPacket({
            type: 'kdeconnect.runcommand',
            body: {commandList: commands},
        });
    }

    /**
     * Placeholder function for command action
     */
    commands() {}

    /**
     * Send a request to execute the remote command with the UUID @key
     *
     * @param {string} key - The UUID of the remote command
     */
    executeCommand(key) {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {key: key},
        });
    }

    destroy() {
        this.settings.disconnect(this._commandListChangedId);

        super.destroy();
    }
});

