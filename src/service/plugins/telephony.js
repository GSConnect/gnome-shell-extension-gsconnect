"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

try {
    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    var GData = undefined;
    var Goa = undefined;
}

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const TelephonyWidget = imports.widgets.telephony;


var METADATA = {
    summary: _("Telephony"),
    description: _("Call notification and SMS messaging"),
    dbusInterface: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    schemaId: "org.gnome.shell.extensions.gsconnect.plugin.telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"]
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: track notifs: isCancel events, append new messages to unacknowledged?
 *       mute/unmute: pactl set-sink-mute @DEFAULT_SINK@ 1/0
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "telephony");
        
        this._cache = new ContactsCache();
        
        this._pausedPlayer = false;
    },
    
    _getIcon: function (packet) {
        let contact = this._cache.getContact(
            packet.body.phoneNumber,
            packet.body.contactName
        );
        
        if (contact.avatar) {
            let loader = new GdkPixbuf.PixbufLoader();
            loader.write(GLib.file_get_contents(contact.avatar)[1]);
            
            try {
                loader.close();
            } catch (e) {
                Common.debug("Warning: " + e.message);
            }
            
            return loader.get_pixbuf();
        } else if (packet.body.event === "missedCall") {
            return new Gio.ThemedIcon({ name: "call-missed-symbolic" });
        } else if (["ringing", "talking"].indexOf(packet.body.event) > -1) {
            return new Gio.ThemedIcon({ name: "call-start-symbolic" });
        } else if (packet.body.event === "sms") {
            return new Gio.ThemedIcon({ name: "sms-symbolic" });
        }
    },
    
    _handleMissedCall: function (sender, packet) {
        Common.debug("Telephony: handleMissedCall()");
        
        let notif = new Gio.Notification();
        // TRANSLATORS: Missed Call
        notif.set_title(_("Missed Call"));
        notif.set_body(
            // TRANSLATORS: eg. Missed call from John Smith on Google Pixel
            _("Missed call from %s on %s").format(sender, this.device.name)
        );
        notif.set_icon(this._getIcon(packet));
        notif.set_priority(Gio.NotificationPriority.NORMAL);
        
        notif.add_button(
            // TRANSLATORS: Reply to a missed call by SMS
            _("Message"),
            "app.replyMissedCall(('" +
            this._dbus.get_object_path() +
            "','" +
            escape(packet.body.phoneNumber) +
            "','" +
            escape(packet.body.contactName) +
            "','" +
            packet.body.phoneThumbnail +
            "'))"
        );
        
        // Tell the notification plugin to "silence" any duplicate
        if (this.device._plugins.has("notification")) {
            this.device._plugins.get("notification").silenceDuplicate(
                // TRANSLATORS: This is specifically for matching missed call notifications on Android.
                // You should translate this (or not) to match the string on your phone that in english looks like "Missed call: John Lennon"
                _("Missed call") + ": " + sender
            );
        }
        
        this.device.daemon.send_notification(
            _("Missed call") + ": " + sender,
            notif
        );
    },
    
    _handleRinging: function (sender, packet) {
        Common.debug("Telephony: _handleRinging()");
        
        let notif = new Gio.Notification();
        // TRANSLATORS: Incoming Call
        notif.set_title(_("Incoming Call"));
        notif.set_body(
            // TRANSLATORS: eg. Incoming call from John Smith on Google Pixel
            _("Incoming call from %s on %s").format(sender, this.device.name)
        );
        notif.set_icon(this._getIcon(packet));
        notif.set_priority(Gio.NotificationPriority.URGENT);
        
        notif.add_button(
            // TRANSLATORS: Silence an incoming call
            _("Mute"),
            "app.muteCall('" + this._dbus.get_object_path() + "')"
        );
        
        this.device.daemon.send_notification(
            this.device.id + ":" + packet.body.event + ":" + packet.body.phoneNumber,
            notif
        );
        
        if (this.settings.get_string("pause-music") === "ringing") {
            this._pauseMusic();
        }
    },
    
    _handleSms: function (sender, packet) {
        Common.debug("Telephony: _handleSMS()");
        
        // Check for an extant window
        let window = this._hasWindow(packet.body.phoneNumber);
        
        if (window) {
            window.receive(
                packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.messageBody,
                packet.body.phoneThumbnail
            );
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    sender + ": " + packet.body.messageBody
                );
            }
        }
        
        let notif = new Gio.Notification();
        notif.set_title(sender);
        notif.set_body(packet.body.messageBody);
        notif.set_icon(this._getIcon(packet));
        notif.set_priority(Gio.NotificationPriority.HIGH);
        
        notif.set_default_action(
            "app.replySms(('" +
            this._dbus.get_object_path() +
            "','" +
            escape(packet.body.phoneNumber) +
            "','" +
            escape(packet.body.contactName) +
            "','" +
            escape(packet.body.messageBody) +
            "','" +
            packet.body.phoneThumbnail +
            "'))"
        );
        
        // Tell the notification plugin to "silence" any duplicate
        if (this.device._plugins.has("notification")) {
            this.device._plugins.get("notification").silenceDuplicate(
                sender + ": " + packet.body.messageBody
            );
        }
        
        this.device.daemon.send_notification(packet.id.toString(), notif);
        
        if (window) {
            window._notifications.push(packet.id.toString());
        }
    },
    
    _handleTalking: function (sender, packet) {
        Common.debug("Telephony: _handleTalking()");
        
        let notif = new Gio.Notification();
        // TRANSLATORS: Talking on the phone
        notif.set_title(_("Call In Progress"));
        notif.set_body(
            // TRANSLATORS: eg. Call in progress with John Smith on Google Pixel
            _("Call in progress with %s on %s").format(sender, this.device.name)
        );
        notif.set_icon(this._getIcon(packet));
        notif.set_priority(Gio.NotificationPriority.NORMAL);
        
        this.device.daemon.send_notification(
            this.device.id + ":" + packet.body.event + ":" + packet.body.phoneNumber,
            notif
        );
        
        if (this.settings.get_string("pause-music") === "talking") {
            this._pauseMusic();
        }
    },
    
    _hasWindow: function (phoneNumber) {
        Common.debug("Telephony: _hasWindow(" + phoneNumber + ")");
        
        let incomingNumber = phoneNumber.replace(/\D/g, "");
        
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let window = false;
        
        // Look for an open window with this contact
        for (let index_ in windows) {
            for (let windowNumber of windows[index_].recipients) {
                if (incomingNumber === windowNumber) {
                    window = windows[index_];
                    break;
                }
            }
            
            if (window !== false) { break; }
        }
        
        return window;
    },
    
    _pauseMusic: function () {
        Common.debug("Telephony: _pauseMusic()");
        
        if (this.device._plugins.has("mpris")) {
            let plugin = this.device._plugins.get("mpris");
            
            for (let player of plugin._players.values()) {
                if (player.PlaybackStatus === "Playing" && player.CanPause) {
                    player.PauseSync();
                    
                    this._pausedPlayer = player;
                }
            }
        }
    },
    
    _unpauseMusic: function () {
        if (this._pausedPlayer) {
            this._pausedPlayer.PlaySync();
            this._pausedPlayer = false;
        }
    },
    
    handlePacket: function (packet) {
        Common.debug("Telephony: handlePacket()");
        
        // Ensure our signal emissions don't choke, but leave them falsey
        packet.body.contactName = packet.body.contactName || "";
        packet.body.phoneNumber = packet.body.phoneNumber || "";
        packet.body.phoneThumbnail = packet.body.phoneThumbnail || "";
        
        this._cache.parsePacket(packet);
        
        let sender;
                
        if (packet.body.contactName) {
            sender = packet.body.contactName;
        } else if (packet.body.phoneNumber) {
            sender = packet.body.phoneNumber;
        } else {
            sender = _("Unknown Number");
        }
        
        // Event handling
        // TODO: unpause for correct event (see what kdeconnect does)
        if (packet.body.isCancel) {
            this._unpauseMusic();
            this.device.daemon.withdraw_notification(
                this.device.id + ":" + packet.body.event + ":" + packet.body.phoneNumber
            );
        } else {
            if (packet.body.event === "sms") {
                this.emit(
                    "sms",
                    packet.body.phoneNumber,
                    packet.body.contactName,
                    packet.body.messageBody,
                    packet.body.phoneThumbnail
                );
                
                this._dbus.emit_signal("sms",
                    new GLib.Variant(
                        "(ssss)",
                        [packet.body.phoneNumber,
                        packet.body.contactName,
                        packet.body.messageBody,
                        packet.body.phoneThumbnail]
                    )
                );
            } else {
                this.emit(
                    packet.body.event,
                    packet.body.phoneNumber,
                    packet.body.contactName,
                    packet.body.phoneThumbnail
                );
                this._dbus.emit_signal(packet.body.event,
                    new GLib.Variant(
                        "(sss)",
                        [packet.body.phoneNumber,
                        packet.body.contactName,
                        packet.body.phoneThumbnail]
                    )
                );
            }
        
            if (packet.body.event === "missedCall") {
                this._handleMissedCall(sender, packet);
            } else if (packet.body.event === "ringing") {
                this._handleRinging(sender, packet);
            } else if (packet.body.event === "sms") {
                this._handleSms(sender, packet);
            } else if (packet.body.event === "talking") {
                this._handleTalking(sender, packet);
            }
        }
    },
    
    /**
     * Silence an incoming call
     */
    muteCall: function () {
        Common.debug("Telephony: muteCall()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.telephony.request",
            body: { action: "mute" }
        });
        this.device._channel.send(packet);
    },
    
    /**
     * Open and present a new SMS window
     */
    openSms: function () {
        Common.debug("Telephony: openSms()");
        
        let window = new TelephonyWidget.ConversationWindow(
            this.device.daemon,
            this.device
        );
        window.present();
    },
    
    /**
     * Either open a new SMS window for the caller or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} phoneThumbnail - The sender's avatar (pixmap bytearray)
     */
    replyMissedCall: function (phoneNumber, contactName, phoneThumbnail) {
        Common.debug("Telephony: replyMissedCall()");
        
        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);
        
        // Check for an extant window
        let window = this._hasWindow(phoneNumber);
        
        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(
                this.device.daemon,
                this.device
            );
            window.addRecipient(
                phoneNumber,
                contactName,
                phoneThumbnail
            );
            
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    _("Missed call") + ": " + contactName || phoneNumber
                );
            }
        }
        
        window.present();
    },
    
    /**
     * Either open a new SMS window for the sender or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     * @param {string} messageBody - The SMS message
     * @param {string} phoneThumbnail - The sender's avatar (pixmap bytearray)
     */
    replySms: function (phoneNumber, contactName, messageBody, phoneThumbnail) {
        Common.debug("Telephony: replySms()");
        
        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);
        messageBody = unescape(messageBody);
        
        // Check for an extant window
        let window = this._hasWindow(phoneNumber);
        
        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(
                this.device.daemon,
                this.device
            );
            
            window.receive(
                phoneNumber,
                contactName,
                messageBody,
                phoneThumbnail
            );
            
            window.urgency_hint = true;
            
            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                this.device._plugins.get("notification").closeDuplicate(
                    contactName || phoneNumber + ": " + messageBody
                );
            }
        }
        
        window.present();
    },
    
    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms: function (phoneNumber, messageBody) {
        Common.debug("Telephony: sendSms(" + phoneNumber + ", " + messageBody + ")");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });
        
        this.device._channel.send(packet);
    }
});


