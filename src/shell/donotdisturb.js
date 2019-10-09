'use strict';

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

// eslint-disable-next-line no-redeclare
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


/**
 * Dialog helpers
 */
function _getTimeLabel(time) {
    let now = GLib.DateTime.new_now_local();
    let duration;

    if (time >= 60 * 60) {
        // TRANSLATORS: Time duration in hours (eg. 2 hours)
        duration = gsconnect.ngettext(
            '%d hour',
            '%d hours',
            (time / 3600)
        ).format(time / 3600);
    } else {
        // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
        duration = gsconnect.ngettext(
            '%d minute',
            '%d minutes',
            (time / 60)
        ).format(time / 60);
    }

    // TRANSLATORS: Time until change with time duration
    // EXAMPLE: Until 10:00 (2 hours)
    return _('Until %s (%s)').format(
        Util.formatTime(now.add_seconds(time)),
        duration
    );
}

function _addTime(button) {
    if (this._time < 60 * 60) {
        this._time += 15 * 60;
    } else {
        this._time += 60 * 60;
    }

    // Set the button reactivity
    this._timerRemove.reactive = (this._time > 15 * 60);
    this._timerAdd.reactive = (this._time < 12 * 60 * 60);

    // Update the label
    this.timerLabel.text = _getTimeLabel(this._time);
}

function _removeTime(button) {
    if (this._time <= 60 * 60) {
        this._time -= 15 * 60;
    } else {
        this._time -= 60 * 60;
    }

    // Set the button reactivity
    this._timerRemove.reactive = (this._time > 15 * 60);
    this._timerAdd.reactive = (this._time < 12 * 60 * 60);

    // Update the label
    this.timerLabel.text = _getTimeLabel(this._time);
}

function _resetTime() {
    this.settings.reset('donotdisturb');
    this.close();
}

function _setTime() {
    let time;

    if (this._radioDuration.active) {
        let now = GLib.DateTime.new_now_local();
        time = now.add_seconds(this._time).to_unix();
    } else {
        time = GLib.MAXINT32;
    }

    this.settings.set_int('donotdisturb', time);
    this.close();
}


/**
 * Show a dialog for configuring "Do Not Disturb" timeout.
 *
 * @param {Gio.Settings} settings - The extension settings object
 */
function showDialog(settings) {
    try {
        // Create the dialog
        let dialog = new ModalDialog.ModalDialog({
            styleClass: 'gsconnect-dnd-dialog'
        });

        dialog.contentLayout.style_class = 'nm-dialog-content';
        dialog.settings = settings;

        // 1 hour in seconds
        dialog._time = 1 * 60 * 60;

        // Header
        let headerBox = new St.BoxLayout({
            style_class: 'nm-dialog-header-hbox'
        });
        dialog.contentLayout.add(headerBox);

        let icon = new St.Icon({
            style_class: 'nm-dialog-header-icon',
            gicon: new Gio.ThemedIcon({
                name: 'preferences-system-time-symbolic'
            })
        });
        headerBox.add(icon);

        let titleBox = new St.BoxLayout({vertical: true});
        headerBox.add(titleBox);

        let title = new St.Label({
            style_class: 'nm-dialog-header',
            text: _('Do Not Disturb')
        });
        titleBox.add(title);

        let subtitle = new St.Label({
            style_class: 'nm-dialog-subheader',
            text: _('Silence Notifications from Mobile Devices')
        });
        titleBox.add(subtitle);

        // Content
        let radioList = new St.BoxLayout({
            style_class: 'gsconnect-radio-list',
            vertical: true
        });
        dialog.contentLayout.add(radioList);

        let radioIndefinite = new RadioButton({
            text: _('Until you turn off Do Not Disturb')
        });
        radioList.add(radioIndefinite);

        // Duration Timer
        let timer = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'gsconnect-dnd-timer'
        });

        dialog.timerLabel = new St.Label({
            text: _getTimeLabel(dialog._time),
            y_align: Clutter.ActorAlign.CENTER
        });
        timer.add_child(dialog.timerLabel);

        dialog._timerRemove = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({icon_name: 'list-remove-symbolic'})
        });
        dialog._timerRemove.connect('clicked', _removeTime.bind(dialog));
        timer.add_child(dialog._timerRemove);

        dialog._timerAdd = new St.Button({
            style_class: 'pager-button',
            child: new St.Icon({icon_name: 'list-add-symbolic'})
        });
        dialog._timerAdd.connect('clicked', _addTime.bind(dialog));
        timer.add_child(dialog._timerAdd);

        dialog._radioDuration = new RadioButton({
            widget: timer,
            group: radioIndefinite.group,
            active: true
        });
        radioList.add_child(dialog._radioDuration);

        // Dialog Buttons
        dialog.setButtons([
            {label: _('Cancel'), action: _resetTime.bind(dialog), default: true},
            {label: _('Done'), action: _setTime.bind(dialog)}
        ]);

        dialog.open();
    } catch (e) {
        logError(e);
    }
}


/**
 * Item Helper Functions
 */
function _onItemMapped(actor) {
    try {
        let item = actor._delegate;
        let now = GLib.DateTime.new_now_local().to_unix();
        item.setToggleState(item.settings.get_int('donotdisturb') > now);
    } catch (e) {
        logError(e);
    }
}

function _onItemToggled(item, active) {
    try {
        // The state has already been changed when this is emitted
        if (item.state) {
            showDialog(item.settings);
        } else {
            item.settings.reset('donotdisturb');
        }

        item._getTopMenu().close(true);
    } catch (e) {
        logError(e);
    }
}


function createMenuItem(settings) {
    let item = new PopupMenu.PopupSwitchMenuItem(_('Do Not Disturb'), false, {});
    item.settings = settings;

    item.actor.connect('notify::mapped', _onItemMapped);
    item.connect('toggled', _onItemToggled);

    return item;
}

