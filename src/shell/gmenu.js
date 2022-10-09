'use strict';

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PopupMenu = imports.ui.popupMenu;

const Extension = imports.misc.extensionUtils.getCurrentExtension();

const Tooltip = Extension.imports.shell.tooltip;


/**
 * Get a dictionary of a GMenuItem's attributes
 *
 * @param {Gio.MenuModel} model - The menu model containing the item
 * @param {number} index - The index of the item in @model
 * @return {Object} A dictionary of the item's attributes
 */
function getItemInfo(model, index) {
    const info = {
        target: null,
        links: [],
    };

    //
    let iter = model.iterate_item_attributes(index);

    while (iter.next()) {
        const name = iter.get_name();
        let value = iter.get_value();

        switch (name) {
            case 'icon':
                value = Gio.Icon.deserialize(value);

                if (value instanceof Gio.ThemedIcon)
                    value = Extension.getIcon(value.names[0]);

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
            value: iter.get_value(),
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
            x_expand: true,
            clip_to_allocation: true,
        });
        this.actor._delegate = this;

        // Item Box
        this.box.clip_to_allocation = true;
        this.box.x_expand = true;
        this.box.add_style_class_name('gsconnect-list-box');
        this.box.set_pivot_point(1, 1);
        this.actor.add_child(this.box);

        // Submenu Container
        this.sub = new St.BoxLayout({
            clip_to_allocation: true,
            vertical: false,
            visible: false,
            x_expand: true,
        });
        this.sub.set_pivot_point(1, 1);
        this.sub._delegate = this;
        this.actor.add_child(this.sub);

        // Handle transitions
        this._boxTransitionsCompletedId = this.box.connect(
            'transitions-completed',
            this._onTransitionsCompleted.bind(this)
        );

        this._subTransitionsCompletedId = this.sub.connect(
            'transitions-completed',
            this._onTransitionsCompleted.bind(this)
        );

        // Handle keyboard navigation
        this._submenuCloseKeyId = this.sub.connect(
            'key-press-event',
            this._onSubmenuCloseKey.bind(this)
        );

        // Refresh the menu when mapped
        this._mappedId = this.actor.connect(
            'notify::mapped',
            this._onMapped.bind(this)
        );

        // Watch the model for changes
        this._itemsChangedId = this.model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );
        this._onItemsChanged();
    }

    _onMapped(actor) {
        if (actor.mapped) {
            this._onItemsChanged();

        // We use this instead of close() to avoid touching finalized objects
        } else {
            this.box.set_opacity(255);
            this.box.set_width(-1);
            this.box.set_height(-1);
            this.box.visible = true;

            this._submenu = null;
            this.sub.set_opacity(0);
            this.sub.set_width(0);
            this.sub.set_height(0);
            this.sub.visible = false;
            this.sub.get_children().map(menu => menu.hide());
        }
    }

    _onSubmenuCloseKey(actor, event) {
        if (this.submenu && event.get_key_symbol() === Clutter.KEY_Left) {
            this.submenu.submenu_for.setActive(true);
            this.submenu = null;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onSubmenuOpenKey(actor, event) {
        const item = actor._delegate;

        if (item.submenu && event.get_key_symbol() === Clutter.KEY_Right) {
            this.submenu = item.submenu;
            item.submenu.firstMenuItem.setActive(true);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onGMenuItemActivate(item, event) {
        this.emit('activate', item);

        if (item.submenu) {
            this.submenu = item.submenu;
        } else if (item.action_name) {
            this.action_group.activate_action(
                item.action_name,
                item.action_target
            );
            this.itemActivated();
        }
    }

    _addGMenuItem(info) {
        const item = new PopupMenu.PopupMenuItem(info.label);
        this.addMenuItem(item);

        if (info.action !== undefined) {
            item.action_name = info.action.split('.')[1];
            item.action_target = info.target;

            item.actor.visible = this.action_group.get_action_enabled(
                item.action_name
            );
        }

        item.connectObject(
            'activate',
            this._onGMenuItemActivate.bind(this),
            this
        );

        return item;
    }

    _addGMenuSection(model) {
        const section = new ListBox({
            model: model,
            action_group: this.action_group,
        });
        this.addMenuItem(section);
    }

    _addGMenuSubmenu(model, item) {
        // Add an expander arrow to the item
        const arrow = PopupMenu.arrowIcon(St.Side.RIGHT);
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
            model: model,
            action_group: this.action_group,
            submenu_for: item,
            _parent: this,
        });
        item.submenu.actor.hide();

        // Add to the submenu container
        this.sub.add_child(item.submenu.actor);
    }

    _onItemsChanged(model, position, removed, added) {
        // Clear the menu
        this.removeAll();
        this.sub.get_children().map(child => child.destroy());

        for (let i = 0, len = this.model.get_n_items(); i < len; i++) {
            const info = getItemInfo(this.model, i);
            let item;

            // A regular item
            if (info.hasOwnProperty('label'))
                item = this._addGMenuItem(info);

            for (const link of info.links) {
                // Submenu
                if (link.name === 'submenu') {
                    this._addGMenuSubmenu(link.value, item);

                // Section
                } else if (link.name === 'section') {
                    this._addGMenuSection(link.value);

                    // len is length starting at 1
                    if (i + 1 < len)
                        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                }
            }
        }

        // If this is a submenu of another item...
        if (this.submenu_for) {
            // Prepend an "<= Go Back" item, bold with a unicode arrow
            const prev = new PopupMenu.PopupMenuItem(this.submenu_for.label.text);
            prev.label.style = 'font-weight: bold;';
            const prevArrow = PopupMenu.arrowIcon(St.Side.LEFT);
            prev.replace_child(prev._ornamentLabel, prevArrow);
            this.addMenuItem(prev, 0);

            prev.connectObject('activate', (item, event) => {
                this.emit('activate', item);
                this._parent.submenu = null;
            }, this);
        }
    }

    _onTransitionsCompleted(actor) {
        if (this.submenu) {
            this.box.visible = false;
        } else {
            this.sub.visible = false;
            this.sub.get_children().map(menu => menu.hide());
        }
    }

    get submenu() {
        return this._submenu || null;
    }

    set submenu(submenu) {
        // Get the current allocation to hold the menu width
        const allocation = this.actor.allocation;
        const width = Math.max(0, allocation.x2 - allocation.x1);

        // Prepare the appropriate child for tweening
        if (submenu) {
            this.sub.set_opacity(0);
            this.sub.set_width(0);
            this.sub.set_height(0);
            this.sub.visible = true;
        } else {
            this.box.set_opacity(0);
            this.box.set_width(0);
            this.sub.set_height(0);
            this.box.visible = true;
        }

        // Setup the animation
        this.box.save_easing_state();
        this.box.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.box.set_easing_duration(250);

        this.sub.save_easing_state();
        this.sub.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        this.sub.set_easing_duration(250);

        if (submenu) {
            submenu.actor.show();

            this.sub.set_opacity(255);
            this.sub.set_width(width);
            this.sub.set_height(-1);

            this.box.set_opacity(0);
            this.box.set_width(0);
            this.box.set_height(0);
        } else {
            this.box.set_opacity(255);
            this.box.set_width(width);
            this.box.set_height(-1);

            this.sub.set_opacity(0);
            this.sub.set_width(0);
            this.sub.set_height(0);
        }

        // Reset the animation
        this.box.restore_easing_state();
        this.sub.restore_easing_state();

        //
        this._submenu = submenu;
    }

    destroy() {
        this.actor.disconnect(this._mappedId);
        this.box.disconnect(this._boxTransitionsCompletedId);
        this.sub.disconnect(this._subTransitionsCompletedId);
        this.sub.disconnect(this._submenuCloseKeyId);
        this.model.disconnect(this._itemsChangedId);

        super.destroy();
    }
};


/**
 * A St.Button subclass for iconic GMenu items
 */
var IconButton = GObject.registerClass({
    GTypeName: 'GSConnectShellIconButton',
}, class Button extends St.Button {

    _init(params) {
        super._init({
            style_class: 'gsconnect-icon-button',
            can_focus: true,
        });
        Object.assign(this, params);

        // Item attributes
        if (params.info.hasOwnProperty('action'))
            this.action_name = params.info.action.split('.')[1];

        if (params.info.hasOwnProperty('target'))
            this.action_target = params.info.target;

        if (params.info.hasOwnProperty('label')) {
            this.tooltip = new Tooltip.Tooltip({
                parent: this,
                markup: params.info.label,
            });

            this.accessible_name = params.info.label;
        }

        if (params.info.hasOwnProperty('icon'))
            this.child = new St.Icon({gicon: params.info.icon});

        // Submenu
        for (const link of params.info.links) {
            if (link.name === 'submenu') {
                this.add_accessible_state(Atk.StateType.EXPANDABLE);
                this.toggle_mode = true;
                this.connect('notify::checked', this._onChecked);

                this.submenu = new ListBox({
                    model: link.value,
                    action_group: this.action_group,
                    _parent: this._parent,
                });

                this.submenu.actor.style_class = 'popup-sub-menu';
                this.submenu.actor.visible = false;
            }
        }
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
    vfunc_clicked(clicked_button) {
        // Unless this has a submenu, activate the action and close the menu
        if (!this.toggle_mode) {
            this._parent._getTopMenu().close();

            this.action_group.activate_action(
                this.action_name,
                this.action_target
            );

        // StButton.checked has already been toggled so we're opening
        } else if (this.checked) {
            this._parent.submenu = this.submenu;

        // If this is the active submenu being closed, animate-close it
        } else if (this._parent.submenu === this.submenu) {
            this._parent.submenu = null;
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
            x_expand: true,
        });
        this.actor._delegate = this;

        // Button Box
        this.box._delegate = this;
        this.box.style_class = 'gsconnect-icon-box';
        this.box.vertical = false;
        this.actor.add_child(this.box);

        // Submenu Container
        this.sub = new St.BoxLayout({
            clip_to_allocation: true,
            vertical: true,
            x_expand: true,
        });
        this.sub.connect('transitions-completed', this._onTransitionsCompleted);
        this.sub._delegate = this;
        this.actor.add_child(this.sub);

        // Track menu items so we can use ::items-changed
        this._menu_items = new Map();

        // PopupMenu
        this._mappedId = this.actor.connect(
            'notify::mapped',
            this._onMapped.bind(this)
        );

        // GMenu
        this._itemsChangedId = this.model.connect(
            'items-changed',
            this._onItemsChanged.bind(this)
        );

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

    destroy() {
        this.actor.disconnect(this._mappedId);
        this.model.disconnect(this._itemsChangedId);
        this.action_group.disconnect(this._actionAddedId);
        this.action_group.disconnect(this._actionEnabledChangedId);
        this.action_group.disconnect(this._actionRemovedId);

        super.destroy();
    }

    get submenu() {
        return this._submenu || null;
    }

    set submenu(submenu) {
        if (submenu) {
            for (const button of this.box.get_children()) {
                if (button.submenu && this._submenu && button.submenu !== submenu) {
                    button.checked = false;
                    button.submenu.actor.hide();
                }
            }

            this.sub.set_height(0);
            submenu.actor.show();
        }

        this.sub.save_easing_state();
        this.sub.set_easing_duration(250);
        this.sub.set_easing_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);

        this.sub.set_height(submenu ? submenu.actor.get_preferred_size()[1] : 0);
        this.sub.restore_easing_state();

        this._submenu = submenu;
    }

    _onMapped(actor) {
        if (!actor.mapped) {
            this._submenu = null;

            for (const button of this.box.get_children())
                button.checked = false;

            for (const submenu of this.sub.get_children())
                submenu.hide();
        }
    }

    _onActionChanged(group, name, enabled) {
        const menuItem = this._menu_items.get(name);

        if (menuItem !== undefined)
            menuItem.visible = group.get_action_enabled(name);
    }

    _onItemsChanged(model, position, removed, added) {
        // Remove items
        while (removed > 0) {
            const button = this.box.get_child_at_index(position);
            const action_name = button.action_name;

            if (button.submenu)
                button.submenu.destroy();

            button.destroy();

            this._menu_items.delete(action_name);
            removed--;
        }

        // Add items
        for (let i = 0; i < added; i++) {
            const index = position + i;

            // Create an iconic button
            const button = new IconButton({
                action_group: this.action_group,
                info: getItemInfo(model, index),
                // NOTE: Because this doesn't derive from a PopupMenu class
                //       it lacks some things its parent will expect from it
                _parent: this,
                _delegate: null,
            });

            // Set the visibility based on the enabled state
            if (button.action_name !== undefined) {
                button.visible = this.action_group.get_action_enabled(
                    button.action_name
                );
            }

            // If it has a submenu, add it as a sibling
            if (button.submenu)
                this.sub.add_child(button.submenu.actor);

            // Track the item if it has an action
            if (button.action_name !== undefined)
                this._menu_items.set(button.action_name, button);

            // Insert it in the box at the defined position
            this.box.insert_child_at_index(button, index);
        }
    }

    _onTransitionsCompleted(actor) {
        const menu = actor._delegate;

        for (const button of menu.box.get_children()) {
            if (button.submenu && button.submenu !== menu.submenu) {
                button.checked = false;
                button.submenu.actor.hide();
            }
        }

        menu.sub.set_height(-1);
    }

    // PopupMenu.PopupMenuBase overrides
    isEmpty() {
        return (this.box.get_children().length === 0);
    }

    _setParent(parent) {
        super._setParent(parent);
        this._onItemsChanged(this.model, 0, 0, this.model.get_n_items());
    }
};

