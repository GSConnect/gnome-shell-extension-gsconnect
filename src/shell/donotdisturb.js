'use strict';

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

const _ = gsconnect._;
const Tooltip = imports.shell.tooltip;


/**
 * A simple implementation of GtkRadioButton for St
 */
var RadioButton = GObject.registerClass({
    GTypeName: 'GSConnectShellRadioButton'
}, class RadioButton extends St.BoxLayout {

    _init(params) {
        params = Object.assign({
            text: null,
            widget: null,
            group: [],
            active: false
        }, params);

        super._init({
            style_class: 'gsconnect-radio-button',
            vertical: false
        });

        this.button = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({icon_name: 'radio-symbolic', icon_size: 16})
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
            this.widget = new St.Label({text: text});
        }
    }

    get widget () {
        return this.get_child_at_index(1);
    }

    set widget (widget) {
        if (widget instanceof Clutter.Actor) {
            widget.y_align = Clutter.ActorAlign.CENTER;
            this.replace_child(this.widget, widget);
        }
    }
});


var Dialog = class Dialog extends ModalDialog.ModalDialog {

    constructor() {
        super({styleClass: 'gsconnect-dnd-dialog'});

        this.contentLayout.style_class = 'nm-dialog-content';

        // Header
        let headerBox = new St.BoxLayout({
            style_class: 'nm-dialog-header-hbox'
        });
        this.contentLayout.add(headerBox);

        let icon = new St.Icon({
            style_class: 'nm-dialog-header-icon',
            gicon: new Gio.ThemedIcon({
                name: 'preferences-system-time-symbolic'
            })
        });
        headerBox.add(icon);

        let titleBox = new St.BoxLayout({vertical: true});
        headerBox.add(titleBox);

        let header = new St.Label({
            style_class: 'nm-dialog-header',
            text: _('Do Not Disturb')
        });
        titleBox.add(header);

        let subheader = new St.Label({
            style_class: 'nm-dialog-subheader',
            text: _('Silence Mobile Device Notifications')
        });
        titleBox.add(subheader);

        // Content
        let radioList = new St.BoxLayout({
            style_class: 'gsconnect-radio-list',
            vertical: true
        });
        this.contentLayout.add(radioList);

        // 1 hour in seconds
        this._time = 1 * 60 * 60;

        this._radioIndefinite = new RadioButton({
            text: _('Until you turn off Do Not Disturb')
        });
        radioList.add(this._radioIndefinite);

        // Duration Timer
        let timer = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'gsconnect-dnd-timer'
        });

        let now = GLib.DateTime.new_now_local();
        this.timerLabel = new St.Label({
            text: _('Until %s (%s)').format(
                Util.formatTime(now.add_seconds(this._time)),
                this._getDurationLabel()
            ),
            y_align: Clutter.ActorAlign.CENTER
        });
        timer.add_child(this.timerLabel);

        this._timerRemove = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({icon_name: 'list-remove-symbolic'})
        });
        this._timerRemove.connect('clicked', this._removeTime.bind(this));
        timer.add_child(this._timerRemove);

        this._timerAdd = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({icon_name: 'list-add-symbolic'})
        });
        this._timerAdd.connect('clicked', this._addTime.bind(this));
        timer.add_child(this._timerAdd);

        this._radioDuration = new RadioButton({
            widget: timer,
            group: this._radioIndefinite.group,
            active: true
        });
        radioList.add(this._radioDuration);

        // Dialog Buttons
        this.setButtons([
            {label: _('Cancel'), action: this._cancel.bind(this), default: true},
            {label: _('Done'), action: this._done.bind(this)}
        ]);
    }

    _cancel() {
        gsconnect.settings.reset('donotdisturb');
        this.close();
    }

    _done() {
        let time;

        if (this._radioDuration.active) {
            let now = GLib.DateTime.new_now_local();
            time = now.add_seconds(this._time).to_unix();
        } else {
            time = GLib.MAXINT32;
        }

        gsconnect.settings.set_int('donotdisturb', time);
        this.close();
    }

    _addTime() {
        if (this._time < 60 * 60) {
            this._time += 15 * 60;
        } else {
            this._time += 60 * 60;
        }

        this._setTimeLabel();
    }

    _removeTime() {
        if (this._time <= 60 * 60) {
            this._time -= 15 * 60;
        } else {
            this._time -= 60 * 60;
        }

        this._setTimeLabel();
    }

    _getDurationLabel() {
        if (this._time >= 60 * 60) {
            let hours = this._time / 3600;
            // TRANSLATORS: Time duration in hours (eg. 2 hours)
            return gsconnect.ngettext('%d hour', '%d hours', hours).format(hours);
        } else {
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return gsconnect.ngettext('%d minute', '%d minutes', (this._time / 60)).format(this._time / 60);
        }
    }

    _setTimeLabel() {
        this._timerRemove.reactive = (this._time > 15 * 60);
        this._timerAdd.reactive = (this._time < 12 * 60 * 60);

        let now = GLib.DateTime.new_now_local();

        // TRANSLATORS: Time until change with time duration
        // EXAMPLE: Until 10:00 (2 hours)
        this.timerLabel.text = _('Until %s (%s)').format(
            Util.formatTime(now.add_seconds(this._time)),
            this._getDurationLabel()
        );
    }
};


var MenuItem = class MenuItem extends PopupMenu.PopupSwitchMenuItem {

    constructor() {
        super(_('Do Not Disturb'), false);

        // Update the toggle state when 'paintable'
        this.actor.connect('notify::mapped', () => {
            let now = GLib.DateTime.new_now_local().to_unix();
            this.setToggleState(gsconnect.settings.get_int('donotdisturb') > now);
        });

        this.connect('toggled', (item) => {
            // The state has already been changed when this is emitted
            if (item.state) {
                let dialog = new Dialog();
                dialog.open();
            } else {
                gsconnect.settings.reset('donotdisturb');
            }

            item._getTopMenu().close(true);
        });
    }
};
