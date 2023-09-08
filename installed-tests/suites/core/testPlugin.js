// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const {Gio, GLib, GObject} = imports.gi; //todo port import

const Utils = imports.fixtures.utils; //todo port import

const Device = imports.service.device; //todo port import
const Components = imports.service.components; //todo port import
const PluginBase = imports.service.plugin; //todo port import


/*
 * Phony plugin
 */
var Metadata = {
    label: 'FooBarBaz',
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.FooBarBaz',
    incomingCapabilities: ['kdeconnect.foo'],
    outgoingCapabilities: ['kdeconnect.bar', 'kdeconnect.qux'],
    actions: {
        foo: {
            label: 'Foo',
            icon_name: 'dialog-information-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: ['kdeconnect.foo'],
            outgoing: [],
        },
        bar: {
            label: 'Bar',
            icon_name: 'dialog-information-symbolic',

            parameter_type: new GLib.VariantType('b'),
            incoming: [],
            outgoing: ['kdeconnect.bar'],
        },
        baz: {
            label: 'Baz',
            icon_name: 'dialog-information-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.foo'],
            outgoing: ['kdeconnect.baz'],
        },
    },
};


const TestPlugin = GObject.registerClass({
    GTypeName: 'GSConnectTestPlugin',
}, class TestPlugin extends PluginBase.Plugin {
    _init(device) {
        super._init(device, 'foobarbaz', Metadata);

        this._cacheLoaded = false;
        this.data = 'default';
        this._foo = null;
    }

    /*
     * Class methods
     */
    cacheLoaded() {
        this._cacheLoaded = true;
    }

    cacheClear() {
    }

    connected() {
        super.connected();
    }

    disconnected() {
        super.disconnected();
    }

    handlePacket(packet) {
    }

    /*
     * Instance methods
     */
    foo(params) {
        this._foo = params;
    }

    bar(bool) {
        this.device.sendPacket({
            type: 'kdeconnect.bar',
            body: {
                bar: bool,
            },
        });
    }

    baz() {
    }

    destroy() {
        if (this._someComponent !== undefined)
            this._someComponent = Components.release('notification');

        super.destroy();
    }
});


describe('Plugin GActions', function () {
    let device, plugin;

    beforeAll(function () {
        const identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: Metadata.outgoingCapabilities,
                outgoingCapabilities: Metadata.incomingCapabilities,
            },
        });

        device = new Device.Device(identity);
        plugin = new TestPlugin(device);

        spyOn(plugin, 'foo').and.callThrough();
    });

    afterAll(function () {
        device.destroy();
    });

    it('are registered when constructed', function () {
        expect(device.has_action('foo')).toBeTrue();
        expect(device.has_action('bar')).toBeTrue();
        expect(device.has_action('baz')).toBeTrue();
    });

    it('are registered with the correct parameter type', function () {
        const fooParam = device.lookup_action('foo').get_parameter_type();
        expect(fooParam.equal(Metadata.actions.foo.parameter_type)).toBeTrue();

        const barParam = device.lookup_action('bar').get_parameter_type();
        expect(barParam.equal(Metadata.actions.bar.parameter_type)).toBeTrue();

        const bazParam = device.lookup_action('baz').get_parameter_type();
        expect(bazParam).toBe(Metadata.actions.baz.parameter_type);
    });

    it('are enabled when connected', function () {
        plugin.connected();
        expect(plugin._gactions.some(action => action.enabled)).toBeTrue();
    });

    it('are only enabled if supported by the device', function () {
        expect(device.get_action_enabled('foo')).toBeTrue();
        expect(device.get_action_enabled('bar')).toBeTrue();
        expect(device.get_action_enabled('baz')).toBeFalse();
    });

    it('can be activated with complex parameters', function () {
        const parameter = new GLib.Variant('a{sv}', {
            'string': GLib.Variant.new_string('qux'),
            'icon': Gio.Icon.new_for_string('dialog-error-symbolic').serialize(),
            'nested': new GLib.Variant('a{sb}', {'key': true}),
        });
        device.lookup_action('foo').activate(parameter);

        expect(plugin.foo).toHaveBeenCalled();
        expect(plugin._foo.string).toBe('qux');
        expect(plugin._foo.icon instanceof Gio.Icon).toBeTrue();
        expect(plugin._foo.nested.key).toBeTrue();
    });

    it('are disabled when disconnected', function () {
        plugin.disconnected();
        expect(plugin._gactions.some(action => action.enabled)).toBeFalse();
    });

    it('are unregistered when destroyed', function () {
        plugin.destroy();

        expect(device.has_action('foo')).toBeFalse();
        expect(device.has_action('bar')).toBeFalse();
        expect(device.has_action('baz')).toBeFalse();
    });
});


describe('Plugin packets', function () {
    let device, plugin;

    beforeAll(function () {
        const identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: Metadata.outgoingCapabilities,
                outgoingCapabilities: Metadata.incomingCapabilities,
            },
        });

        device = new Device.Device(identity);
        plugin = new TestPlugin(device);

        device._plugins.set('foobarbaz', plugin);
        device._handlers.set('kdeconnect.foo', plugin);
        device._setPaired(true);
        plugin.connected();

        spyOn(device, 'sendPacket');
        spyOn(plugin, 'handlePacket');
        spyOn(plugin, 'bar').and.callThrough();
    });

    afterAll(function () {
        device._plugins.delete('foobarbaz');
        device._handlers.delete('kdeconnect.foo');

        plugin.destroy();
        device.destroy();
    });

    it('can be sent by function', function () {
        plugin.bar(true);
        expect(device.sendPacket).toHaveBeenCalled();
    });

    it('can be sent by GAction', function () {
        device.lookup_action('bar').activate(new GLib.Variant('b', false));

        expect(plugin.bar).toHaveBeenCalledWith(false);
        expect(device.sendPacket).toHaveBeenCalled();
    });

    it('can be received if supported', function () {
        const packet = {
            type: 'kdeconnect.foo',
            body: {},
        };
        device.handlePacket(packet);

        expect(plugin.handlePacket).toHaveBeenCalledWith(packet);
    });
});


// TODO
describe('Plugin cache', function () {
    let device, plugin;

    beforeAll(function () {
        const identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: Metadata.outgoingCapabilities,
                outgoingCapabilities: Metadata.incomingCapabilities,
            },
        });

        device = new Device.Device(identity);
        plugin = new TestPlugin(device);
    });

    afterAll(function () {
        plugin.destroy();
        device.destroy();
    });

    it('can be loaded', async function () {
        await expectAsync(plugin.cacheProperties(['data'])).toBeResolved();
        expect(plugin._cacheLoaded).toBeTrue();
    });
});
