"use strict";

// Imports
const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Tweener = imports.tweener.tweener;

const GIRepository = imports.gi.GIRepository;
GIRepository.Repository.prepend_search_path("/usr/lib/gnome-shell");
GIRepository.Repository.prepend_library_path("/usr/lib/gnome-shell");
const Gvc = imports.gi.Gvc;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


// Each Gvc.MixerControl is a connection to PulseAudio,
// so it's better to make it a singleton
var MIXER = new Gvc.MixerControl({ name: 'GSConnect' });
MIXER.open();


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
        
        this._max = MIXER.get_vol_max_norm()
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
    Extends: GObject.Object,
    
    _init: function () {
        this.parent();
        
        this._control = MIXER;
        
        this._control.connect("default-sink-changed", () => {
            this.output = new Stream(this._control.get_default_sink());
        });
        
        this._control.connect("default-source-changed", () => {
            this.input = new Stream(this._control.get_default_source());
        });
        
        this.output = new Stream(this._control.get_default_sink());
        this.input = new Stream(this._control.get_default_source());
    }
});

