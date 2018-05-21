'use strict';

const Cairo = imports.cairo;

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;

const ModalDialog = imports.ui.modalDialog;

// Local Imports
imports.searchPath.unshift(gsconnect.datadir);
const _ = gsconnect._;
const Color = imports.modules.color;
const Tooltip = imports.shell.tooltip;


/**
 */
var Dialog = class Dialog extends ModalDialog.ModalDialog {

    _init(params) {
        super._init();

        let headerBar = new St.BoxLayout({
            style_class: 'nm-dialog-header-hbox'
        });
        this.contentLayout.add(headerBar);

        this._icon = new St.Icon({
            style_class: 'nm-dialog-header-icon',
            gicon: new Gio.ThemedIcon({ name: params.icon })
        });
        headerBar.add(this._icon);

        let titleBox = new St.BoxLayout({ vertical: true });
        headerBar.add(titleBox);

        this._title = new St.Label({
            style_class: 'nm-dialog-header',
            text: params.title
        });
        titleBox.add(this._title);

        this._subtitle = new St.Label({
            style_class: 'nm-dialog-subheader',
            text: params.subtitle
        });
        titleBox.add(this._subtitle);

        this.contentLayout.style_class = 'nm-dialog-content';

        this.content = new St.BoxLayout({ vertical: true });
        this.contentLayout.add(this.content);
    }

    get icon () {
        return this._icon.gicon.name;
    }

    set icon (name) {
        this._icon.gicon.name = name;
    }

    get title () {
        return this._title.text;
    }

    set title (text) {
        this._title.text = text;
    }

    get subtitle () {
        return this._title.text;
    }

    set subtitle (text) {
        this._title.text = text;
    }
}


var RadioButton = GObject.registerClass({
    GTypeName: 'GSConnectShellRadioButton'
}, class RadioButton extends St.BoxLayout {

    _init(params) {
        params = Object.assign({
            text: null,
            widget: null,
            group: [],
            active: false,
            tooltip_markup: false,
            tooltip_text: false
        }, params);

        super._init({
            style_class: 'radio-button',
            style: 'spacing: 6px;',
            vertical: false
        });

        this.button = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({ icon_name: 'radio-symbolic', icon_size: 16 })
        });
        this.add_child(this.button);

        this.add_child(new St.Label());

        if (params.text) {
            this.text = params.text;
        } else {
            this.widget = params.widget;
        }

        //
        this.button.connect('clicked', () => {
            this.active = true;
        });

        // Group
        this.group = params.group;
        this.connect('destroy', () => {
            this.group.splice(this.group.indexOf(this), 1);
        });

        this.active = params.active;

        // Tooltip
        this.tooltip = new Tooltip.Tooltip({ parent: this });

        if (params.tooltip_markup) {
            this.tooltip.markup = params.tooltip_markup;
        } else if (params.tooltip_text) {
            this.tooltip.text = params.tooltip_text;
        }
    }

    get active() {
        return (this.button.child.icon_name === 'radio-checked-symbolic');
    }

    set active(bool) {
        if (bool) {
            this.button.child.icon_name = 'radio-checked-symbolic';

            for (let radio of this.group) {
                if (radio !== this) {
                    radio.button.child.icon_name = 'radio-symbolic';
                }
            }
        } else {
            this.button.child.icon_name = 'radio-symbolic';
        }
    }

    get group() {
        return this._group;
    }

    set group(group) {
        this._group = group;

        if (this._group.indexOf(this) < 0) {
            this._group.push(this);
        }

        this.active = (this.group.length === 1);
    }

    get text() {
        if (this.widget instanceof St.Label) {
            return this.widget.text;
        }

        return null;
    }

    set text(text) {
        if (typeof text === 'string') {
            this.widget = new St.Label({ text: text });
        }
    }

    get widget () {
        return this.get_child_at_index(1);
    }

    set widget (widget) {
        if (widget instanceof Clutter.Actor) {
            widget.y_align = Clutter.ActorAlign.CENTER
            this.replace_child(this.widget, widget);
        }
    }
});

