'use-strict';

var OFF_WHITE_CLASS = 'light-text';
var OFF_WHITE_LUMINANCE = 0.07275541795665634;
var OFF_WHITE_VALUE = 0.94;

var OFF_BLACK_CLASS = 'dark-text';
var OFF_BLACK_LUMINANCE = 0.0046439628482972135;
var OFF_BLACK_VALUE = 0.06;


function randomRGB() {
    return [Math.random(), Math.random(), Math.random()];
};


// See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
function relativeLuminance(r, g, b) {
    if (Array.isArray(r)) { [r, g, b] = r; }

    let R = (r > 0.03928) ? r / 12.92 : Math.pow(((r + 0.055)/1.055), 2.4);
    let G = (g > 0.03928) ? g / 12.92 : Math.pow(((g + 0.055)/1.055), 2.4);
    let B = (b > 0.03928) ? b / 12.92 : Math.pow(((b + 0.055)/1.055), 2.4);

    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};


// See: https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
function getFgRGB(r, g, b) {
    if (Array.isArray(r)) { [r, g, b] = r; }

    let bgLuminance = this.relativeLuminance([r, g, b]);
    let lightContrast = (OFF_WHITE_LUMINANCE + 0.05) / (bgLuminance + 0.05);
    let darkContrast = (bgLuminance + 0.05) / (OFF_BLACK_LUMINANCE + 0.05);

    let value = (darkContrast > lightContrast) ? 0.06 : 0.94;
    return [value, value, value];
};


function setFgClass(widget, backgroundColor) {
    let dark = (getFgRGB(backgroundColor)[0] === 0.06);

    let style = widget.get_style_context();
    style.remove_class(dark ? OFF_WHITE_CLASS : OFF_BLACK_CLASS);
    style.add_class(dark ? OFF_BLACK_CLASS : OFF_WHITE_CLASS);
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

