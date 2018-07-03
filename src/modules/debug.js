'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const System = imports.system;


function getPID() {
    return Gio.DBus.session.call_sync(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        'GetConnectionUnixProcessID',
        new GLib.Variant('(s)', ['org.gnome.Shell.Extensions.GSConnect']),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    ).deep_unpack()[0];
}


var Window = GObject.registerClass({
    GTypeName: 'GSConnectDebugWindow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/debug.ui',
    Children: [
        'headerbar', 'stack', 'switcher',
        'packet-device', 'packet-direction', 'packet-type', 'packet-body', 'packet-button',
        'notification-device', 'notification-id', 'notification-time',
        'notification-appname', 'notification-title', 'notification-text',
        'notification-ticker', 'notification-requestreplyid', 'notification-isclearable',
        'telephony-device', 'telephony-event', 'telephony-name', 'telephony-number',
        'telephony-body', 'telephony-duplicate', 'telephony-iscancel', 'telephony-receive',
        'heap-path', 'heap-save'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init() {
        Gtk.Widget.set_connect_func.call(this, (builder, obj, signalName, handlerName, connectObj, flags) => {
            obj.connect(signalName, this[handlerName].bind(this));
        });

        super._init({
            application: Gio.Application.get_default(),
            default_width: 480,
            default_height: 320,
            visible: true
        });

        // Watch for device changes
        this._devicesChangedId = this.application.connect(
            'notify::devices',
            this._onDevicesChanged.bind(this)
        );
        this._onDevicesChanged(this.application);

        // Validate packet entry
        this.packet_body.buffer.connect(
            'changed',
            this._onPacketBodyChanged.bind(this)
        );

        // Bind notification id to tooltip
        this.notification_id.bind_property(
            'active-id',
            this.notification_id,
            'tooltip-text',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Set default heap path
        this.heap_path.set_current_folder(GLib.get_home_dir());

        // Make sure debug is enabled
        gsconnect.settings.set_boolean('debug', true);

        this.show_all();
    }

    _onDevicesChanged(application) {
        this.packet_device.remove_all();
        this.notification_device.remove_all();
        this.telephony_device.remove_all();

        for (let device of this.application._devices.values()) {
            this.packet_device.append(device.id, device.name);
            this.notification_device.append(device.id, device.name);
            this.telephony_device.append(device.id, device.name);
        }

        if (this.application.devices.length > 0) {
            this.packet_device.active = 0;
            this.notification_device.active = 0;
            this.telephony_device.active = 0;
        }
    }

    _onPacketDestinationChanged(combobox) {
        this.packet_type.remove_all();

        let device = this.application._devices.get(this.packet_device.active_id);

        if (device === undefined) {
            return;
        }

        if (this.packet_direction.active_id === 'incoming') {
            device.incomingCapabilities.map(c => this.packet_type.append(c, c));
        } else if (this.packet_direction.active_id === 'outgoing') {
            device.outgoingCapabilities.map(c => this.packet_type.append(c, c));
        }

        this.packet_type.active = 0;
    }

    _onPacketBodyChanged(buffer) {
        let style, button;

        if (buffer === this.packet_body.buffer) {
            button = this.packet_button;
            style = button.get_style_context();
        } else {
            button = this.receive_packet_button;
            style = button.get_style_context();
        }

        if (buffer.text.length < 1) {
            button.tooltip_text = null;
            style.remove_class('destructive-action');
        } else {
            try {
                JSON.parse(buffer.text);
                button.tooltip_text = null;
                style.remove_class('destructive-action');
            } catch (e) {
                button.tooltip_text = e.message;
                style.add_class('destructive-action');
            }
        }
    }

    _onPacketExecute(button) {
        try {
            let body = {};

            if (this.packet_body.buffer.text.length > 0) {
                body = JSON.parse(this.packet_body.buffer.text);
            }

            let device = this.application._devices.get(
                this.packet_device.active_id
            );

            if (this.packet_direction.active_id === 'outgoing') {
                device._onReceived(null, {
                    id: Date.now(),
                    type: this.packet_type.active_id,
                    body: body
                });
            } else if (this.packet_direction.active_id === 'incoming') {
                device.sendPacket({
                    id: 0,
                    type: this.packet_type.active_id,
                    body: body
                });
            }
        } catch (e) {
            logError(e);
        }
    }

    _onNotificationIdChanged(combobox) {
        if (this.notification_id.active_id === '0|com.google.android.apps.messaging|0|com.google.android.apps.messaging:sms:22|10109') {
            this.notification_appname.text = 'Messages';
            this.notification_title.text = 'Contact Name';
            this.notification_text.text = 'SMS Message Body';
        } else if (this.notification_id.active_id === '0|com.google.android.dialer|1|MissedCall_content://call_log/calls/163?allow_voicemails=true|10073') {
            this.notification_appname.text = 'Phone';
            this.notification_title.text = 'Missed call';
            this.notification_text.text = 'Contact Name';
        } else {
            this.notification_appname.text = '';
            this.notification_title.text = '';
            this.notification_text.text = '';
        }
    }

    _onNotificationTickerChanged(entry) {
        this.notification_ticker.text = [
            this.notification_title.text,
            this.notification_text.text
        ].join(': ');
    }

    _onNotificationReceive(button) {
        try {
            let device = this.application._devices.get(
                this.notification_device.active_id
            );

            device._onReceived(null, {
                id: Date.now(),
                type: 'kdeconnect.notification',
                body: {
                    id: this.notification_id.active_id,
                    time: this.notification_time.text,
                    appName: this.notification_appname.text,
                    title: this.notification_title.text,
                    text: this.notification_text.text,
                    ticker: this.notification_ticker.text,
                    requestReplyId: this.notification_requestreplyid.text,
                    isClearable: this.notification_isclearable.active
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    _onNotificationIsCancel(button) {
        try {
            let device = this.application._devices.get(
                this.notification_device.active_id
            );

            device._onReceived(null, {
                id: Date.now(),
                type: 'kdeconnect.notification',
                body: {
                    id: this.notification_id.active_id,
                    isCancel: true
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    _onTelephonyEventChanged(combobox) {
        this.telephony_duplicate.sensitive = ['missedCall', 'sms'].includes(combobox.active_id);
    }

    _onTelephonyReceive(button) {
        try {
            let device = this.application._devices.get(
                this.telephony_device.active_id
            );

            let nid, nappname, ntime, ntitle, ntext;

            if (this.telephony_duplicate.active_id !== 0) {
                if (this.telephony_event.active_id === 'missedCall') {
                    nid = '0|com.google.android.dialer|1|MissedCall_content://call_log/calls/163?allow_voicemails=true|10073';
                    nappname = 'Phone';
                    ntitle = 'Missed call';
                    ntext = (this.telephony_name.text) ? this.telephony_name.text : this.telephony_number.text;
                } else if (this.telephony_event.active_id === 'sms') {
                    nid = '0|com.google.android.apps.messaging|0|com.google.android.apps.messaging:sms:22|10109';
                    nappname = 'Messages';
                    ntitle = (this.telephony_name.text) ? this.telephony_name.text : this.telephony_number.text;
                    ntext = this.telephony_body.text;
                }

                ntime = `${Date.now() - 1000}`;
            }

            if (this.telephony_duplicate.active_id === 2) {
                device._onReceived(null, {
                    id: Date.now(),
                    type: 'kdeconnect.notification',
                    body: {
                        id: nid,
                        time: ntime,
                        appName: nappname,
                        title: ntitle,
                        text: ntext,
                        ticker: `${ntitle}: ${ntext}`,
                        requestReplyId: '00000000-0000-4000-0000-000000000000',
                        isClearable: true
                    }
                });
            }

            device._onReceived(null, {
                id: Date.now(),
                type: 'kdeconnect.telephony',
                body: {
                    event: this.telephony_event.active_id,
                    phoneNumber: this.telephony_number.text || undefined,
                    contactName: this.telephony_name.text || undefined,
                    messageBody: this.telephony_body.text || undefined
                }
            });

            if (this.telephony_duplicate.active_id === 1) {
                device._onReceived(null, {
                    id: Date.now(),
                    type: 'kdeconnect.notification',
                    body: {
                        id: nid,
                        time: ntime,
                        appName: nappname,
                        title: ntitle,
                        text: ntext,
                        ticker: `${ntitle}: ${ntext}`,
                        requestReplyId: '00000000-0000-4000-0000-000000000000',
                        isClearable: true
                    }
                });
            }
        } catch (e) {
            logError(e);
        }
    }

    _onTelephonyIsCancel(button) {
        try {
            let device = this.application._devices.get(
                this.telephony_device.active_id
            );

            device._onReceived(null, {
                id: Date.now(),
                type: 'kdeconnect.telephony',
                body: {
                    event: this.telephony_event.active_id,
                    phoneNumber: this.telephony_number.text,
                    contactName: this.telephony_name.text,
                    messageBody: this.telephony_body.text,
                    isCancel: true
                }
            });
        } catch (e) {
            logError(e);
        }
    }

    _onDestroy() {
        this.application.disconnect(this._devicesChangedId);
    }

    /**
     *
     */
    clearNotificationCache(device) {
        if (!device) {
            for (let device of this.application._devices.values()) {
                let notification = device._plugins.get('notification');

                if (notification) {
                    notification.clearCache();
                }
            }
        }
    }

    debugLog() {
        GLib.spawn_command_line_async(
            'gnome-terminal ' +
            //`--tab --title "GJS" --command "journalctl _PID=${getPID()} -f -o cat" ` +
            `--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ` +
            '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
        );
    }

    /**
     * System methods
     */
    breakpoint() {
        log(`Debug: System.breakpoint()`)
        System.breakpoint();
    }

    dumpHeap() {
        let path = GLib.build_filenamev([
            GLib.filename_from_uri(this.heap_path.get_uri())[0],
            'gsconnect.heap'
        ]);

        let i = 1;

        while (GLib.file_test(`${path}.${i}`, GLib.FileTest.EXISTS)) {
            i++;
        }

        path = `${path}.${i}`;

        log(`Debug: System.dumpHeap('${path}')`)
        System.dumpHeap(path);
    }

    gc() {
        log(`Debug: System.gc()`)
        System.gc();
    }
});

