'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PopupMenu = imports.ui.popupMenu;

const Tooltip = imports.shell.tooltip;


/**
 * Get a dictionary of a GMenuItem's attributes
 *
 * @param {Gio.MenuModel} model - The menu model containing the item
 * @param {number} index - The index of the item in @model
 * @return {object} - A dictionary of the item's attributes
 */
function getItemInfo(model, index) {
    let info = {
        target: null,
        links: []
    };

    //
    let iter = model.iterate_item_attributes(index);

    while (iter.next()) {
        let name = iter.get_name();
        let value = iter.get_value();

        switch (name) {
            case 'icon':
                info[name] = Gio.Icon.deserialize(value);
                break;

            case 'target':
                info[name] = value;
                break;

            default:
                info[name] = value.unpack();
        }
    }

    // Submenus & Sections
    iter = model.iterate_item_links(index);

    while (iter.next()) {
        info.links.push({
            name: iter.get_name(),
            value: iter.get_value()
        });
    }

    return info;
}


/**
 *
 */
var ListBox = class ListBox extends PopupMenu.PopupMenuSection {

    _init(menu_model, action_group) {
        super._init();

        this.action_group = action_group;
        this.menu_model = menu_model;

        // Setup the menu
        this._onItemsChanged(menu_model, 0, 0, menu_model.get_n_items());
        this.actor.connect('notify::mapped', this._sync.bind(this));
    }

    _sync() {
        if (!this.actor.mapped) {
            return;
        }

        this._onItemsChanged(this.menu_model, 0, 0, this.menu_model.get_n_items());
    }

    _addGMenuItem(info) {
        let item = new PopupMenu.PopupMenuItem(info.label);
        let action_name = info.action.split('.')[1];
        let action_target = info.target;

        item.actor.visible = this.action_group.get_action_enabled(action_name);

        // Replace the usual emblem with the GMenuItem's icon
        if (info.hasOwnProperty('icon')) {
            let icon = new St.Icon({
                gicon: info.icon,
                style_class: 'popup-menu-icon'
            });

            item.actor.replace_child(item.actor.get_child_at_index(0), icon);
            item.actor.get_child_at_index(0).style = 'padding-left: 0.5em';
        }

        // Connect the menu item to it's GAction
        item.connect('activate', (item) => {
            this.action_group.activate_action(action_name, action_target);
        });

        this.addMenuItem(item);
    }

    _addGMenuSection(model) {
        let section = new ListBox(model, this.action_group);
        this.addMenuItem(section);
    }

    _onItemsChanged(model, position, removed, added) {
        this.removeAll();

        let len = model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = getItemInfo(model, i);

            // A regular item
            if (info.hasOwnProperty('label')) {
                this._addGMenuItem(info);
            // Our menus only have sections
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
    GTypeName: 'GSConnectShellGMenuButton'
}, class Button extends St.Button {

    _init(params) {
        super._init({
            style_class: 'system-menu-action gsconnect-device-action',
            can_focus: true
        });
        Object.assign(this, params);

        // Item attributes
        if (params.info.hasOwnProperty('action')) {
            this.action_name = params.info.action.split('.')[1];
        }

        if (params.info.hasOwnProperty('target')) {
            this.action_target = params.info.target;
        }

        if (params.info.hasOwnProperty('label')) {
            this.tooltip = new Tooltip.Tooltip({
                parent: this,
                markup: params.info.label
            });
        }

        if (params.info.hasOwnProperty('icon')) {
            this.child = new St.Icon({ gicon: params.info.icon });
        }

        // Submenu
        for (let link of params.info.links) {
            if (link.name === 'submenu') {
                this.toggle_mode = true;
                this.submenu = new ListBox(link.value, this.action_group);
                this.submenu.actor.style_class = 'popup-sub-menu';
                this.bind_property('checked', this.submenu.actor, 'visible', 2);
                this.connect('notify::checked', this._onChecked);
            }
        }
    }

    _onChecked(button) {
        if (button.checked) {
            button.add_style_pseudo_class('active');
        } else {
            button.remove_style_pseudo_class('active');
        }
    }
});


// FIXME: this needs a flowbox layout
var FlowBox = GObject.registerClass({
    GTypeName: 'GSConnectShellGMenuFlowBox',
}, class FlowBox extends St.BoxLayout {
    _init(params) {
        super._init();
        Object.assign(this, params);

        this._menu_items = new Map();

        // GMenu
        let _itemsChangedId = this.menu_model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );

        // GActions
        let _actionAddedId = this.action_group.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        let _actionEnabledChangedId = this.action_group.connect(
            'action-enabled-changed',
            this._onActionChanged.bind(this)
        );
        let _actionRemovedId = this.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );

        this.connect('destroy', () => {
            params.menu_model.disconnect(_itemsChangedId);
            params.action_group.disconnect(_actionAddedId);
            params.action_group.disconnect(_actionEnabledChangedId);
            params.action_group.disconnect(_actionRemovedId);
        });
        this.connect('notify::mapped', this._onMapped);

        this._onItemsChanged(this.menu_model, 0, 0, this.menu_model.get_n_items());
    }

    _onActionActivated(button) {
        if (button.toggle_mode) {
            for (let child of this.get_children()) {
                if (child !== button) {
                    child.checked = false;
                }
            }
        } else {
            button.root_menu._getTopMenu().close();

            button.action_group.activate_action(
                button.action_name,
                button.action_target
            );
        }
    }

    _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            menuItem.visible = group.get_action_enabled(name);
        }
    }

    _onItemsChanged(model, position, removed, added) {
        while (removed > 0) {
            let button = this.get_child_at_index(position);
            this._menu_items.delete(button.action_name);
            button.destroy();
            removed--;
        }

        for (let i = 0; i < added; i++) {
            let index = position + i;
            let button = new Button({
                action_group: this.action_group,
                info: getItemInfo(model, index),
                root_menu: this.root_menu
            });

            let _clickedId = button.connect('clicked', this._onActionActivated.bind(this));
            button.connect('destroy', () => button.disconnect(_clickedId));

            if (button.action_name) {
                button.visible = this.action_group.get_action_enabled(
                    button.action_name
                );
            }

            if (button.submenu) {
                this.root_menu.addMenuItem(button.submenu);
            }

            this._menu_items.set(button.action_name, button);

            this.insert_child_at_index(button, index);
        }
    }

    _onMapped(actor) {
        if (!actor.mapped) {
            for (let button of actor.get_children()) {
                button.checked = false;
            }
        }
    }
});

