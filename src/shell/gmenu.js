'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PopupMenu = imports.ui.popupMenu;

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
 */
var ListBoxItem = class ListBoxItem extends PopupMenu.PopupMenuItem {
    _init(info, action_group) {
        super._init(info.label);

        this._action_group = action_group;
        this._action_name = info.action.split('.')[1];
        this._action_target = info.target;

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
}


/**
 *
 */
var ListBox = class ListBox extends PopupMenu.PopupMenuSection {

    _init(parentActor, menu_model, action_group) {
        super._init();

        this.parentActor = parentActor;
        this._action_group = action_group;
        this._menu_model = menu_model;
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
        this._actionStateChangedId = this.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );

        this.connect('destroy', this._onDestroy);
    }

    get action_group() {
        if (this._action_group === undefined) {
            return this.actor.get_parent().action_group;
        }

        return this._action_group;
    }

    get menu_model() {
        return this._menu_model;
    }

    async _addGMenuItem(info) {
        let item = new ListBoxItem(info, this.action_group);

        item.connect('activate', (item) => {
            item.action_group.activate_action(
                item.action_name,
                item.action_target
            );

            // TODO: The signal chain here is embarassing
            this.parentActor.emit('submenu-toggle');
        });

        this.addMenuItem(item);
        item.actor.reactive = this.action_group.get_action_enabled(item.action_name);
        this._menu_items.set(item.action_name, item);
    }

    async _addGMenuSection(model) {
        let section = new ListBox(this.parentActor, model, this.action_group);
        this.addMenuItem(section);
    }

    _addGMenuSubmenu(model) {
    }

    async _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            if (typeof enabled !== 'boolean') {
                enabled = this.action_group.get_action_enabled(name);
            }

            //menuItem.visible = enabled;
            menuItem.actor.reactive = enabled;
            menuItem.actor.opacity = (menuItem.actor.reactive) ? 255 : 128;
        }
    }

    async _onItemsChanged(model, position, removed, added) {
        // Using ::items-changed is arduous and probably not worth the trouble
        this._menu_items.clear();
        this.removeAll();

        let len = model.get_n_items();

        for (let i = 0; i < len; i++) {
            let info = new ItemInfo(model, i);

            // TODO: better section/submenu detection
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

    _onDestroy(actor) {
        actor.menu_model.disconnect(actor._itemsChangedId);
        actor.action_group.disconnect(actor._actionAddedId);
        actor.action_group.disconnect(actor._actionEnabledChangedId);
        actor.action_group.disconnect(actor._actionRemovedId);
        actor.action_group.disconnect(actor._actionStateChangedId);
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

        this._action_group = params.action_group;

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
        if (params.info.hasOwnProperty('icon')) {
            this.child = new St.Icon({ gicon: params.info.icon });
        } else {
            this.child = new St.Icon({
                gicon: new Gio.ThemedIcon({
                    name: 'application-x-addon-symbolic'
                })
            });
        }

        // Action & Target
        if (params.info.hasOwnProperty('action')) {
            this._action_name = params.info.action.split('.')[1];
        }

        if (params.info.hasOwnProperty('target')) {
            this._action_target = params.info.target;
        }

        // Label
        if (params.info.hasOwnProperty('label')) {
            this.tooltip = new Tooltip.Tooltip({
                parent: this,
                markup: params.info.label
            });
        }

        // Submenu
        for (let link of params.info.links) {
            if (link.name === 'submenu') {
                this.submenu = new ListBox(this, link.value, this.action_group);
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

        this.connect('destroy', this._onDestroy.bind(this));
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

        return parent._delegate._getTopMenu()
    }

    // TODO: fix super ugly delegation chain
    _onClicked(button) {
        // If this is an actionable item close the top menu and activate
        if (button.action_name) {
            this._getTopMenu().close();

            button.action_group.activate_action(
                button.action_name,
                button.action_target
            );
        // Otherwise emit if it has a submenu
        } else if (button.submenu !== null) {
            button.emit('submenu-toggle');
        }
    }

    _onDestroy(button) {
        if (button.hasOwnProperty('submenu')) {
            button.submenu.destroy();
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
        this._actionStateChangedId = this.action_group.connect(
            'action-removed',
            this._onActionChanged.bind(this)
        );

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get action_group() {
        return this._action_group;
    }

    set action_group(group) {
        this._action_group = group;
    }

    get menu_model() {
        return this._menu_model;
    }

    set menu_model(model) {
        this._menu_model = model
    }

    async _onActionChanged(group, name, enabled) {
        let menuItem = this._menu_items.get(name);

        if (menuItem !== undefined) {
            if (typeof enabled !== 'boolean') {
                enabled = this.action_group.get_action_enabled(name);
            }

            //menuItem.visible = enabled;
            menuItem.reactive = enabled;
            menuItem.opacity = (menuItem.reactive) ? 255 : 128;
        }
    }

    async _onItemsChanged(model, position, removed, added) {
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
                info: new ItemInfo(model, index)
            });

            if (button.action_name) {
                button.reactive = this.action_group.get_action_enabled(
                    button.action_name
                );
                button.opacity = (button.reactive) ? 255 : 128;
            }

            button.connect('submenu-toggle', this._toggleList.bind(this));
            this._menu_items.set(button.action_name, button);

            this.insert_child_at_index(button, index);
        }
    }

    _onDestroy(actor) {
        actor.menu_model.disconnect(actor._itemsChangedId);
        actor.action_group.disconnect(actor._actionAddedId);
        actor.action_group.disconnect(actor._actionEnabledChangedId);
        actor.action_group.disconnect(actor._actionRemovedId);
        actor.action_group.disconnect(actor._actionStateChangedId);
    }

    _toggleList(button) {
        this.emit('submenu-toggle', button);
    }
});

