'use strict';

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

try {
    var PackageKit = imports.gi.PackageKitGlib;
    var _client = new PackageKit.Client();
} catch (e) {
    logError(e);
}


/**
 * This is a list of "package groups" that attempt to enumerate the possible
 * package names for each particular distro to meet a feature's dependencies.
 */
const PackageGroup = {
    // Feature:     Extended Keyboard Support
    // Requires:    `Caribou-1.0.typelib`
    'caribou': [
        // Arch, Fedora, Gentoo
        'caribou',
        // Debian
        'gir1.2-caribou-1.0',
        // openSUSE
        'typelib-1_0-Caribou-1_0'
    ],

    // Feature:     Desktop Contacts
    // Requires:    `libgobject-2.0.so.0`, `libfolks-eds.so.25`, `Folks-0.6.typelib`
    'folks': [
        // Arch, Fedora, Gentoo
        'folks',
        // Debian
        'libglib2.0-dev', 'gir1.2-folks-0.6', 'libfolks-eds25',
        // openSUSE
        'typelib-1_0-FolksEds-0_6'
    ],

    // Feature:     Files Integration
    // Requires:    `Nautilus-3.0.typelib`, `libnautilus-python.so`
    'nautilus': [
        // Fedora
        'python2-nautilus', 'nautilus-extensions', 'python2-gobject',
        // Gentoo
        'nautilus-python', 'pygobject',
        // Arch, Debian/Ubuntu, openSUSE
        'python-nautilus', 'gir1.2-nautilus-3.0'
    ],

    // Feature:     Remote Filesystem
    // Requires:    `sshfs`
    'sshfs': [
        // Fedora
        'fuse-sshfs',
        // Arch, Debian/Ubuntu, Gentoo, openSUSE
        'sshfs'
    ]
};


var DependencyButton = GObject.registerClass({
    GTypeName: 'GSConnectDependencyButton',
    Properties: {
        'names': GObject.ParamSpec.string(
            'names',
            'names',
            'A names type',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'satisfied': GObject.ParamSpec.boolean(
            'satisfied',
            'Satisfied',
            'Whether the dependencies have been satisfied',
            GObject.ParamFlags.READABLE,
            false
        )
    }
}, class DependencyButton extends Gtk.Grid {

    _init(params) {
        super._init(Object.assign(params, {
            height_request: 32,
            width_request: 32,
            visible: true
        }));

        this._button = new Gtk.Button({
            image: new Gtk.Image({
                //icon_name: 'system-software-install-symbolic',
                icon_name: 'folder-download-symbolic',
                visible: true
            }),
            always_show_image: true,
            visible: true
        });
        this._button.get_style_context().add_class('circular');
        this._button.connect('clicked', this._onClicked.bind(this));
        this.attach(this._button, 0, 0, 1, 1);

        // Progress feedback
        this._spinner = new Gtk.Spinner({
            halign: Gtk.Align.CENTER,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: false
        });
        this._spinner.bind_property(
            'active',
            this._spinner,
            'visible',
            GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE
        );
        this.attach(this._spinner, 0, 0, 1, 1);

        // Success feedback
        this._result = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            halign: Gtk.Align.CENTER,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: false
        });
        this.attach(this._result, 0, 0, 1, 1);
    }

    get client() {
        try {
            return _client;
        } catch (e) {
            return null;
        }
    }

    get packages() {
        if (this._packages === undefined) {
            this._packages = null;
        }

        return this._packages;
    }

    get names() {
        if (this._names === undefined) {
            this._names = [];
        }

        return this._names;
    }

    set names(name) {
        if (PackageGroup.hasOwnProperty(name)) {
            this._names = PackageGroup[name];
        } else {
            this._names = [name];
        }
    }

    vfunc_draw(cr) {
        if (!this._state) {
            this._reset();
        }

        return super.vfunc_draw(cr);
    }

    _onClicked(button, event) {
        (this._state === 'ready') ? this._install() : this._reset();
    }

    /**
     * Return a list of packages from @names that are available
     *
     * @param {Array of string} names - The names of the packages to find
     * @param {string} filter - A semicolon-separated filter list to apply
     * @return {Array of PackageKit.Package} - The packages found
     */
    _query(names, filter = '') {
        return new Promise((resolve, reject) => {
            this.client.resolve_async(
                PackageKit.filter_bitfield_from_string(filter),
                names,
                null,
                () => {},
                (client, res) => {
                    try {
                        res = client.generic_finish(res);
                        resolve(res.get_package_array());
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Attempt to install the packages listed in @package_ids
     *
     * @param {Array} package_ids - A list of PackageKit package ids
     * @return {PackageKit.Results} - The result of the operation
     */
    _installPackages(package_ids) {
        return new Promise((resolve, reject) => {
            this.client.install_packages_async(
                PackageKit.TransactionFlagEnum.NONE,
                package_ids,
                null,
                () => {},
                (client, res) => {
                    try {
                        res = client.generic_finish(res);

                        if (res.get_error_code() !== null) {
                            throw new Error(res.get_error_code());
                        }

                        resolve(res);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _done(icon_name = null) {
        this._button.visible = false;
        this._spinner.visible = false;

        this._result.visible = true;
        this._result.icon_name = icon_name;
        this.tooltip_text = null;
    }

    _warning(e) {
        this._result.visible = false;
        this._spinner.visible = false;

        this._button.visible = true;
        this._button.image.icon_name = 'dialog-warning-symbolic';
        this.tooltip_text = e.message;

        this._state = 'warning';
    }

    _ready() {
        this._result.visible = false;
        this._spinner.visible = false;

        this._button.visible = true;
        this._button.image.icon_name = 'folder-download-symbolic';
        this.tooltip_markup = this._packages.map(pkg => {
            return `<b>${pkg.get_name()}</b> - ${pkg.get_summary()}`;
        }).join('\n');

        this._state = 'ready';
    }

    async _install() {
        try {
            this._button.visible = false;
            this._result.visible = false;
            this._spinner.visible = true;

            let ids = this._packages.map(pkg => pkg.get_id());
            await this._installPackages(ids);
            await this._reset();
        } catch (e) {
            this._warning(e);
        }
    }

    async _reset() {
        try {
            this._state = true;
            this._button.visible = false;
            this._result.visible = false;
            this._spinner.visible = true;

            // PackageKit is not available
            if (!this.client) {
                this._done('dialog-question-symbolic');
                return;
            }

            // Filter the package names into what's available and what's installed
            let available = await this._query(this.names, 'arch;newest');
            let installed = await this._query(
                available.map(pkg => pkg.get_name()),
                'arch;newest;installed'
            );
            installed = installed.map(pkg => pkg.get_name());

            // No available packages
            if (available.length === 0) {
                this._done('dialog-question-symbolic');
                return;
            }

            // If any available names are not installed, we can install them on demand
            let installable = available.filter(pkg => !installed.includes(pkg.get_name()));

            // All available packages are installed
            if (installable.length === 0) {
                this._done('object-select-symbolic');
                return;
            }

            this._packages = installable;
            this._ready();
        } catch (e) {
            this._warning(e);
        }
    }
});
