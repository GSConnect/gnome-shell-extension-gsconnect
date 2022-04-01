"use strict";

const ByteArray = imports.byteArray;

const Gio = imports.gi.Gio;
const GjsPrivate = imports.gi.GjsPrivate;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// laucher for wl-clipboard
const launcher = new Gio.SubprocessLauncher({
  flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
});

/*
 * DBus Interface Info
 */
const DBUS_NAME = "org.gnome.Shell.Extensions.GSConnect.Clipboard";
const DBUS_PATH = "/org/gnome/Shell/Extensions/GSConnect/Clipboard";
const DBUS_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.gnome.Shell.Extensions.GSConnect.Clipboard">
    <!-- Methods -->
    <method name="GetMimetypes">
      <arg direction="out" type="as" name="mimetypes"/>
    </method>
    <method name="GetText">
      <arg direction="out" type="s" name="text"/>
    </method>
    <method name="SetText">
      <arg direction="in" type="s" name="text"/>
    </method>
    <method name="GetValue">
      <arg direction="in" type="s" name="mimetype"/>
      <arg direction="out" type="ay" name="value"/>
    </method>
    <method name="SetValue">
      <arg direction="in" type="ay" name="value"/>
      <arg direction="in" type="s" name="mimetype"/>
    </method>

    <!-- Signals -->
    <signal name="OwnerChange"/>
  </interface>
</node>
`);
const DBUS_INFO = DBUS_NODE.lookup_interface(DBUS_NAME);

/*
 * Text Mimetypes
 */
const TEXT_MIMETYPES = [
  "text/plain;charset=utf-8",
  "UTF8_STRING",
  "text/plain",
  "STRING",
];

/* GSConnectClipboardPortal:
 *
 * A simple clipboard portal, especially useful on Wayland where GtkClipboard
 * doesn't work in the background.
 */
var Clipboard = GObject.registerClass(
  {
    GTypeName: "GSConnectShellClipboard",
  },
  class GSConnectShellClipboard extends GjsPrivate.DBusImplementation {
    _init() {
      super._init({
        g_interface_info: DBUS_INFO,
      });

      this._transferring = false;

      this.watcher = launcher.spawnv([
        "wl-paste",
        "-w",
        "dbus-send",
        DBUS_PATH,
        "--dest=" + DBUS_NAME,
        DBUS_NAME + ".OwnerChange",
      ]);

      // Prepare DBus interface
      this._handleMethodCallId = this.connect(
        "handle-method-call",
        this._onHandleMethodCall.bind(this)
      );

      this._nameId = Gio.DBus.own_name(
        Gio.BusType.SESSION,
        DBUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        this._onBusAcquired.bind(this),
        null,
        this._onNameLost.bind(this)
      );
    }

    _onBusAcquired(connection, name) {
      try {
        this.export(connection, DBUS_PATH);
      } catch (e) {
        logError(e);
      }
    }

    _onNameLost(connection, name) {
      try {
        this.unexport();
      } catch (e) {
        logError(e);
      }
    }

    async _onHandleMethodCall(iface, name, parameters, invocation) {
      let retval;

      try {
        const args = parameters.recursiveUnpack();

        retval = await this[name](...args);
      } catch (e) {
        if (e instanceof GLib.Error) {
          invocation.return_gerror(e);
        } else {
          if (!e.name.includes("."))
            e.name = `org.gnome.gjs.JSError.${e.name}`;

          invocation.return_dbus_error(e.name, e.message);
        }

        return;
      }

      if (retval === undefined) retval = new GLib.Variant("()", []);

      try {
        if (!(retval instanceof GLib.Variant)) {
          const args = DBUS_INFO.lookup_method(name).out_args;
          retval = new GLib.Variant(
            `(${args.map((arg) => arg.signature).join("")})`,
            args.length === 1 ? [retval] : retval
          );
        }

        invocation.return_value(retval);

        // Without a response, the client will wait for timeout
      } catch (e) {
        invocation.return_dbus_error(
          "org.gnome.gjs.JSError.ValueError",
          "Service implementation returned an incorrect value type"
        );
      }
    }

    /**
     * Get the available mimetypes of the current clipboard content
     *
     * @return {Promise<string[]>} A list of mime-types
     */

    GetMimetypes() {
      return new Promise((resolve, reject) => {
        const proc = launcher.spawnv([
          "wl-paste",
          "--list-types",
          "-n",
        ]);
        proc.communicate_utf8_async(null, null, (proc, res) => {
          try {
            let [, stdout, stderr] =
              proc.communicate_utf8_finish(res);
            if (proc.get_successful()) {
              resolve(stdout.trim().split("\n"));
            } else {
              logError(stderr);
            }
          } catch (e) {
            reject(e);
          }
        });
      });
    }

    /**
     * Get the text content of the clipboard
     *
     * @return {Promise<string>} Text content of the clipboard
     */
    async GetText() {
      return new Promise((resolve, reject) => {
        this.GetMimetypes().then((mimetypes) => {
          const mimetype = TEXT_MIMETYPES.find((type) =>
            mimetypes.includes(type)
          );

          if (mimetype !== undefined) {
            const proc = launcher.spawnv(["wl-paste", "-n"]);
            proc.communicate_utf8_async(null, null, (proc, res) => {
              try {
                let [, stdout, stderr] =
                  proc.communicate_utf8_finish(res);
                if (proc.get_successful()) {
                  resolve(stdout);
                } else {
                  logError(stderr);
                }
              } catch (e) {
                reject(e);
              }
            });
          } else {
            reject(new Error("text not available"));
          }
        });
      });
    }

    /**
     * Set the text content of the clipboard
     *
     * @param {string} text - text content to set
     * @return {Promise} A promise for the operation
     */
    SetText(text) {
      return new Promise((resolve, reject) => {
        try {
          if (typeof text !== "string") {
            throw new Gio.DBusError({
              code: Gio.DBusError.INVALID_ARGS,
              message: "expected string",
            });
          }

          launcher.spawnv(["wl-copy", text]);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }



    destroy() {
      if (this._nameId > 0) {
        Gio.bus_unown_name(this._nameId);
        this._nameId = 0;
      }

      if (this._handleMethodCallId > 0) {
        this.disconnect(this._handleMethodCallId);
        this._handleMethodCallId = 0;
        this.unexport();
      }
      if (this.watcher) {
        this.watcher.force_exit();
      }
    }
  }
);

var _portal = null;
var _portalId = 0;

/**
 * Watch for the service to start and export the clipboard portal when it does.
 */
function watchService() {
  if (GLib.getenv("XDG_SESSION_TYPE") !== "wayland") return;

  if (_portalId > 0) return;

  _portalId = Gio.bus_watch_name(
    Gio.BusType.SESSION,
    "org.gnome.Shell.Extensions.GSConnect",
    Gio.BusNameWatcherFlags.NONE,
    () => {
      if (_portal === null) _portal = new Clipboard();
    },
    () => {
      if (_portal !== null) {
        _portal.destroy();
        _portal = null;
      }
    }
  );
}

/**
 * Stop watching the service and export the portal if currently running.
 */
function unwatchService() {
  if (_portalId > 0) {
    Gio.bus_unwatch_name(_portalId);
    _portalId = 0;
  }
}

// vim:tabstop=2:shiftwidth=2:expandtab
