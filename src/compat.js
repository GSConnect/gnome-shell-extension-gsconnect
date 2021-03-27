'use strict';

// https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/1072
function get_root(widget) {
    if (typeof widget.get_toplevel === 'function')
        return widget.get_toplevel();
    else
        return widget.get_root();
}
