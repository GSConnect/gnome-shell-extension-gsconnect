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

    _init(params) {
        super._init();
        Object.assign(this, params);

        // Main Actor
        this.actor = new St.BoxLayout({
            clip_to_allocation: true,
            vertical: false,
            x_expand: true
        });
        this.actor._delegate = this;
        this.actor.add_style_class_name('gsconnect-list-box');

        // Item Box
        this.box.x_expand = true;
        this.box.clip_to_allocation = true;
        this.actor.add_child(this.box);

        // Submenu Container
        this.sub = new St.BoxLayout({
            clip_to_allocation: true,
            style_class: 'popup-sub-menu',
            vertical: false,
            visible: false,
            x_expand: true
        });
        this.actor.add_child(this.sub);

        // HACK: set the submenu visibility after transition
        this.actor.connect('transition-stopped', this._onTransitionStopped);

        // Refresh the menu when mapped
        let _mappedId = this.actor.connect('notify::mapped', (actor) => {
            actor.mapped ? this._onItemsChanged() : undefined;
        });
        this.actor.connect('destroy', (actor) => actor.disconnect(_mappedId));

        // Watch the model for changes
        let _menuId = this.menu_model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this.connect('destroy', () => this.menu_model.disconnect(_menuId));

        this._onItemsChanged();
    }

    _addGMenuItem(info) {
        let action_name = info.action.split('.')[1];
        let action_target = info.target;

        // FIXME: Use an image menu item if there's an icon
        let item = new PopupMenu.PopupMenuItem(info.label);

        item.actor.visible = this.action_group.get_action_enabled(action_name);

        this.addMenuItem(item);

        // Connect the menu item to it's GAction
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

    _addGMenuSubmenu(model, title='') {
        let submenu = new ListBox({
            menu_model: model,
            action_group: this.action_group,
            submenu_for: title,
            _parent: this
        });

        // Set the submenu as hidden
        submenu.actor.visible = false;

        this.sub.add_child(submenu.actor);

        return submenu;
    }

    _onItemsChanged(model, position, removed, added) {
        // Clear the menu
        this.box.get_children().map(child => child.destroy());
        this.sub.get_children().map(child => child.destroy());

        let len = this.menu_model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = getItemInfo(this.menu_model, i);
            let item;

            // A regular item
            if (info.hasOwnProperty('label')) {
                item = this._addGMenuItem(info);
            }

            for (let link of info.links) {
                // Submenu
                if (link.name === 'submenu') {
                    let arrow = PopupMenu.arrowIcon(St.Side.RIGHT);
                    arrow.x_align = Clutter.ActorAlign.END;
                    arrow.x_expand = true;
                    item.actor.add_child(arrow);
                    item.submenu = this._addGMenuSubmenu(link.value, info.label);

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

        if (this.submenu_for) {
            let prev = new PopupMenu.PopupMenuItem(this.submenu_for);
            this.addMenuItem(prev, 0);

            // Make the title bold and replace the ornament with an arrow
            prev.label.style = 'font-weight: bold;';
            prev._ornamentLabel.text = '\u25C2';

            // Adjust the signal
            prev.disconnect(prev._activateId);

            prev._activateId = prev.connect('activate', (item, event) => {
                this.emit('activate', item);
                this._parent.submenu = null;
                this._parent.sub.get_children().map(menu => menu.visible = false);
            });
        }
    }

    _onTransitionStopped(actor, name, is_finished) {
        let menu = actor._delegate;
        actor.visible = menu.revealed;

        menu.box.visible = !(menu.submenu);
        menu.sub.visible = (menu.submenu);

        if (!menu.submenu) {
            menu.sub.get_children().map(child => child.visible = false);
        }
    }

    get revealed() {
        return this._revealed || false;
    }

    set revealed(bool) {
        if (bool === this.revealed) {
            return;
        }

        // Setup the animation
        this.actor.save_easing_state();
        this.actor.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.actor.set_easing_duration(250);

        // Expand or shrink the menu
        this.actor.set_height(bool ? -1 : 0);
        bool ? this.actor.show() : null;

        // Reset the animation and emit ::open-state-changed
        this.actor.restore_easing_state();
        bool ? this.open() : this.close();

        //
        this._revealed = bool;
    }

    get submenu() {
        if (this._submenu === undefined) {
            this._submenu = null;
        }

        return this._submenu;
    }

    set submenu(submenu) {
        let alloc = this.actor.get_allocation_box();
        let width = alloc.x2 - alloc.x1;

        // Setup the animation
        this.box.save_easing_state();
        this.box.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.box.set_easing_duration(250);

        this.sub.save_easing_state();
        this.sub.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.sub.set_easing_duration(250);

        if (submenu === null) {
            this.box.set_width(width);
            this.box.show();

            this.sub.set_width(0);
        } else {
            submenu.actor.show();

            this.sub.set_width(width);
            this.sub.show();

            this.box.set_width(0);
        }

        // Reset the animation
        this.sub.restore_easing_state();
        this.box.restore_easing_state();

        //
        this._submenu = submenu;
    }

    close() {
        this.emit('open-state-changed', false);
        this._submenu = null;
        this.sub.width = 0;
        this.sub.visible = false;
        this.sub.get_children().map(menu => menu.visible = false);
    }

    open() {
        this.emit('open-state-changed', true);
    }
}


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
            this.child = new St.Icon({ gicon: params.info.icon });
        }

        // Submenu
        for (let link of params.info.links) {
            if (link.name === 'submenu') {
                this.toggle_mode = true;
                this.submenu = new ListBox({
                    menu_model: link.value,
                    action_group: this.action_group
                });
                this.submenu.actor.height = 0;
                this.submenu.actor.visible = false;
                this.submenu.actor.style_class = 'popup-sub-menu';
                this.connect('notify::checked', this._onChecked);
            }
        }

        this.connect('clicked', this._onClicked);
    }

    _onChecked(button) {
        if (button.checked) {
            button.add_style_pseudo_class('active');
            button.submenu.revealed = true;
        } else {
            button.remove_style_pseudo_class('active');
            button.submenu.revealed = false;
        }
    }

    _onClicked(button) {
        let box = button.get_parent();

        if (button.toggle_mode) {
            for (let child of box.get_children()) {
                child.checked = (child === button) ? child.checked : false;
            }
        } else {
            box._delegate._getTopMenu().close();

            button.action_group.activate_action(
                button.action_name,
                button.action_target
            );
        }
    }
});


