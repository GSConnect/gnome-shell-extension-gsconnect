'use strict';

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
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
                value = Gio.Icon.deserialize(value);

                if (value instanceof Gio.ThemedIcon)
                    value = gsconnect.get_gicon(value.names[0]);

                info[name] = value;
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

    constructor(params) {
        super();
        Object.assign(this, params);

        // Main Actor
        this.actor = new St.BoxLayout({
            x_expand: true
        });
        this.actor._delegate = this;

        // Item Box
        this.box.clip_to_allocation = true;
        this.box.x_expand = true;
        this.box.add_style_class_name('gsconnect-list-box');
        this.box.connect('transitions-completed', this._onTransitionsCompleted);
        this.actor.add_child(this.box);

        // Submenu Container
        this.sub = new St.BoxLayout({
            clip_to_allocation: true,
            style_class: 'popup-sub-menu',
            vertical: false,
            visible: false,
            x_expand: true
        });
        this.sub.connect('key-press-event', this._onSubmenuCloseKey);
        this.sub.connect('transitions-completed', this._onTransitionsCompleted);
        this.sub._delegate = this;
        this.actor.add_child(this.sub);

        // Refresh the menu when mapped
        let _mappedId = this.actor.connect(
            'notify::mapped',
            this._onMapped.bind(this)
        );
        this.actor.connect('destroy', (actor) => actor.disconnect(_mappedId));

        // Watch the model for changes
        let _menuId = this.menu_model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this.connect('destroy', (menu) => menu.menu_model.disconnect(_menuId));

        this._onItemsChanged();
    }

    _onMapped(actor) {
        if (actor.mapped) {
            this._onItemsChanged();

        // We use this instead of close() to avoid touching finalized objects
        } else {
            this.box.show();
            this.box.set_width(-1);

            this._submenu = null;
            this.sub.hide();
            this.sub.set_width(-1);
            this.sub.get_children().map(menu => menu.hide());
        }
    }

    _onSubmenuCloseKey(actor, event) {
        let menu = actor.get_parent()._delegate;

        if (menu.submenu && event.get_key_symbol() == Clutter.KEY_Left) {
            menu.submenu.submenu_for.setActive(true);
            menu.submenu = null;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onSubmenuOpenKey(actor, event) {
        let item = actor._delegate;

        if (item.submenu && event.get_key_symbol() == Clutter.KEY_Right) {
            this.submenu = item.submenu;
            item.submenu.firstMenuItem.setActive(true);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _addGMenuItem(info) {
        let action_name = info.action.split('.')[1];
        let action_target = info.target;

        // TODO: Use an image menu item if there's an icon?
        let item = new PopupMenu.PopupMenuItem(info.label);
        item.actor.visible = this.action_group.get_action_enabled(action_name);
        this.addMenuItem(item);

        // Modify the ::activate callback to invoke the GAction or submenu
        item.disconnect(item._activateId);

        item._activateId = item.connect('activate', (item, event) => {
            this.emit('activate', item);

            if (item.submenu) {
                this.submenu = item.submenu;
            } else {
                this.action_group.activate_action(action_name, action_target);
                this.itemActivated();
            }
        });

        return item;
    }

    _addGMenuSection(model) {
        let section = new ListBox({
            menu_model: model,
            action_group: this.action_group
        });
        this.addMenuItem(section);
    }

    _addGMenuSubmenu(model, item) {
        // Add an expander arrow to the item
        let arrow = PopupMenu.arrowIcon(St.Side.RIGHT);
        arrow.x_align = Clutter.ActorAlign.END;
        arrow.x_expand = true;
        item.actor.add_child(arrow);

        // Mark it as an expandable and open on right-arrow
        item.actor.add_accessible_state(Atk.StateType.EXPANDABLE);

        item.actor.connect(
            'key-press-event',
            this._onSubmenuOpenKey.bind(this)
        );

        // Create the submenu
        item.submenu = new ListBox({
            menu_model: model,
            action_group: this.action_group,
            submenu_for: item,
            _parent: this
        });
        item.submenu.actor.hide();

        // Add to the submenu container
        this.sub.add_child(item.submenu.actor);
    }

    _onItemsChanged(model, position, removed, added) {
        // Clear the menu
        this.removeAll();
        this.sub.get_children().map(child => child.destroy());


        for (let i = 0, len = this.menu_model.get_n_items(); i < len; i++) {
            let info = getItemInfo(this.menu_model, i);
            let item;

            // A regular item
            if (info.hasOwnProperty('label')) {
                item = this._addGMenuItem(info);
            }

            for (let link of info.links) {
                // Submenu
                if (link.name === 'submenu') {
                    this._addGMenuSubmenu(link.value, item);

                // Section
                } else if (link.name === 'section') {
                    this._addGMenuSection(link.value);

                    // len is length starting at 1
                    if (i + 1 < len) {
                        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    }
                }
            }
        }

        // If this is a submenu of another item, prepend a "go back" item
        if (this.submenu_for) {
            let prev = new PopupMenu.PopupMenuItem(this.submenu_for.label.text);
            this.addMenuItem(prev, 0);

            // Make the title bold and replace the ornament with an arrow
            prev.label.style = 'font-weight: bold;';
            prev._ornamentLabel.text = '\u25C2';

            // Modify the ::activate callback to close the submenu
            prev.disconnect(prev._activateId);

            prev._activateId = prev.connect('activate', (item, event) => {
                this.emit('activate', item);
                this._parent.submenu = null;
            });
        }
    }

    _onTransitionsCompleted(actor) {
        let menu = actor.get_parent()._delegate;

        if (menu.submenu) {
            menu.box.hide();
            menu.box.set_width(0);
        } else {
            menu.sub.hide();
            menu.sub.set_width(0);
            menu.sub.get_children().map(menu => menu.hide());
        }
    }

    get submenu() {
        return this._submenu || null;
    }

    set submenu(submenu) {
        let allocWidth = this.actor.allocation.x2 - this.actor.allocation.x1;

        // Setup the animation
        this.box.save_easing_state();
        this.box.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.box.set_easing_duration(250);

        this.sub.save_easing_state();
        this.sub.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.sub.set_easing_duration(250);

        if (submenu) {
            submenu.actor.show();

            this.sub.set_width(allocWidth);
            this.sub.show();
            this.box.set_width(0);
        } else {
            this.box.set_width(allocWidth);
            this.box.show();
            this.sub.set_width(0);
        }

        // Reset the animation
        this.box.restore_easing_state();
        this.sub.restore_easing_state();

        //
        this._submenu = submenu;
    }
};


/**
 * A St.Button subclass for iconic GMenu items
 */
var IconButton = GObject.registerClass({
    GTypeName: 'GSConnectShellIconButton'
}, class Button extends St.Button {

    _init(params) {
        super._init({
            style_class: 'system-menu-action gsconnect-icon-button',
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
            this.child = new St.Icon({gicon: params.info.icon});
        }

        // Submenu
        for (let link of params.info.links) {
            if (link.name === 'submenu') {
                this.add_accessible_state(Atk.StateType.EXPANDABLE);
                this.toggle_mode = true;
                this.connect('notify::checked', this._onChecked);

                this.submenu = new ListBox({
                    menu_model: link.value,
                    action_group: this.action_group
                });

                this.submenu.actor.style_class = 'popup-sub-menu';
                this.submenu.actor.visible = false;
            }
        }

        this.connect('clicked', this._onClicked);
    }

    // This is (reliably?) emitted before ::clicked
    _onChecked(button) {
        if (button.checked) {
            button.add_accessible_state(Atk.StateType.EXPANDED);
            button.add_style_pseudo_class('active');
        } else {
            button.remove_accessible_state(Atk.StateType.EXPANDED);
            button.remove_style_pseudo_class('active');
        }
    }

    // This is (reliably?) emitted after notify::checked
    _onClicked(button, clicked_button) {
        // Unless this has submenu activate the action and close
        if (!button.toggle_mode) {
            button._parent._getTopMenu().close();

            button.action_group.activate_action(
                button.action_name,
                button.action_target
            );

        // StButton.checked has already been toggled so we're opening
        } else if (button.checked) {
            button._parent.submenu = button.submenu;

        // If this is the active submenu being closed, animate-close it
        } else if (button._parent.submenu === button.submenu) {
            button._parent.submenu = null;
        }
    }
});


var IconBox = class IconBox extends PopupMenu.PopupMenuSection {

    constructor(params) {
        super();
        Object.assign(this, params);

        // Main Actor
        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true
        });
        this.actor.connect('notify::mapped', this._onMapped);
        this.actor._delegate = this;

        // Button Box
        this.box._delegate = this;
        this.box.style_class = 'gsconnect-icon-box';
        this.box.vertical = false;
        this.actor.add_child(this.box);

        // Submenu Container
        this.sub = new St.BoxLayout({
            clip_to_allocation: true,
            style_class: 'popup-sub-menu',
            vertical: true,
            x_expand: true
        });
        this.sub.connect('transitions-completed', this._onTransitionsCompleted);
        this.sub._delegate = this;
        this.actor.add_child(this.sub);

        // Track menu items so we can use ::items-changed
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

        this.connect('destroy', (actor) => {
            actor.menu_model.disconnect(_itemsChangedId);
            actor.action_group.disconnect(_actionAddedId);
            actor.action_group.disconnect(_actionEnabledChangedId);
            actor.action_group.disconnect(_actionRemovedId);
        });
    }

    get submenu() {
        return this._submenu || null;
    }

    set submenu(submenu) {
        if (submenu) {
            this.box.get_children().map(button => {
                if (button.submenu && this._submenu && button.submenu !== submenu) {
                    button.checked = false;
                    button.submenu.actor.hide();
                }
            });

            this.sub.set_height(0);
            submenu.actor.show();
        }

        this.sub.save_easing_state();
        this.sub.set_easing_duration(250);
        this.sub.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);

        this.sub.set_height(submenu ? -1 : 0);
        this.sub.restore_easing_state();

        this._submenu = submenu;
    }

    _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            menuItem.visible = group.get_action_enabled(name);
        }
    }

    _onItemsChanged(model, position, removed, added) {
        // Remove items
        while (removed > 0) {
            let button = this.box.get_child_at_index(position);
            (button.submenu) ? button.submenu.destroy() : null;
            button.destroy();

            this._menu_items.delete(button.action_name);
            removed--;
        }

        // Add items
        for (let i = 0; i < added; i++) {
            let index = position + i;

            // Create an iconic button
            let button = new IconButton({
                action_group: this.action_group,
                info: getItemInfo(model, index),
                // TODO: Because this doesn't derive from a PopupMenu class
                //       it lacks some things its parent will expect from it
                _parent: this,
                _delegate: null
            });

            // Set the visibility based on the enabled state
            button.visible = this.action_group.get_action_enabled(
                button.action_name
            );

            // If it has a submenu, add it as a sibling
            if (button.submenu) {
                this.sub.add_child(button.submenu.actor);
            }

            // Track the item
            this._menu_items.set(button.action_name, button);

            // Insert it in the box at the defined position
            this.box.insert_child_at_index(button, index);
        }
    }

    _onMapped(actor) {
        // Close everything down manually when unmapped
        if (!actor.mapped) {
            let menu = actor._delegate;
            menu._submenu = null;
            menu.box.get_children().map(button => button.checked = false);
            menu.sub.get_children().map(submenu => submenu.hide());
        }
    }

    _onTransitionsCompleted(actor) {
        let menu = actor._delegate;

        menu.box.get_children().map(button => {
            if (button.submenu && button.submenu !== menu.submenu) {
                button.checked = false;
                button.submenu.actor.hide();
            }
        });
    }

    // PopupMenu.PopupMenuBase overrides
    isEmpty() {
        return (this.box.get_children().length === 0);
    }

    _setParent(parent) {
        super._setParent(parent);
        this._onItemsChanged(this.menu_model, 0, 0, this.menu_model.get_n_items());
    }
};

