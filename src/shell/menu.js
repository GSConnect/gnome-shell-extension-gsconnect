'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PopupMenu = imports.ui.popupMenu;

imports.searchPath.push('.');
const Tooltip = imports.shell.tooltip;


/**
 * GMenu helper classes
 */
class ItemInfo {
    constructor(model, index) {
        this.model = model;
        this.index = index;
        this.links = [];

        //
        let iter = this.model.iterate_item_attributes(this.index);

        while (iter.next()) {
            let name = iter.get_name();
            let value = iter.get_value();

            switch (name) {
                case 'icon':
                    this[name] = Gio.Icon.deserialize(value);
                    break;
                case 'target':
                    this[name] = value;
                    break;
                default:
                    this[name] = value.unpack();
            }
        }

        //
        iter = this.model.iterate_item_links(this.index);

        while (iter.next()) {
            this.links.push({
                name: iter.get_name(),
                value: iter.get_value()
            });
        }
    }
}


var ModelMenuItem = class ModelMenuItem extends PopupMenu.PopupMenuItem {
    _init(info, actions) {
        super._init(info.label);

        if (info.hasOwnProperty('icon')) {
            let icon = new St.Icon({
                gicon: info.icon,
                style_class: 'popup-menu-icon'
            });

            let emblem = this.actor.get_child_at_index(0);
            this.actor.replace_child(emblem, icon);
        }

        this.actor.get_child_at_index(0).style = 'padding-left: 0.5em';
    }
}


var MenuListBox = class MenuListBox extends PopupMenu.PopupMenuSection {

    _init(parentActor, model, gactions) {
        super._init();
        this.actor.style_class = 'popup-sub-menu';

        this.parentActor = parentActor;

        this._gactions = gactions;
        this._model = model;
        this._model.connect('items-changed', this._onItemsChanged.bind(this));
        this._onItemsChanged(model, 0, 0, model.get_n_items());
    }

    _addModelItem(info) {
        let menuItem = new ModelMenuItem(info, this._gactions);

        menuItem.connect('activate', (item) => {
            this._gactions.activate_action(
                info.action.split('.')[1],
                (info.target === undefined) ? null : info.target
            );

            // The signal chain here is embarassing
            this.parentActor.emit('submenu-toggle');
        });

        this.addMenuItem(menuItem);
    }

    _onItemsChanged(model, position, removed, added) {
        debug(`(${position}, ${removed}, ${added})`);

        this.removeAll();

        let len = model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = new ItemInfo(model, i);
            log('item: ' + JSON.stringify(gsconnect.full_unpack(info)));

            // FIXME: better section/submenu detection
            if (info.hasOwnProperty('label')) {
                this._addModelItem(info);
            } else {
                this._addModelSection(info.links[0].value);

                // FIXME
                if (i + 1 <= len) {
                    let sep = new PopupMenu.PopupSeparatorMenuItem();
                    this.addMenuItem(sep);
                }
            }
        }
    }

    _addModelSection(model) {
        model.connect('items-changed', this._onSectionItemsChanged.bind(this));
        this._onItemsChanged(model, 0, 0, model.get_n_items());
    }

    _onSectionItemsChanged(model, position, removed, added) {
        debug(`(${position}, ${removed}, ${added})`);

        let len = model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = new ItemInfo(model, i);
            this._addModelItem(info);
        }
    }
}


var Button = GObject.registerClass({
    GTypeName: 'GSConnectShellMenuButton',
    Signals: {
        'submenu-toggle': {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    }
}, class Button extends St.Button {

    _init(params) {
        super._init({
            style_class: 'system-menu-action gsconnect-menu-button',
            can_focus: true
        });

        // StButton adds the :checked pseudo class, but some themes don't apply
        // it to .system-menu-action
        this.connect('notify::checked', (button) => {
            if (button.checked) {
                this.add_style_pseudo_class('active');
            } else {
                this.remove_style_pseudo_class('active');
            }
        });

        this._gactions = params.gactions;
        this._info = params.info;

        // GIcon
        if (this._info.hasOwnProperty('icon')) {
            this.child = new St.Icon({ gicon: this._info.icon });
        } else {
            this.child = new St.Icon({
                gicon: new Gio.ThemedIcon({
                    name: 'application-x-addon-symbolic'
                })
            });
        }

        // Action
        if (this._info.hasOwnProperty('action')) {
            this._action = this._info.action.split('.')[1];

            this.connect('clicked', this.activate.bind(this));
            this.visible = this._gactions.get_action_enabled(this._action);
        }

        // Label
        if (this._info.hasOwnProperty('label')) {
            this.tooltip = new Tooltip.Tooltip({
                parent: this,
                markup: this._info.label
            });
        }

        // Submenu
        this.submenu = null;

        for (let link of this._info.links) {
            debug('link: ' + JSON.stringify(link));

            if (link.name === 'submenu') {
                this.submenu = new MenuListBox(this, link.value, this._gactions);
                this.toggle_mode = true;
                this.submenu.actor.bind_property(
                    'mapped',
                    this,
                    'checked',
                    GObject.BindingFlags.SYNC_CREATE
                );
                this.connect('clicked', () => this.emit('submenu-toggle'));
                this.connect('destroy', () => this.submenu.destroy());
            }
        }

        // TODO: this is kind of pointless due to the hack in IconFlowBox
//        this._gactions.connect('action-enabled-changed', (group, name, enabled) => {
//            log('action-enabled-changed: ' + name);
//            if (name === this._action) {
//                this.visible = enabled;
//            }
//        });
    }

    update() {
        if (this._action) {
            this.visible = this._gactions.get_action_enabled(this._action);
        }
    }

    activate() {
        this._gactions.activate_action(this._action, null);
    }
});


// FIXME: this needs to be a flowbox now
var IconFlowBox = GObject.registerClass({
    GTypeName: 'GSConnectIconFlowBox',
    Signals: {
        'submenu-toggle': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class IconFlowBox extends St.BoxLayout {
    _init(model, gactions) {
        super._init({ style_class: 'gsconnect-plugin-bar' });

        this._gactions = gactions;
        this._model = model;
        this._itemsChangedId = this._model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged(this._model, 0, 0, this._model.get_n_items());

        // HACK: It would be great not to have to do this, but GDBusActionGroup
        // often seems to not be ready when the buttons are created
        this.connect('notify::mapped', (actor) => {
            if (actor.mapped) {
                actor.get_children().map(child => child.update());
            }
        });

        this.connect('destroy', (flowbox) => {
            flowbox._model.disconnect(this._itemsChangedId);
        });
    }

    _onItemsChanged(model, position, removed, added) {
        debug(`(${position}, ${removed}, ${added})`);

        while (removed > 0) {
            this.get_child_at_index(position).destroy();
            removed--;
        }

        for (let i = 0; i < added; i++) {
            let index = position + i;
            let button = new Button({
                gactions: this._gactions,
                info: new ItemInfo(model, index)
            });
            button.connect('submenu-toggle', this._toggleList.bind(this));

            this.insert_child_at_index(button, index);
        }
    }

    _toggleList(button) {
        this.emit('submenu-toggle', button);
    }
});