var IconBox = class ListBox extends PopupMenu.PopupMenuSection {

    _init(params) {
        super._init();
        Object.assign(this, params);

        this.box.add_style_class_name('gsconnect-icon-box');
        this.box.vertical = false;

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

        this.connect('destroy', (iconbox) => {
            this.menu_model.disconnect(_itemsChangedId);
            this.action_group.disconnect(_actionAddedId);
            this.action_group.disconnect(_actionEnabledChangedId);
            this.action_group.disconnect(_actionRemovedId);
        });
        this.box.connect('notify::mapped', this._onMapped);
    }

    _setParent(parent) {
        super._setParent(parent);
        this._onItemsChanged(this.menu_model, 0, 0, this.menu_model.get_n_items());
    }

    isEmpty() {
        return (this.box.get_children().length === 0);
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
                info: getItemInfo(model, index)
            });

            // Set the visibility based on the enabled state
            button.visible = this.action_group.get_action_enabled(
                button.action_name
            );

            // If it has a submenu, add it as a sibling
            if (button.submenu) {
                this._parent.addMenuItem(button.submenu);
            }

            // Track the item
            this._menu_items.set(button.action_name, button);

            // Insert it in the box at the defined position
            this.box.insert_child_at_index(button, index);
        }
    }

    _onMapped(actor) {
        if (!actor.mapped) {
            actor.get_children().map(button => button.checked = false);
        }
    }
}

