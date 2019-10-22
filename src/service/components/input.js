'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


const SESSION_TIMEOUT = 15;


const RemoteSession = GObject.registerClass({
    GTypeName: 'GSConnectRemoteSession',
    Implements: [Gio.DBusInterface],
    Properties: {
        'session-id': GObject.ParamSpec.string(
            'session-id',
            'SessionId',
            'The unique session ID',
            GObject.ParamFlags.READABLE,
            null
        )
    },
    Signals: {
        'closed': {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    }
}, class RemoteSession extends Gio.DBusProxy {

    _init(objectPath) {
        super._init({
            g_bus_type: Gio.BusType.SESSION,
            g_name: 'org.gnome.Mutter.RemoteDesktop',
            g_object_path: objectPath,
            g_interface_name: 'org.gnome.Mutter.RemoteDesktop.Session'
        });

        this._started = false;
    }

    vfunc_g_signal(sender_name, signal_name, parameters) {
        if (signal_name === 'Closed') {
            this.emit('closed');
        }
    }

    get session_id() {
        if (this._id === undefined) {
            this._id = this.get_cached_property('SessionId').unpack();
        }

        return this._id;
    }

    _call(name, parameters = null) {
        if (!this._started) return;

        this.call(
            name,
            parameters,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    Gio.DBusError.strip_remote_error(e);
                    logError(e);
                }
            }
        );
    }

    async start() {
        try {
            if (this._started) return;

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
        // TODO: NotifyPointerAxis only seems to work on Wayland, but maybe
        //       NotifyPointerAxisDiscrete is the better choice anyways
        if (_WAYLAND) {
            this._call(
                'NotifyPointerAxis',
                GLib.Variant.new('(ddu)', [dx, dy, 0])
            );
            this._call(
                'NotifyPointerAxis',
                GLib.Variant.new('(ddu)', [0, 0, 1])
            );
        } else {
            if (dy > 0) {
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
    }

    /**
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

    /**
     * High-level keyboard input
     */
    pressKey(input, modifiers) {
        // Press Modifiers
        if (modifiers & Gdk.ModifierType.MOD1_MASK) this.pressKeysym(Gdk.KEY_Alt_L);
        if (modifiers & Gdk.ModifierType.CONTROL_MASK) this.pressKeysym(Gdk.KEY_Control_L);
        if (modifiers & Gdk.ModifierType.SHIFT_MASK) this.pressKeysym(Gdk.KEY_Shift_L);
        if (modifiers & Gdk.ModifierType.SUPER_MASK) this.pressKeysym(Gdk.KEY_Super_L);

        if (typeof input === 'string') {
            let keysym = Gdk.unicode_to_keyval(input.codePointAt(0));
            this.pressreleaseKeysym(keysym);
        } else {
            this.pressreleaseKeysym(input);
        }

        // Release Modifiers
        if (modifiers & Gdk.ModifierType.MOD1_MASK) this.releaseKeysym(Gdk.KEY_Alt_L);
        if (modifiers & Gdk.ModifierType.CONTROL_MASK) this.releaseKeysym(Gdk.KEY_Control_L);
        if (modifiers & Gdk.ModifierType.SHIFT_MASK) this.releaseKeysym(Gdk.KEY_Shift_L);
        if (modifiers & Gdk.ModifierType.SUPER_MASK) this.releaseKeysym(Gdk.KEY_Super_L);
    }

    destroy() {
        if (this.__disposed === undefined) {
            this.__disposed = true;
            this.run_dispose();
        }
    }
});


const Controller = class Controller {
    constructor() {
        this._adapter = null;
        this._nameAppearedId = 0;
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
        if (this._connection === undefined) {
            this._connection = null;
        }

        return this._connection;
    }

    _onNameAppeared(connection, name, name_owner) {
        try {
            // Destroy any old Atspi adapter
            if (!this.connection && this._adapter) {
                this._adapter.destroy();
                this._adapter = null;
            }

            this._connection = connection;
        } catch (e) {
            logError(e);
        }
    }

    _onNameVanished(connection, name) {
        try {
            // Destroy any old RemoteDesktop session
            if (this._adapter instanceof RemoteSession) {
                // Disconnect from the session
                if (this._sessionClosedId > 0) {
                    this._adapter.disconnect(this._sessionClosedId);
                    this._sessionClosedId = 0;
                }

                // Destroy the session
                this._adapter.destroy();
                this._adapter = null;
            }

            this._connection = null;
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
        this._adapter = null;
    }

    _onSessionExpired() {
        // If the session has been used recently, schedule a new expiry
        let remainder = Math.floor(this._sessionExpiry - (Date.now() / 1000));

        if (remainder > 0) {
            this._sessionExpiryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                remainder,
                this._onSessionExpired.bind(this)
            );

            return GLib.SOURCE_REMOVE;
        }

        // If there's a current session, close it
        if (this._adapter instanceof RemoteSession) {
            this._adapter.stop();
        }

        // Reset the GSource Id
        this._sessionExpiryId = 0;

        return GLib.SOURCE_REMOVE;
    }

    _createSession() {
        return new Promise((resolve, reject) => {
            if (this.connection === null) {
                reject(new Error('No DBus connection'));
                return;
            }

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
                        resolve(res.deep_unpack()[0]);
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

            // Adapter is ensured
            if (this._adapter) return;

            // Mutter's RemoteDesktop portal is not available
            if (!this.connection) {
                debug('Falling back to Atspi');

                let fallback = imports.service.components.atspi;
                this._adapter = new fallback.Controller();

            // Mutter is available and there isn't another session starting
            } else if (this._sessionStarting === false) {
                debug('Creating Mutter RemoteDesktop session');

                this._sessionStarting = true;

                let objectPath = await this._createSession();
                this._adapter = new RemoteSession(objectPath);
                this._adapter.start();

                this._sessionClosedId = this._adapter.connect(
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
            }
        } catch (e) {
            logError(e);

            this._adapter.destroy();
            this._adapter = null;
        } finally {
            this._sessionStarting = false;
        }
    }

    /**
     * Pointer Events
     */
    movePointer(dx, dy) {
        try {
            if (dx === 0 && dy === 0) return;

            this._ensureAdapter();
            this._adapter.movePointer(dx, dy);
        } catch (e) {
            debug(e);
        }
    }

    pressPointer(button) {
        try {
            this._ensureAdapter();
            this._adapter.pressPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    releasePointer(button) {
        try {
            this._ensureAdapter();
            this._adapter.releasePointer(button);
        } catch (e) {
            debug(e);
        }
    }

    clickPointer(button) {
        try {
            this._ensureAdapter();
            this._adapter.clickPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    doubleclickPointer(button) {
        try {
            this._ensureAdapter();
            this._adapter.doubleclickPointer(button);
        } catch (e) {
            debug(e);
        }
    }

    scrollPointer(dx, dy) {
        if (dx === 0 && dy === 0) return;

        try {
            this._ensureAdapter();
            this._adapter.scrollPointer(dx, dy);
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Keyboard Events
     */
    pressKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._adapter.pressKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    releaseKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._adapter.releaseKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    pressreleaseKeysym(keysym) {
        try {
            this._ensureAdapter();
            this._adapter.pressreleaseKeysym(keysym);
        } catch (e) {
            debug(e);
        }
    }

    /**
     * High-level keyboard input
     */
    pressKey(input, modifiers) {
        try {
            this._ensureAdapter();
            this._adapter.pressKey(input, modifiers);
        } catch (e) {
            debug(e);
        }
    }

    destroy() {
        if (this._adapter !== null) {
            // Disconnect from the session
            if (this._sessionClosedId > 0) {
                this._adapter.disconnect(this._sessionClosedId);
                this._sessionClosedId = 0;
            }

            this._adapter.destroy();
            this._adapter = null;
        }

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }
    }
};


/**
 * The service class for this component
 */
var Component = Controller;

