"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

try {
    imports.gi.versions.GData = "0.0";
    imports.gi.versions.Goa = "1.0";

    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    var GData = undefined;
    var Goa = undefined;
}

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;
const Sound = imports.sound;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const TelephonyWidget = imports.widgets.telephony;


var METADATA = {
    summary: _("Telephony"),
    description: _("Call notification and SMS messaging"),
    uuid: "org.gnome.Shell.Extensions.GSConnect.Plugin.Telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"]
};


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces,
 * allowing passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
let _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
let _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
let _lenientDigits = "[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+";
let _lenientNumber = _lenientDigits + "(?:" + _telParam + ")*";

var _smsRegex = new RegExp(
    "^" +
    "sms:" +                                // scheme
    "(?:[/]{2,3})?" +                       // Gio.File returns ":///"
    "(" +                                   // one or more...
        _lenientNumber +                    // phone numbers
        "(?:," + _lenientNumber + ")*" +    // separated by commas
    ")" +
    "(?:\\?(" +                             // followed by optional...
        _smsParam +                         // parameters...
        "(?:&" + _smsParam + ")*" +         // separated by "&" (unescaped)
    "))?" +
    "$", "g");                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    "^" +
    "(" + _lenientDigits + ")" +            // phone number digits
    "((?:" + _telParam + ")*)" +            // followed by optional parameters
    "$", "g");


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 *
 * TODO: track notifs: isCancel events, append new messages to unacknowledged?
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST,
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

        if (Sound._mixerControl) {
            this._mixer = new Sound.Mixer();
        }

        this._prevVolume = 0;
        this._prevMute = false;
        this._prevMicrophone = false;
        this._pausedPlayer = false;
    },

    _getPixbuf: function (path) {
        let loader = new GdkPixbuf.PixbufLoader();
        loader.write(GLib.file_get_contents(path)[1]);

        try {
            loader.close();
        } catch (e) {
            debug("Warning: " + e.message);
        }

        return loader.get_pixbuf();
    },

    _getIcon: function (packet) {
        let contact = this._cache.getContact(
            packet.body.phoneNumber,
            packet.body.contactName
        );

        if (contact.avatar) {
            return this._getPixbuf(contact.avatar);
        } else if (packet.body.event === "missedCall") {
            return new Gio.ThemedIcon({ name: "call-missed-symbolic" });
        } else if (["ringing", "talking"].indexOf(packet.body.event) > -1) {
            return new Gio.ThemedIcon({ name: "call-start-symbolic" });
        } else if (packet.body.event === "sms") {
            return new Gio.ThemedIcon({ name: "sms-symbolic" });
        }
    },

    _handleMissedCall: function (sender, packet) {
        debug("Telephony: handleMissedCall()");

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
            "'))"
        );

        // Tell the notification plugin to "silence" any duplicate
        let plugin = this.device._plugins.get("notification");
        if (plugin) {
            // TRANSLATORS: This is specifically for matching missed call notifications on Android.
            // You should translate this (or not) to match the string on your phone that in english looks like "Missed call: John Lennon"
            plugin.silenceDuplicate(_("Missed call") + ": " + sender);
        }

        this.device.send_notification(
            packet.body.event + "|" + _("Missed call") + ": " + sender,
            notif);
    },

    _handleRinging: function (sender, packet) {
        debug("Telephony: _handleRinging()");

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

        this.device.send_notification(
            packet.body.event + "|" + sender,
            notif
        );

        this._adjustVolume(this.settings.get_string("ringing-volume"));
        this._pauseMedia(this.settings.get_boolean("ringing-pause"));
    },

    _handleSms: function (sender, packet) {
        debug("Telephony: _handleSMS()");

        let plugin = this.device._plugins.get("notification");

        // Check for an extant window
        let window = this._hasWindow(packet.body.phoneNumber);

        if (window) {
            window.receive(
                packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.messageBody
            );
            window.urgency_hint = true;
            window._notifications.push(packet.id.toString());

            // Tell the notification plugin to mark any duplicate read
            if (plugin) {
                plugin.closeDuplicate(sender + ": " + packet.body.messageBody);
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
            "'))"
        );

        // Tell the notification plugin to "silence" any duplicate
        if (plugin) {
            plugin.silenceDuplicate(sender + ": " + packet.body.messageBody);
        }

        this.device.send_notification(
            packet.body.event + "|"  + sender + ": " + packet.body.messageBody,
            notif
        );
    },

    _handleTalking: function (sender, packet) {
        debug("Telephony: _handleTalking()");

        this.device.withdraw_notification("ringing|" + sender);

        let notif = new Gio.Notification();
        // TRANSLATORS: Talking on the phone
        notif.set_title(_("Call In Progress"));
        notif.set_body(
            // TRANSLATORS: eg. Call in progress with John Smith on Google Pixel
            _("Call in progress with %s on %s").format(sender, this.device.name)
        );
        notif.set_icon(this._getIcon(packet));
        notif.set_priority(Gio.NotificationPriority.NORMAL);

        this.device.send_notification(
            packet.body.event + "|" + sender,
            notif
        );

        this._adjustVolume(this.settings.get_string("talking-volume"));
        this._muteMicrophone(this.settings.get_boolean("talking-microphone"));
        this._pauseMedia(this.settings.get_boolean("talking-pause"));
    },

    /**
     * Check if there's an open conversation for a number(s)
     *
     * @param {string|array} phoneNumber - A string phone number or array of
     */
    _hasWindow: function (number) {
        debug("Telephony: _hasWindow(" + number + ")");

        if (number instanceof Array) {
            number = number.map(num => num.replace(/\D/g, "")).sort();
        } else {
            number = number.replace(/\D/g, "");
        }

        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let window = false;

        // Look for an open window with this contact
        for (let index_ in windows) {
            let win = windows[index_];

            if (win.deviceId !== this.device.id || !win.numbers.length) {
                continue;
            }

            if (number instanceof Array) {
                if (JSON.stringify(win.numbers) === JSON.stringify(number)) {
                    window = win;
                    break;
                }
            } else {
                for (let winNumber of win.numbers) {
                    if (number === winNumber) {
                        window = win;
                        break;
                    }
                }
            }

            if (window !== false) { break; }
        }

        return window;
    },

    _adjustVolume: function (action) {
        debug("Telephony: _adjustVolume()");

        if (!this._mixer) { return; }

        if (action === "lower" && !this._prevVolume) {
            if (this._mixer.output.volume > 0.15) {
                this._prevVolume = Number(this._mixer.output.volume);
                this._mixer.output.lower(0.15);
            }
        } else if (action === "mute" && !this._mixer.output.muted) {
            this._mixer.output.muted = true;
            this._prevMute = true;
        }
    },

    _restoreVolume: function () {
        debug("Telephony: _restoreVolume()");

        if (this._prevMute) {
            this._mixer.output.muted = false;
            this._prevMute = false;
        }

        if (this._prevVolume > 0) {
            this._mixer.output.raise(this._prevVolume);
            this._prevVolume = 0;
        }
    },

    _muteMicrophone: function (mute) {
        debug("Telephony: _muteMicrophone()");

        if (!this._mixer) { return; }

        if (mute && !this._mixer.input.muted) {
            this._mixer.input.muted = true;
            this._prevMicrophone = true;
        }
    },

    _unmuteMicrophone: function () {
        debug("Telephony: _unmuteMicrophone()");

        if (this._prevMicrophone) {
            this._mixer.input.muted = false;
            this._prevMicrophone = false;
        }
    },

    _pauseMedia: function (pause) {
        debug("Telephony: _pauseMedia()");

        if (pause && this.device._plugins.has("mpris")) {
            let plugin = this.device._plugins.get("mpris");

            for (let player of plugin._players.values()) {
                if (player.PlaybackStatus === "Playing" && player.CanPause) {
                    player.PauseSync();
                    this._pausedPlayer = player;
                }
            }
        }
    },

    _resumeMedia: function () {
        debug("Telephony: _resumeMedia()");

        if (this._pausedPlayer) {
            this._pausedPlayer.PlaySync();
            this._pausedPlayer = false;
        }
    },

    handlePacket: function (packet) {
        debug("Telephony: handlePacket()");

        // Ensure our signal emissions don't choke, but leave them falsey
        packet.body.contactName = packet.body.contactName || "";
        packet.body.phoneNumber = packet.body.phoneNumber || "";
        packet.body.phoneThumbnail = packet.body.phoneThumbnail || "";

        let contact = this._cache.parsePacket(packet);

        let sender;

        if (packet.body.contactName) {
            sender = packet.body.contactName;
        } else if (packet.body.phoneNumber) {
            sender = packet.body.phoneNumber;
        } else {
            sender = _("Unknown Number");
        }

        // Event handling
        if (packet.body.isCancel) {
            this._resumeMedia();
            this._unmuteMicrophone();
            this._restoreVolume();
            this.device.withdraw_notification(packet.body.event + "|" + sender);
        } else {
            if (packet.body.event === "sms") {
                this.emit(
                    "sms",
                    contact.number,
                    contact.name,
                    packet.body.messageBody,
                    contact.avatar || ""
                );

                this._dbus.emit_signal("sms",
                    new GLib.Variant(
                        "(ssss)",
                        [contact.number,
                        contact.name,
                        packet.body.messageBody,
                        contact.avatar || ""]
                    )
                );
            } else {
                this.emit(
                    packet.body.event,
                    contact.number,
                    contact.name,
                    contact.avatar || ""
                );
                this._dbus.emit_signal(packet.body.event,
                    new GLib.Variant(
                        "(sss)",
                        [contact.number,
                        contact.name,
                        contact.avatar || ""]
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
        debug("Telephony: muteCall()");

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
        debug("Telephony: openSms()");

        let window = new TelephonyWidget.ConversationWindow(this.device);
        window.present();
    },

    openUri: function (uri) {
        if (!uri instanceof SmsURI) {
            try {
                uri = new SmsURI(uri);
            } catch (e) {
                debug("Error parsing sms URI: " + e.message);
                return;
            }
        }

        // Check for an extant window
        let window = this._hasWindow(uri.recipients);

        // None found; open one and add the contact(s)
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(this.device);

            for (let recipient of uri.recipients) {
                window.addRecipient({
                    number: recipient,
                    name: ""
                });
            }
            window.urgency_hint = true;
        }

        // Set the outgoing message if the uri has a body variable
        if (uri.body) {
            window.setEntry(uri.body);
        }

        window.present();
    },

    /**
     * Either open a new SMS window for the caller or reuse an existing one
     *
     * @param {string} phoneNumber - The sender's phone number
     * @param {string} contactName - The sender's name
     */
    replyMissedCall: function (phoneNumber, contactName) {
        debug("Telephony: replyMissedCall()");

        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);

        // Check for an extant window
        let window = this._hasWindow(phoneNumber);

        // None found; open one, add the contact, log the message, mark it read
        if (!window) {
            window = new TelephonyWidget.ConversationWindow(this.device);
            window.addRecipient({
                number: phoneNumber,
                name: contactName
            });
            window.urgency_hint = true;

            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                let sender = contactName || phoneNumber;
                this.device._plugins.get("notification").closeDuplicate(
                    _("Missed call") + ": " + sender
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
     */
    replySms: function (phoneNumber, contactName, messageBody) {
        debug("Telephony: replySms()");

        phoneNumber = unescape(phoneNumber);
        contactName = unescape(contactName);
        messageBody = unescape(messageBody);

        // Check for an extant window
        let window = this._hasWindow(phoneNumber);

        // None found
        if (!window) {
            // Open a new window
            window = new TelephonyWidget.ConversationWindow(this.device);

            // Log the message
            window.receive(phoneNumber, contactName, messageBody);
            window.urgency_hint = true;

            // Tell the notification plugin to mark any duplicate read
            if (this.device._plugins.has("notification")) {
                let sender = contactName || phoneNumber;
                this.device._plugins.get("notification").closeDuplicate(
                    sender + ": " + messageBody
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
        debug("Telephony: sendSms(" + phoneNumber + ", " + messageBody + ")");

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
    },

    /**
     * Share a link by SMS message
     *
     * @param {string} url - The link to be shared
     */
    shareUri: function (url) {
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let hasConversations = false;

        for (let index_ in windows) {
            let window = windows[index_];

            if (window.deviceId === this.device.id && window.numbers.length) {
                hasConversations = true;
                break;
            }
        }

        let window;

        if (hasConversations) {
            window = new TelephonyWidget.ShareWindow(this.device, url);
        } else {
            window = new TelephonyWidget.ConversationWindow(this.device);
            window.setEntry(url);
        }

        window.present();
    }
});


/**
 * A simple queriable contact cache, using a JSON file to store cache between
 * instances. File are in $HOME/.cache/gsconnnect/contacts for now.
 *
 * See also: https://phabricator.kde.org/T4678
 */
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

        this._dir =  ext.cachedir + "/contacts";
        this._file = Gio.File.new_for_path(this._dir + "/contacts.json");
        GLib.mkdir_with_parents(this._dir, 448);

        this.contacts = [];
        this.read();

        this._monitor = this._file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect("changed", (monitor, file, ofile, event) => {
            if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                this.read();
            }
        });

        this.update();
    },

    /**
     * Return a contact object if @number (and @name if given) is matched
     *
     * @param {string} number - A phone number to be matched by digits only
     * @param {string} [name] - A contact name to be matched exactly (optional)
     * @return {object} - A populated contact object or {}
     */
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

    /**
     * Add or update a contact (update if @number and @name is matched)
     *
     * @param {object} newContact - A contact object with at least a number
     * @param {boolean} [write] - Write the cache to disk, if true
     */
    setContact: function (newContact, write=true) {
        let number = newContact.number.replace(/\D/g, "");

        for (let contact of this.contacts) {
            if (contact.number.replace(/\D/g, "") === number) {
                if (["", newContact.name].indexOf(contact.name) > -1) {
                    Object.assign(contact, newContact);
                    if (write) { this.write(); }
                    return contact;
                }
            }
        }

        this.contacts.push(newContact);
        if (write) { this.write(); }
        return newContact;
    },

    /**
     * Search the cache for contact name or number matching @query. If a number
     * or name with one phone number matching @query is found return a contact
     * object. If no match or a contact with more than one number is found
     * return false.
     *
     * @param {string} query - A contact name or phone number to search for
     * @return {object|false} = A contact object or false.
     */
    searchContact: function (query) {
        let matches = [];
        let strippedNumber = query.replace(/\D/g, "");

        for (let contact of this.contacts) {
            if (contact.number.replace(/\D/g, "") === strippedNumber) {
                matches.push(contact);
            } else if (contact.name === query) {
                matches.push(contact);
            }
        }

        // Only return if there's a single match
        return (matches.length === 1) ? matches[0] : false;
    },

    /**
     * Parse an telephony event packet and return a contact object, updating
     * the cache if appropriate.
     *
     * @param {object} packet - A telephony event packet
     * @return {object} - A contact object
     */
    parsePacket: function (packet) {
        let contact = this.getContact(
            packet.body.phoneNumber,
            packet.body.contactName
        );

        contact.name = contact.name || packet.body.contactName;
        contact.number = contact.number || packet.body.phoneNumber;
        contact.type = contact.type || "cell";
        contact.origin = contact.origin || "kdeconnect";

        if (packet.body.phoneThumbnail && !contact.avatar) {
            debug("Telephony: updating avatar for " + contact.name);

            let path = this._dir + "/" + GLib.uuid_string_random() + ".jpeg";
            GLib.file_set_contents(
                path,
                GLib.base64_decode(packet.body.phoneThumbnail)
            );
            contact.avatar = path;
        }

        return this.setContact(contact);
    },

    read: function () {
        try {
            let contents = this._file.load_contents(null)[1];
            this.contacts = JSON.parse(contents);
            this.notify("contacts");
        } catch (e) {
            debug("Telephony: Error reading contacts cache: " + e);
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
            debug("Telephony: Error writing contacts cache: " + e);
        }
    },

    update: function () {
        try {
            let envp = GLib.get_environ();
            envp.push("FOLKS_BACKENDS_DISABLED=telepathy")

            let proc = GLib.spawn_async_with_pipes(
                null,
                ["python3", ext.datadir + "/folks-cache.py"],
                envp,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            this._check_folks(proc);
        } catch (e) {
            debug("Telephony: Error reading folks-cache.py: " + e.message);

            this._cacheGoogleContacts();
        }
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
                debug("Telephony: Error reading folks-cache.py: " + errline);

                this._cacheGoogleContacts();
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
                            type: phoneNumber.relation_type || "unknown",
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

    _cacheGoogleContacts: function () {
        try {
            for (let account in this._getGoogleAccounts()) {
                this._getGoogleContacts(account);
                this.provider = "goa-account-google";
                this.notify("provider");
            }
        } catch (e) {
            debug("Telephony: Error reading Google Contacts: " + e);
        }
    }
});


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var SmsURI = new Lang.Class({
    Name: "GSConnectSmsURI",

    _init: function (uri) {
        debug("SmsURI: _init(" + uri + ")");

        let full, recipients, query;

        try {
            _smsRegex.lastIndex = 0;
            [full, recipients, query] = _smsRegex.exec(uri);
        } catch (e) {
            throw URIError("malformed sms URI");
        }

        this.recipients = recipients.split(",").map((recipient) => {
            _numberRegex.lastIndex = 0;
            let [full, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(";")) {
                    let [key, value] = param.split("=");

                    // add phone-context to beginning of
                    if (key === "phone-context" && value.startsWith("+")) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split("&")) {
                let [key, value] = field.split("=");

                if (key === "body") {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    },

    toString: function () {
        let uri = "sms:" + this.recipients.join(",");

        return (this.body) ? uri + "?body=" + escape(this.body) : uri;
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectTelephonySettingsDialog",
    Extends: PluginsBase.SettingsDialog,

    _init: function (device, name, window) {
        this.parent(device, name, window);

        let ringingSection = this.content.addSection(
            _("Incoming Calls"),
            null,
            { width_request: -1 }
        );

        let ringingVolume = new Gtk.ComboBoxText({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        ringingVolume.append("nothing", _("Nothing"));
        ringingVolume.append("lower", _("Lower"));
        ringingVolume.append("mute", _("Mute"));
        this.settings.bind(
            "ringing-volume",
            ringingVolume,
            "active-id",
            Gio.SettingsBindFlags.DEFAULT
        );
        ringingSection.addSetting(_("System Volume"), null, ringingVolume);
        let ringingMedia = ringingSection.addGSetting(this.settings, "ringing-pause");

        let talkingSection = this.content.addSection(
            _("In Progress Calls"),
            null,
            { margin_bottom: 0, width_request: -1 }
        );

        let talkingVolume = new Gtk.ComboBoxText({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        talkingVolume.append("nothing", _("Nothing"));
        talkingVolume.append("lower", _("Lower"));
        talkingVolume.append("mute", _("Mute"));
        this.settings.bind(
            "talking-volume",
            talkingVolume,
            "active-id",
            Gio.SettingsBindFlags.DEFAULT
        );
        talkingSection.addSetting(_("System Volume"), null, talkingVolume);

        let talkingMicrophone = talkingSection.addGSetting(this.settings, "talking-microphone");
        let talkingMedia = talkingSection.addGSetting(this.settings, "talking-pause");

        //
        if (this.device.plugins.indexOf("mpris") < 0) {
            ringingMedia.sensitive = false;
            ringingMedia.set_tooltip_markup(
                _("The <b>Media Player Control</b> plugin must be enabled")
            );

            talkingMedia.sensitive = false;
            talkingMedia.set_tooltip_markup(
                _("The <b>Media Player Control</b> plugin must be enabled")
            );
        }

        //
        if (!Sound._mixerControl) {
            ringingVolume.sensitive = false;
            ringingVolume.set_tooltip_markup(_("Gvc not available"));

            talkingVolume.sensitive = false;
            talkingVolume.set_tooltip_markup(_("Gvc not available"));

            talkingMicrophone.sensitive = false;
            talkingMicrophone.set_tooltip_markup(_("Gvc not available"));
        }

        this.content.show_all();
    }
});

