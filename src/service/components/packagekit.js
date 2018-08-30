'use strict';

const PackageKit = imports.gi.PackageKitGlib;


/**
 * Return a list of packages from @names that are available
 *
 * @param {Array of string} names - The names of the packages to find
 * @return {Array of PackageKit.Package} - The packages found
 */
PackageKit.Client.prototype.getAvailable = function(names) {
    return new Promise((resolve, reject) => {
        this.resolve_async(
            PackageKit.filter_bitfield_from_string('arch'),
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
 * Return a list of packages from @names that are installable
 *
 * @param {string} name - The name of the package to find
 * @return {Array of PackageKit.Package} - The packages found
 */
PackageKit.Client.prototype.getInstallable = function(names) {
    return new Promise((resolve, reject) => {
        this.resolve_async(
            PackageKit.filter_bitfield_from_string('arch;~installed'),
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
PackageKit.Client.prototype.installPackages = function(package_ids) {
    return new Promise((resolve, reject) => {
        this.install_packages_async(
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


/**
 * The service class for this component
 */
var Service = PackageKit.Client;

