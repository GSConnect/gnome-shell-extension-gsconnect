'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const PluginsBase = imports.service.plugins.base;


var Metadata = {
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand',
    incomingCapabilities: ['kdeconnect.runcommand', 'kdeconnect.runcommand.request'],
    outgoingCapabilities: ['kdeconnect.runcommand', 'kdeconnect.runcommand.request'],
    actions: {
        executeCommand: {
            summary: _('Run Command'),
            description: _('Execute a command on the device'),
            signature: 's',
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request'],
            allow: 2
        }
    },
    events: {}
};


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommands
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/runcommand
 *
 * {
 *      'id':0,
 *      'type': 'kdeconnect.runcommand',
 *      'body': {
 *          'commandList': {
 *              '98482d76-8409-4ea3-9263-d812f000a19a': {
 *                  'name': 'Kodi',
 *                  'command': '/home/andrew/scripts/kodi'
 *              }
 *          }
 *      }
 * }
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectRunCommandPlugin',
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'runcommand');

        // Local Commands
        this.settings.connect(
            'changed::command-list',
            this._sendCommandList.bind(this)
        );
        this._sendCommandList();

        // Remote Commands
        this.requestCommandList();
    }

    handlePacket(packet) {
        debug(packet);

        // A request for command list or execution
        if (packet.type === 'kdeconnect.runcommand.request') {
            if (packet.body.requestCommandList) {
                this._sendCommandList();
            } else if (packet.body.key) {
                this._handleCommand(packet.body.key);
            }
        // An answer to a request for the remote command list
        } else if (packet.type === 'kdeconnect.runcommand') {
            this._handleCommandList(packet.body.commandList);
        }
    }

    /**
     * Send the local command list
     */
    _sendCommandList() {
        let commands = gsconnect.full_unpack(
            this.settings.get_value('command-list')
        );

        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.runcommand',
            body: { commandList: commands }
        });
    }

    /**
     * Handle a request to execute the local command with the UUID @key
     * @param {String} key - The UUID of the local command
     */
    _handleCommand(key) {
        let commandList = gsconnect.full_unpack(
            this.settings.get_value('command-list')
        );

        if (commandList.hasOwnProperty(key)) {
            GLib.spawn_async(
                null,
                ['/bin/sh', '-c', commandList[key].command],
                null,
                GLib.SpawnFlags.DEFAULT,
                null
            );
        } else {
            logError(new Error(`Unknown command ${key}`));
        }
    }

    /**
     * Send a request for the remote command list
     */
    requestCommandList() {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.runcommand.request',
            body: { requestCommandList: true }
        });
    }

    /**
     * Parse the response to a request for the remote command list. Remove the
     * command menu if there are no commands, otherwise amend the menu.
     */
    _handleCommandList(commandList) {
        let commandEntries = Object.entries(commandList);

        // Remove the menu if there are no commands
        if (commandEntries.length < 1) {
            this.device.menu.remove_named(_('Commands'));
            return;
        }

        // Commands Submenu
        let commandSubmenu = new Gio.Menu();

        for (let [uuid, info] of commandEntries) {
            let item = new Gio.MenuItem();
            item.set_label(info.name);
            item.set_icon(
                new Gio.ThemedIcon({ names: [
                    info.name.toLowerCase(),
                    'application-x-executable-symbolic'
                    ]
                })
            );
            item.set_detailed_action(`device.executeCommand::${uuid}`);
            commandSubmenu.append_item(item);
        }

        // Commands Item
        let commandItem = new Gio.MenuItem();
        commandItem.set_icon(
            new Gio.ThemedIcon({ name: 'system-run-symbolic' })
        );
        commandItem.set_label(_('Commands'));
        commandItem.set_submenu(commandSubmenu);

        // If the Commands item is already present it will be replaced,
        // otherwise it will be appended to the end of the menu.
        this.device.menu.replace_named(_('Commands'), commandItem);
    }

    /**
     * Send a request to execute the remote command with the UUID @key
     * @param {String} key - The UUID of the remote command
     */
    executeCommand(key) {
        this.device.sendPacket({
            id: 0,
            type: 'kdeconnect.runcommand.request',
            body: { key: key }
        });
    }

    destroy() {
        this.device.menu.remove_named(_('Commands'));

        PluginsBase.Plugin.prototype.destroy.call(this);
    }
});

