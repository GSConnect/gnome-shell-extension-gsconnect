'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


const SESSION_TIMEOUT = 15;


const RemoteSession = GObject.registerClass({
    GTypeName: 'GSConnectRemoteSession',
    Implements: [Gio.DBusInterface],
    Signals: {
        'closed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class RemoteSession extends Gio.DBusProxy {

    _init(objectPath) {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.gnome.Mutter.RemoteDesktop',
            g_object_path: objectPath,
            g_interface_name: 'org.gnome.Mutter.RemoteDesktop.Session',
            g_flags: Gio.DBusProxyFlags.NONE,
        });

        this._started = false;
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        if (signal_name === 'Closed')
            this.emit('closed');
    }

    _call(name, parameters = null) {
        if (!this._started)
            return;

        this.call(name, parameters, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    get session_id() {
        try {
            return this.get_cached_property('SessionId').unpack();
        } catch (e) {
            return null;
        }
    }

    async start() {
        try {
            if (this._started)
                return;

            // Initialize the proxy
            await new Promise((resolve, reject) => {
                this.init_async(
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (proxy, res) => {
                        try {
                            proxy.init_finish(res);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Start the session
            await new Promise((resolve, reject) => {
                this.call(
                    'Start',
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, res) => {
                        try {
                            resolve(proxy.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            this._started = true;
        } catch (e) {
            this.destroy();

            Gio.DBusError.strip_remote_error(e);
            throw e;
        }
    }

    stop() {
        if (this._started) {
            this._started = false;
            this.call('Stop', null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    _translateButton(button) {
        switch (button) {
            case Gdk.BUTTON_PRIMARY:
                return 0x110;

            case Gdk.BUTTON_MIDDLE:
                return 0x112;

            case Gdk.BUTTON_SECONDARY:
                return 0x111;

            case 4:
                return 0; // FIXME

            case 5:
                return 0x10F; // up
        }
    }

    movePointer(dx, dy) {
        this._call(
            'NotifyPointerMotionRelative',
            GLib.Variant.new('(dd)', [dx, dy])
        );
    }

    pressPointer(button) {
        button = this._translateButton(button);

        this._call(
            'NotifyPointerButton',
            GLib.Variant.new('(ib)', [button, true])
        );
    }

    releasePointer(button) {
        button = this._translateButton(button);

        this._call(
            'NotifyPointerButton',
            GLib.Variant.new('(ib)', [button, false])
        );
    }

    clickPointer(button) {
        button = this._translateButton(button);

        this._call(
            'NotifyPointerButton',
            GLib.Variant.new('(ib)', [button, true])
        );

        this._call(
            'NotifyPointerButton',
            GLib.Variant.new('(ib)', [button, false])
        );
    }

    doubleclickPointer(button) {
        this.clickPointer(button);
        this.clickPointer(button);
    }

    scrollPointer(dx, dy) {
        // NOTE: NotifyPointerAxis only seems to work on Wayland, but maybe
        //       NotifyPointerAxisDiscrete is the better choice anyways
        if (HAVE_WAYLAND) {
            this._call(
                'NotifyPointerAxis',
                GLib.Variant.new('(ddu)', [dx, dy, 0])
            );
            this._call(
                'NotifyPointerAxis',
                GLib.Variant.new('(ddu)', [0, 0, 1])
            );
        } else if (dy > 0) {
            this._call(
                'NotifyPointerAxisDiscrete',
                GLib.Variant.new('(ui)', [Gdk.ScrollDirection.UP, 1])
            );
        } else if (dy < 0) {
            this._call(
                'NotifyPointerAxisDiscrete',
                GLib.Variant.new('(ui)', [Gdk.ScrollDirection.UP, -1])
            );
        }
    }

    /*
     * Keyboard Events
     */
    pressKeysym(keysym) {
        this._call(
            'NotifyKeyboardKeysym',
            GLib.Variant.new('(ub)', [keysym, true])
        );
    }

    releaseKeysym(keysym) {
        this._call(
            'NotifyKeyboardKeysym',
            GLib.Variant.new('(ub)', [keysym, false])
        );
    }

    pressreleaseKeysym(keysym) {
        this._call(
            'NotifyKeyboardKeysym',
            GLib.Variant.new('(ub)', [keysym, true])
        );
        this._call(
            'NotifyKeyboardKeysym',
            GLib.Variant.new('(ub)', [keysym, false])
        );
    }

    /*
     * High-level keyboard input
     */
    pressKey(input, modifiers) {
        // Press Modifiers
        if (modifiers & Gdk.ModifierType.MOD1_MASK)
            this.pressKeysym(Gdk.KEY_Alt_L);
        if (modifiers & Gdk.ModifierType.CONTROL_MASK)
            this.pressKeysym(Gdk.KEY_Control_L);
        if (modifiers & Gdk.ModifierType.SHIFT_MASK)
            this.pressKeysym(Gdk.KEY_Shift_L);
        if (modifiers & Gdk.ModifierType.SUPER_MASK)
            this.pressKeysym(Gdk.KEY_Super_L);

        if (typeof input === 'string') {
            const keysym = Gdk.unicode_to_keyval(input.codePointAt(0));
            this.pressreleaseKeysym(keysym);
        } else {
            this.pressreleaseKeysym(input);
        }

        // Release Modifiers
        if (modifiers & Gdk.ModifierType.MOD1_MASK)
            this.releaseKeysym(Gdk.KEY_Alt_L);
        if (modifiers & Gdk.ModifierType.CONTROL_MASK)
            this.releaseKeysym(Gdk.KEY_Control_L);
        if (modifiers & Gdk.ModifierType.SHIFT_MASK)
            this.releaseKeysym(Gdk.KEY_Shift_L);
        if (modifiers & Gdk.ModifierType.SUPER_MASK)
            this.releaseKeysym(Gdk.KEY_Super_L);
    }

    destroy() {
        if (this.__disposed === undefined) {
            this.__disposed = true;
            GObject.signal_handlers_destroy(this);
        }
    }
});


class Controller {
    constructor() {
        this._nameAppearedId = 0;
        this._session = null;
        this._sessionCloseId = 0;
        this._sessionExpiry = 0;
        this._sessionExpiryId = 0;
        this._sessionStarting = false;

        // Watch for the RemoteDesktop portal
        this._nameWatcherId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'org.gnome.Mutter.RemoteDesktop',
            Gio.BusNameWatcherFlags.NONE,
            this._onNameAppeared.bind(this),
            this._onNameVanished.bind(this)
        );
    }

    get connection() {
        if (this._connection === undefined)
            this._connection = null;

        return this._connection;
    }

    /**
     * Check if this is a Wayland session, specifically for distributions that
     * don't ship pipewire support (eg. Debian/Ubuntu).
     *
     * FIXME: this is a super ugly hack that should go away
     *
     * @return {boolean} %true if wayland is not supported
     */
    _checkWayland() {
        if (HAVE_WAYLAND) {
            // eslint-disable-next-line no-global-assign
            HAVE_REMOTEINPUT = false;
            const service = Gio.Application.get_default();

            if (service === null)
                return true;

            // First we're going to disabled the affected plugins on all devices
            for (const device of service.manager.devices.values()) {
                const supported = device.settings.get_strv('supported-plugins');
                let index;

                if ((index = supported.indexOf('mousepad')) > -1)
                    supported.splice(index, 1);

                if ((index = supported.indexOf('presenter')) > -1)
                    supported.splice(index, 1);

                device.settings.set_strv('supported-plugins', supported);
            }

            // Second we need each backend to rebuild its identity packet and
            // broadcast the amended capabilities to the network
            for (const backend of service.manager.backends.values())
                backend.buildIdentity();

            service.manager.identify();

            return true;
        }

        return false;
    }

    _onNameAppeared(connection, name, name_owner) {
        try {
            this._connection = connection;
        } catch (e) {
            logError(e);
        }
    }

    _onNameVanished(connection, name) {
        try {
            if (this._session !== null)
                this._onSessionClosed(this._session);
        } catch (e) {
            logError(e);
        }
    }

    _onSessionClosed(session) {
        // Disconnect from the session
        if (this._sessionClosedId > 0) {
            session.disconnect(this._sessionClosedId);
            this._sessionClosedId = 0;
        }

        // Destroy the session
        session.destroy();
        this._session = null;
    }

    _onSessionExpired() {
        // If the session has been used recently, schedule a new expiry
        const remainder = Math.floor(this._sessionExpiry - (Date.now() / 1000));

        if (remainder > 0) {
            this._sessionExpiryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                remainder,
                this._onSessionExpired.bind(this)
            );

            return GLib.SOURCE_REMOVE;
        }

        // Otherwise if there's an active session, close it
        if (this._session !== null)
            this._session.stop();

        // Reset the GSource Id
        this._sessionExpiryId = 0;

        return GLib.SOURCE_REMOVE;
    }

    _createRemoteDesktopSession() {
        if (this.connection === null)
            return Promise.reject(new Error('No DBus connection'));

        return new Promise((resolve, reject) => {
            this.connection.call(
                'org.gnome.Mutter.RemoteDesktop',
                '/org/gnome/Mutter/RemoteDesktop',
                'org.gnome.Mutter.RemoteDesktop',
                'CreateSession',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _createScreenCastSession(sessionId) {
        if (this.connection === null)
            return Promise.reject(new Error('No DBus connection'));

        return new Promise((resolve, reject) => {
            const options = new GLib.Variant('(a{sv})', [{
                'disable-animations': GLib.Variant.new_boolean(false),
                'remote-desktop-session-id': GLib.Variant.new_string(sessionId),
            }]);

            this.connection.call(
                'org.gnome.Mutter.ScreenCast',
                '/org/gnome/Mutter/ScreenCast',
                'org.gnome.Mutter.ScreenCast',
                'CreateSession',
                options,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, res) => {
                    try {
                        res = connection.call_finish(res);
                        resolve(res.deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _ensureAdapter() {
        try {
            // Update the timestamp of the last event
            this._sessionExpiry = Math.floor((Date.now() / 1000) + SESSION_TIMEOUT);

            // Session is active
            if (this._session !== null)
                return;

            // Mutter's RemoteDesktop is not available, fall back to Atspi
            if (this.connection === null) {
                debug('Falling back to Atspi');

                // If we got here in Wayland, we need to re-adjust and bail
                if (this._checkWayland())
                    return;

                const fallback = imports.service.components.atspi;
                this._session = new fallback.Controller();

            // Mutter is available and there isn't another session starting
            } else if (this._sessionStarting === false) {
                this._sessionStarting = true;

                debug('Creating Mutter RemoteDesktop session');

                // This takes three steps: creating the remote desktop session,
                // starting the session, and creating a screencast session for
                // the remote desktop session.
                const objectPath = await this._createRemoteDesktopSession();

                this._session = new RemoteSession(objectPath);
                await this._session.start();

                await this._createScreenCastSession(this._session.session_id);

                // Watch for the session ending
                this._sessionClosedId = this._session.connect(
                    'closed',
                    this._onSessionClosed.bind(this)
                );

                if (this._sessionExpiryId === 0) {
                    this._sessionExpiryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT,
                        SESSION_TIMEOUT,
                        this._onSessionExpired.bind(this)
                    );
                }

                this._sessionStarting = false;
            }
        } catch (e) {
            logError(e);

            if (this._session !== null) {
                this._session.destroy();
                this._session = null;
            }

            this._sessionStarting = false;
        }
    }

    /*
     * Pointer Events
     */
    movePointer(dx, dy) {
        try {
            if (dx === 0 && dy === 0)
                return;

            this._ensureAdapter();
            this._session.movePointer(dx, dy);
        } catch (e) {
            debug(e);
        }
    }

    pressPointer(button) {
        try {
            this._ensureAdapter();
            this._session.pressPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    releasePointer(button) {
        try {
            this._ensureAdapter();
            this._session.releasePointer(button);
        } catch (e) {
            debug(e);
        }
    }

    clickPointer(button) {
        try {
            this._ensureAdapter();
            this._session.clickPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    doubleclickPointer(button) {
        try {
            this._ensureAdapter();
            this._session.doubleclickPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    scrollPointer(dx, dy) {
        if (dx === 0 && dy === 0)
            return;

        try {
            this._ensureAdapter();
            this._session.scrollPointer(dx, dy);
        } catch (e) {
            debug(e);
        }
    }

    /*
     * Keyboard Events
     */
    pressKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._session.pressKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    releaseKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._session.releaseKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    pressreleaseKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._session.pressreleaseKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    /*
     * High-level keyboard input
     */
    pressKeys(input, modifiers) {
        try {
            this._ensureAdapter();

            if (typeof input === 'string') {
                for (let i = 0; i < input.length; i++)
                    this._session.pressKey(input[i], modifiers);
            } else {
                this._session.pressKey(input, modifiers);
            }
        } catch (e) {
            debug(e);
        }
    }

    destroy() {
        if (this._session !== null) {
            // Disconnect from the session
            if (this._sessionClosedId > 0) {
                this._session.disconnect(this._sessionClosedId);
                this._sessionClosedId = 0;
            }

            this._session.destroy();
            this._session = null;
        }

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }
    }
}


/**
 * The service class for this component
 */
var Component = Controller;
