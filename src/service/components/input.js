'use strict';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


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
                            Gio.DBusError.strip_remote_error(e);
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
                            Gio.DBusError.strip_remote_error(e);
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            this.destroy();
            throw e;
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
        this._controller = null;
        this._nameAppearedId = 0;
        this._sessionCloseId = 0;

        this._prepareController();
    }

    async _prepareController() {
        try {
            // Check for Mutter's remote desktop interface
            if (this._mutter === undefined) {
                let names = await this._listNames();
                this._mutter = names.includes('org.gnome.Mutter.RemoteDesktop');
            }

            // Prefer the newer remote desktop interface
            if (this._mutter) {
                debug('Using Mutter RemoteDesktop');

                if (this._nameAppearedId === 0) {
                    this._nameAppearedId = Gio.bus_watch_name_on_connection(
                        this.connection,
                        'org.gnome.Mutter.RemoteDesktop',
                        Gio.BusNameWatcherFlags.NONE,
                        this._onNameAppeared.bind(this),
                        this._onNameVanished.bind(this)
                    );
                }

            // Fallback to Atspi
            } else {
                debug('Falling back to Atspi');

                let fallback = imports.service.components.atspi;
                this._controller = new fallback.Controller();
            }
        } catch (e) {
            this._mutter = false;
            debug(e);
        }
    }

    get connection() {
        if (this._connection === undefined) {
            let service = Gio.Application.get_default();
            this._connection = service.get_dbus_connection();
        }

        return this._connection;
    }

    async _onNameAppeared(connection, name, name_owner) {
        try {
            let objectPath = await this._createSession();
            this._controller = new RemoteSession(objectPath);
            this._controller.start();

            this._sessionClosedId = this._controller.connect(
                'closed',
                this._onSessionClosed.bind(this)
            );
        } catch (e) {
            logError(e);
        }
    }

    _onNameVanished(connection, name) {
        try {
            // Ensure we're disconnected from the session
            if (this._controller && this._sessionClosedId > 0) {
                this._controller.disconnect(this._sessionClosedId);
                this._sessionClosedId = 0;
            }

            // Destroy the session
            if (this._controller) {
                this._controller.destroy();
                this._controller = null;
            }
        } catch (e) {
            logError(e);
        }
    }

    _listNames() {
        return new Promise((resolve, reject) => {
            this.connection.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
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

    _createSession() {
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
                        resolve(res.deep_unpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    // FIXME
    _onSessionClosed(session) {
        // Ensure we're disconnected from the session
        if (this._sessionClosedId > 0) {
            session.disconnect(this._sessionClosedId);
            this._sessionClosedId = 0;
        }

        // Destroy the session
        session.destroy();
        this._controller = undefined;

        // Prepare a new session
        this._prepareController();
    }

    /**
     * Pointer Events
     */
    movePointer(dx, dy) {
        this._controller.movePointer(dx, dy);
    }

    pressPointer(button) {
        this._controller.pressPointer(button);
    }

    releasePointer(button) {
        this._controller.releasePointer(button);
    }

    clickPointer(button) {
        this._controller.clickPointer(button);
    }

    doubleclickPointer(button) {
        this._controller.doubleclickPointer(button);
    }

    scrollPointer(dx, dy) {
        this._controller.scrollPointer(dx, dy);
    }

    /**
     * Keyboard Events
     */
    pressKeysym(keysym) {
        this._controller.pressKeysym(keysym);
    }

    releaseKeysym(keysym) {
        this._controller.releaseKeysym(keysym);
    }

    pressreleaseKeysym(keysym) {
        this._controller.pressreleaseKeysym(keysym);
    }

    /**
     * High-level keyboard input
     */
    pressKey(input, modifiers) {
        this._controller.pressKey(input, modifiers);
    }

    destroy() {
        if (this._controller !== undefined) {
            this._controller.destroy();
            this._controller = undefined;
        }
    }
};


/**
 * The service class for this component
 */
var Component = Controller;

