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

    _init(submenu_for, menu_model, action_group) {
        super._init();

        this.submenu_for = submenu_for;
        this.action_group = action_group;
        this.menu_model = menu_model;
        this._menu_items = new Map();

        this._itemsChangedId = this.menu_model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged(menu_model, 0, 0, menu_model.get_n_items());

        // GActions
        this._actionAddedId = this.action_group.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        this._actionEnabledChangedId = this.action_group.connect(
            'action-enabled-changed',
            this._onActionChanged.bind(this)
        );
        this._actionRemovedId = this.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );
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
            this._getTopMenu().close();
        });

        // Add and track the item
        this.addMenuItem(item);
        this._menu_items.set(action_name, item);
    }

    _addGMenuSection(model) {
        let section = new ListBox(this.submenu_for, model, this.action_group);
        this.addMenuItem(section);
    }

    _getTopMenu() {
        return this.submenu_for._getTopMenu();
    }

    _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            if (typeof enabled !== 'boolean') {
                enabled = this.action_group.get_action_enabled(name);
            }

            menuItem.visible = enabled;
        }
    }

    _onItemsChanged(model, position, removed, added) {
        // Using ::items-changed is arduous and probably not worth the trouble
        this._menu_items.clear();
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

    destroy() {
        this.menu_model.disconnect(this._itemsChangedId);
        this.action_group.disconnect(this._actionAddedId);
        this.action_group.disconnect(this._actionEnabledChangedId);
        this.action_group.disconnect(this._actionRemovedId);

        super.destroy();
    }
}


/**
 * A St.Button subclass for icon representations of GMenu items
 */
var Button = GObject.registerClass({
    GTypeName: 'GSConnectShellGMenuButton',
}, class Button extends St.Button {

    _init(params) {
        super._init({
            style_class: 'system-menu-action gsconnect-device-action',
            can_focus: true
        });

        this._action_group = params.action_group;

        // Item attributes
        if (params.info.hasOwnProperty('action')) {
            this._action_name = params.info.action.split('.')[1];
        }

        if (params.info.hasOwnProperty('target')) {
            this._action_target = params.info.target;
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
                this.submenu = new ListBox(this, link.value, this.action_group);
                this.submenu.actor.style_class = 'popup-sub-menu';
                this.submenu.actor.bind_property('mapped', this, 'checked', 0);
            }
        }

        // StButton adds the :checked pseudo class, but some themes don't apply
        // it to .system-menu-action
        this.connect('notify::checked', this._onChecked);
        this.connect('clicked', this._onClicked);
    }

    get action_group() {
        if (this._action_group === undefined) {
            return this.get_parent().action_group;
        }

        return this._action_group;
    }

    get action_name() {
        if (this._action_name === undefined) {
            return null;
        }

        return this._action_name;
    }

    get action_target() {
        if (this._action_target === undefined) {
            return null;
        }

        return this._action_target;
    }

    _getTopMenu() {
        let parent = this.get_parent();

        while (!parent.hasOwnProperty('_delegate')) {
            parent = parent.get_parent();
        }

        return parent._delegate._getTopMenu();
    }

    _onChecked(button) {
        if (button.checked) {
            button.add_style_pseudo_class('active');
        } else {
            button.remove_style_pseudo_class('active');
        }
    }

    _onClicked(button) {
        // If this button has a submenu...
        if (button.submenu !== undefined) {
            // ...remove it (close submenu) if it's already set on the parent
            if (button.get_parent().submenu === button.submenu.actor) {
                button.get_parent().submenu = undefined;
            // ...otherwise add it (open submenu)
            } else {
                button.get_parent().submenu = button.submenu.actor;
            }

        // If this is an actionable item close the top menu and activate
        } else if (button.action_name) {
            button._getTopMenu().close();

            button.action_group.activate_action(
                button.action_name,
                button.action_target
            );
        }
    }

    destroy() {
        if (this.hasOwnProperty('submenu')) {
            this.submenu.destroy();
        }

        super.destroy();
    }
});


// FIXME: this needs a flowbox layout
var FlowBox = GObject.registerClass({
    GTypeName: 'GSConnectShellGMenuFlowBox',
    Properties: {
        'submenu': GObject.ParamSpec.object(
            'submenu',
            'Submenu',
            'The active submenu',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        )
    }
}, class FlowBox extends St.BoxLayout {
    _init(params) {
        super._init();
        Object.assign(this, params);

        this._menu_items = new Map();

        // GMenu
        this._itemsChangedId = this.menu_model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged(this.menu_model, 0, 0, this.menu_model.get_n_items());

        // GActions
        this._actionAddedId = this.action_group.connect(
            'action-added',
            this._onActionChanged.bind(this)
        );
        this._actionEnabledChangedId = this.action_group.connect(
            'action-enabled-changed',
            this._onActionChanged.bind(this)
        );
        this._actionRemovedId = this.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );

        this.connect('destroy', this._onDestroy);
    }

    get submenu() {
        if (this._submenu === undefined) {
            return undefined;
        }

        return this._submenu;
    }

    set submenu(menu) {
        this._submenu = menu;
        this.notify('submenu');
    }

    _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            if (typeof enabled !== 'boolean') {
                enabled = this.action_group.get_action_enabled(name);
            }

            menuItem.visible = enabled;
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
                info: getItemInfo(model, index)
            });

            if (button.action_name) {
                button.visible = this.action_group.get_action_enabled(
                    button.action_name
                );
            }

            this._menu_items.set(button.action_name, button);

            this.insert_child_at_index(button, index);
        }
    }

    _onDestroy(actor) {
        actor.menu_model.disconnect(actor._itemsChangedId);
        actor.action_group.disconnect(actor._actionAddedId);
        actor.action_group.disconnect(actor._actionEnabledChangedId);
        actor.action_group.disconnect(actor._actionRemovedId);
    }
});

