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


/**
 * A PopupMenuItem subclass for GMenu items
 * TODO: GActions?
 */
var ListBoxItem = class ListBoxItem extends PopupMenu.PopupMenuItem {
    _init(info, actions) {
        super._init(info.label);

        if (info.hasOwnProperty('icon')) {
            let icon = new St.Icon({
                gicon: info.icon,
                style_class: 'popup-menu-icon'
            });

            // Replace the usual emblem child with the icon
            this.actor.replace_child(this.actor.get_child_at_index(0), icon);
        }

        // TODO: maybe do this is stylesheet.css
        this.actor.get_child_at_index(0).style = 'padding-left: 0.5em';
    }
}


/**
 *
 */
var ListBox = class ListBox extends PopupMenu.PopupMenuSection {

    _init(parentActor, model, gactions) {
        super._init();

        this.parentActor = parentActor;
        this._gactions = gactions;
        this._gmenu = model;

        this._itemsChangedId = this._gmenu.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged(model, 0, 0, model.get_n_items());

        this.connect('destroy', (listbox) => {
            listbox._gmenu.disconnect(listbox._itemsChangedId);
        });
    }

    _addGMenuItem(info) {
        let menuItem = new ListBoxItem(info, this._gactions);

        menuItem.connect('activate', (item) => {
            this._gactions.activate_action(
                info.action.split('.')[1],
                (info.target === undefined) ? null : info.target
            );

            this.parentActor.emit('submenu-toggle');
        });

        this.addMenuItem(menuItem);
    }

    _addGMenuSection(model) {
        let section = new ListBox(this.parentActor, model, this._gactions);
        this.addMenuItem(section);
    }

    _addGMenuSubmenu(model) {
    }

    _onItemsChanged(model, position, removed, added) {
        // Using ::items-changed is arduous and probably not worth the trouble
        this.removeAll();

        let len = model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = new ItemInfo(model, i);

            // A regular item
            if (info.hasOwnProperty('label')) {
                this._addGMenuItem(info);
            // A section or submenu
            } else {
                this._addGMenuSection(info.links[0].value);

                // len is length starting at 1
                if (i + 1 < len) {
                    this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                }
            }
        }
    }
}


/**
 * A St.Button subclass for icon representations of GMenu items
 */
var Button = GObject.registerClass({
    GTypeName: 'GSConnectShellGMenuButton',
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

        this._gactions = params.gactions;
        this._info = params.info;

        // StButton adds the :checked pseudo class, but some themes don't apply
        // it to .system-menu-action
        this.connect('notify::checked', (button) => {
            if (button.checked) {
                button.add_style_pseudo_class('active');
            } else {
                button.remove_style_pseudo_class('active');
            }
        });

        this.connect('clicked', this._onClicked.bind(this));

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
            this._actionName = this._info.action.split('.')[1];
            this.visible = this._gactions.get_action_enabled(this._actionName);
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
                this.submenu = new ListBox(this, link.value, this._gactions);
                this.submenu.actor.style_class = 'popup-sub-menu';
                this.toggle_mode = true;
                this.submenu.actor.bind_property(
                    'mapped',
                    this,
                    'checked',
                    GObject.BindingFlags.SYNC_CREATE
                );
            }
        }

        this._actionEnabledId = this._gactions.connect(
            'action-enabled-changed',
            this._onActionChanged.bind(this)
        );
        this._actionAddedId = this._gactions.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        this._actionRemovedId = this._gactions.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );

        this.connect('destroy', (button) => {
            button._gactions.disconnect(button._actionEnabledId);
            button._gactions.disconnect(button._actionAddedId);
            button._gactions.disconnect(button._actionRemovedId);

            if (button.submenu !== null) {
                button.submenu.destroy();
            }
        });
    }

    _onActionChanged(group, name, enabled) {
        if (name === this._actionName) {
            if (enabled === undefined) {
                enabled = this._gactions.get_action_enabled(name);
            }

            this.visible = enabled;
        }
    }

    // TODO: fix super ugly delegation chain
    _onClicked(button) {
        // If this is an actionable item...
        if (this._actionName !== undefined) {
            // ...close the top menu
            let parent = button.get_parent();

            while (!parent.hasOwnProperty('_delegate')) {
                parent = parent.get_parent();
            }

            parent._delegate._getTopMenu().close();

            // ...then activate the action
            button._gactions.activate_action(button._actionName, null);
        } else if (this.submenu !== null) {
            this.emit('submenu-toggle');
        }
    }
});


// FIXME: this needs a flowbox layout
var FlowBox = GObject.registerClass({
    GTypeName: 'GSConnectShellGMenuFlowBox',
    Signals: {
        'submenu-toggle': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_OBJECT ]
        }
    }
}, class FlowBox extends St.BoxLayout {
    _init(model, gactions) {
        super._init({ style_class: 'gsconnect-plugin-bar' });

        this._gactions = gactions;
        this._gmenu = model;
        this._itemsChangedId = this._gmenu.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged(this._gmenu, 0, 0, this._gmenu.get_n_items());

        this.connect('destroy', (flowbox) => {
            flowbox._gmenu.disconnect(this._itemsChangedId);
        });
    }

    _onItemsChanged(model, position, removed, added) {
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

