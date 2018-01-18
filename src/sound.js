"use strict";

const Lang = imports.lang;
const Tweener = imports.tweener.tweener;

const GIRepository = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

GIRepository.Repository.prepend_search_path("/usr/lib/gnome-shell");
GIRepository.Repository.prepend_library_path("/usr/lib/gnome-shell");
GIRepository.Repository.prepend_search_path("/usr/lib64/gnome-shell");
GIRepository.Repository.prepend_library_path("/usr/lib64/gnome-shell");

// Local Imports
imports.searchPath.push(ext.datadir);

const Common = imports.common;


// Gvc.MixerControl singleton
try {
    var Gvc = imports.gi.Gvc;
    var _mixerControl = new Gvc.MixerControl({ name: "GSConnect" });
    _mixerControl.open();
} catch (e) {
    debug("Warning: failed to initialize Gvc: " + e);
    var _mixerControl = undefined;
}

// GSound.Context singleton
try {
    var GSound = imports.gi.GSound;
    var _gsoundContext = new GSound.Context();
    _gsoundContext.init(null);
} catch (e) {
    debug("Warning: failed to initialize GSound: " + e);
    var _gsoundContext = undefined;
}


function playThemeSound (name) {
    if (_gsoundContext) {
        _gsoundContext.play_simple({ "event.id" : name }, null);
        return true;
    } else if (Common.checkCommand("canberra-gtk-play")) {
        GLib.spawn_command_line_async("canberra-gtk-play -i " + name);
        return true;
    }

    return false;
};


function loopThemeSound (name, cancellable) {
    if (_gsoundContext) {
        _gsoundContext.play_full(
            { "event.id" : name },
            cancellable,
            (source, res) => {
                try {
                    source.play_full_finish(res);
                    loopThemeSound(name, cancellable);
                } catch (e) {
                }
            }
        );
    } else if (Common.checkCommand("canberra-gtk-play")) {
        let [ok, pid] = GLib.spawn_async(
            null,
            ["canberra-gtk-play", "-i", name],
            null,
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            null
        );
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
            if (!cancellable.is_cancelled()) {
                loopThemeSound(name, cancellable);
            }
        });
    }

    return false;
};


var Stream = new Lang.Class({
    Name: "GSConnectSoundStream",
    Extends: GObject.Object,
    Properties: {
        "muted": GObject.ParamSpec.boolean(
            "muted",
            "StreamMuted",
            "Stream Muted",
            GObject.ParamFlags.READWRITE,
            false
        ),
        "volume": GObject.ParamSpec.int(
            "volume",
            "StreamVolume",
            "Stream Volume",
            GObject.ParamFlags.READABLE,
            0
        )
    },

    _init: function (stream) {
        this.parent();

        this._max = _mixerControl.get_vol_max_norm()
        this._stream = stream;
    },

    get muted () {
        return this._stream.is_muted;
    },

    set muted (bool) {
        this._stream.change_is_muted(bool);
    },

    get volume () {
        return Math.round(100 * this._stream.volume / this._max) / 100;
    },

    set volume (num) {
        this._stream.volume = num * this._max;
        this._stream.push_volume();
    },

    lower: function (value) {
        Tweener.removeTweens(this);
        Tweener.addTween(this, {
            volume: value,
            time: 1,
            transition: "easeOutCubic",
            onComplete: () => { Tweener.removeTweens(this); }
        });
    },

    raise: function (value) {
        Tweener.removeTweens(this);
        Tweener.addTween(this, {
            volume: value,
            time: 1,
            transition: "easeInCubic",
            onComplete: () => { Tweener.removeTweens(this); }
        });
    }
});


var Mixer = new Lang.Class({
    Name: "GSConnectSoundMixer",

    _init: function () {
        this._control = _mixerControl;

        this._control.connect("default-sink-changed", () => {
            this.output = new Stream(this._control.get_default_sink());
        });

        this._control.connect("default-source-changed", () => {
            this.input = new Stream(this._control.get_default_source());
        });

        this._control.connect("state-changed", () => {
            if (this._control.get_state() == Gvc.MixerControlState.READY) {
                this.output = new Stream(this._control.get_default_sink());
                this.input = new Stream(this._control.get_default_source());
            }
        });

        this.output = new Stream(this._control.get_default_sink());
        this.input = new Stream(this._control.get_default_source());
    }
});

