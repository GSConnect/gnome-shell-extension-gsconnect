'use-strict';

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;

const OFF_WHITE_LUMINANCE = 0.07275541795665634;
const OFF_WHITE_VALUE = 0.94;

const OFF_BLACK_LUMINANCE = 0.0046439628482972135;
const OFF_BLACK_VALUE = 0.06;


/**
 * Return a random color
 *
 * @param {*} [salt] - If not %null, will be used as salt for generating a color
 * @param {Number} alpha - A value in the [0...1] range for the alpha channel
 * @return {Gdk.RGBA} - A new Gdk.RGBA object generated from the input
 */
function randomRGBA(salt=null, alpha=1.0) {
    let red, green, blue;

    if (salt !== null) {
        let hash = new GLib.Variant('s', `${salt}`).hash();
        red = ((hash & 0xFF0000) >> 16) / 255;
        green = ((hash & 0x00FF00) >> 8) / 255;
        blue = (hash & 0x0000FF) / 255;
    } else {
        red = Math.random();
        green = Math.random();
        blue = Math.random();
    }

    return new Gdk.RGBA({ red: red, green: green, blue: blue, alpha: alpha });
};


/**
 * Get the relative luminance of a RGB set
 * See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
 *
 * @param {Number} r - A number in the [0.0, 1.0] range for the red value
 * @param {Number} g - A number in the [0.0, 1.0] range for the green value
 * @param {Number} b - A number in the [0.0, 1.0] range for the blue value
 * @return {Number} - ...
 */
function relativeLuminance(rgba) {
    let { red, green, blue } = rgba;

    let R = (red > 0.03928) ? red / 12.92 : Math.pow(((red + 0.055)/1.055), 2.4);
    let G = (green > 0.03928) ? green / 12.92 : Math.pow(((green + 0.055)/1.055), 2.4);
    let B = (blue > 0.03928) ? blue / 12.92 : Math.pow(((blue + 0.055)/1.055), 2.4);

    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};


/**
 * Get a Gdk.RGBA contrasted for the input
 * See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 *
 * @param {Gdk.RGBA} - A Gdk.RGBA object for the background color
 * @return {Gdk.RGBA} - A Gdk.RGBA object for the foreground color
 */
function getFgRGBA(rgba) {
    let bgLuminance = this.relativeLuminance(rgba);
    let lightContrast = (OFF_WHITE_LUMINANCE + 0.05) / (bgLuminance + 0.05);
    let darkContrast = (bgLuminance + 0.05) / (OFF_BLACK_LUMINANCE + 0.05);

    let value = (darkContrast > lightContrast) ? 0.06 : 0.94;
    return new Gdk.RGBA({ red: value, green: value, blue: value, alpha: 0.5 });
};


function hsv2rgb(h, s, v) {
    if (Array.isArray(h)) { [h, s, v] = h; }

    let r, g, b;

    h = h / 360;
    s = s / 100;
    v = v / 100;

    let i = Math.floor(h * 6);
    let f = h * 6 - i;
    let p = v * (1 - s);
    let q = v * (1 - f * s);
    let t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return [r, g, b];
};