var ContactsCache = new Lang.Class({
    Name: "GSConnectContactsCache",
    Extends: GObject.Object,
    Properties: {
        "contacts": GObject.param_spec_variant(
            "contacts",
            "ContactsList", 
            "A list of cached contacts",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        ),
        "provider": GObject.ParamSpec.string(
            "provider",
            "ContactsProvider",
            "The provider for contacts",
            GObject.ParamFlags.READWRITE,
            "call-start-symbolic"
        )
    },
    
    _init: function () {
        this.parent();
        
        this.provider = "call-start-symbolic";
    
        this._dir =  Common.CACHE_PATH + "/contacts";
        this._file = Gio.File.new_for_path(this._dir + "/contacts.json");
        
        if (!GLib.file_test(this._dir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(this._dir, 493);
        }
        
        this.contacts = [];
        this.read();
        
        this._monitor = this._file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect("changed", (monitor, file, ofile, event) => {
            if (event === Gio.FileMonitorEvent.CHANGED) {
                this.notify("contacts");
                Common.debug("CONTACTS CACHE CHANGED"); // FIXME remove
            }
        });
        
        this.update();
    },
    
    getContact: function (number, name) {
        number = number.replace(/\D/g, "");
        
        for (let contact of this.contacts) {
            if (contact.number.replace(/\D/g, "") === number) {
                if (!name || ["", name].indexOf(contact.name) > -1) {
                    return contact;
                }
            }
        }
        
        return {};
    },
    
    // FIXME: check
    hasContact: function (number, name) {
        return (this.getContact() !== {});
    },
    
    setContact: function (newContact, write=true) {
        let number = newContact.number.replace(/\D/g, "");
        
        for (let contact of this.contacts) {
            if (contact.number.replace(/\D/g, "") === number) {
                if (["", newContact.name].indexOf(contact.name) > -1) {
                    Object.assign(contact, newContact);
                    if (write) { this.write(); }
                    return;
                }
            }
        }
        
        this.contacts.push(newContact);
        if (write) { this.write(); }
    },
    
    parsePacket: function (packet) {
        let contact = this.getContact(
            packet.body.phoneNumber,
            packet.body.contactName
        );
        
        contact.name = packet.body.contactName;
        contact.number = packet.body.phoneNumber;
        
        if (packet.body.phoneThumbnail && !contact.avatar) {
            Common.debug("Telephony: updating avatar for " + contact.name);
            
            let path = this._dir + "/" + GLib.uuid_string_random() + ".jpeg";
            GLib.file_set_contents(
                path,
                GLib.base64_decode(packet.body.phoneThumbnail)
            );
            contact.avatar = path;
        }
        
        this.setContact(contact);
    },
    
    read: function () {
        try {
            let contents = this._file.load_contents(null)[1];
            let contacts = JSON.parse(contents);
            this.contacts = contacts;
            this.notify("contacts");
        } catch (e) {
            Common.debug("Telephony: Error reading contacts cache: " + e);
        }
    },
    
    write: function () {
        try {
            this._file.replace_contents(
                JSON.stringify(this.contacts),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            Common.debug("Telephony: Error writing contacts cache: " + e);
        }
    },
    
    update: function () {
        let envp = GLib.get_environ();
        envp.push("FOLKS_BACKENDS_DISABLED=telepathy")
        
        let proc = GLib.spawn_async_with_pipes(
            null,                                       // working dir
            ["python3", getPath() + "/folks-cache.py"], // argv
            envp,                                       // envp
            GLib.SpawnFlags.SEARCH_PATH,                // enables PATH
            null                                        // child_setup (func)
        );
        
        this._check_folks(proc);
    },
    
    /** Check spawned folks.py for errors on stderr */
    _check_folks: function (proc) {
        let errstream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: proc[4] })
        });
        
        GLib.spawn_close_pid(proc[1]);
    
        errstream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [errline, length] = source.read_line_finish(res);
            
            if (errline === null) {
                this.provider = "avatar-default-symbolic";
                this.notify("provider");
            } else {
                Common.debug("Telephony: Error reading folks-cache.py: " + errline);
                
                try {
                    for (let account in this._getGoogleAccounts()) {
                        this._getGoogleContacts(account);
                        this.provider = "goa-account-google";
                        this.notify("provider");
                    }
                } catch (e) {
                    Common.debug("Telephony: Error reading Google Contacts: " + e);
                }
            }
        });
        
    },
    
    /** Get all google accounts in Goa */
    _getGoogleAccounts: function () {
        let goaClient = Goa.Client.new_sync(null);
        let goaAccounts = goaClient.get_accounts();
        
        for (let goaAccount in goaAccounts) {
            let acct = goaAccounts[goaAccount].get_account();
            
            if (acct.provider_type === "google") {
                yield new GData.ContactsService({
                    authorizer: new GData.GoaAuthorizer({
                        goa_object: goaClient.lookup_by_id(acct.id)
                    })
                })
            }
        }
    },
    
    /** Query google contacts via GData */
    _getGoogleContacts: function (account) {
        let query = new GData.ContactsQuery({ q: "" });
        let count = 0;
        
        while (true) {
            let feed = account.query_contacts(
                query, // query,
                null, // cancellable
                (contact) => {
                    for (let phoneNumber of contact.get_phone_numbers()) {
                        this.setContact({
                            name: contact.title,
                            number: phoneNumber.number,
                            type: phoneNumber.relation_type,
                            origin: "google"
                        }, false);
                    }
                }
            );
            
            count += feed.get_entries().length;
            query.start_index = count;
            
            if (count >= feed.total_results) { break; }
        }
        
        this.write();
    },
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectTelephonySettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (device, name, window) {
        this.parent(device, name, window);
        
        let mediaSection = this.content.addSection(
            null,
            null,
            { margin_bottom: 0, width_request: -1 }
        );
        
        let pauseMusicComboBox = new Gtk.ComboBoxText({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        pauseMusicComboBox.append("never", _("Never"));
        pauseMusicComboBox.append("ringing", _("Incoming Calls"));
        pauseMusicComboBox.append("talking", _("In Progress Calls"));
        this.settings.bind(
            "pause-music",
            pauseMusicComboBox,
            "active-id",
            Gio.SettingsBindFlags.DEFAULT
        );
        mediaSection.addSetting(_("Pause Music"), null, pauseMusicComboBox);
        
        if (this.device.plugins.indexOf("mpris") < 0) {
            pauseMusicComboBox.sensitive = false;
            pauseMusicComboBox.set_tooltip_markup(
                _("The <b>Media Player Control</b> plugin must be enabled")
            );
        }
        
        this.content.show_all();
    }
});

