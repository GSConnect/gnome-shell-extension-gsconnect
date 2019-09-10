'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;


/**
 * Creates a GTlsCertificate from the PEM-encoded data in @cert_path and
 * @key_path. If either are missing a new pair will be generated.
 *
 * Additionally, the private key will be added using ssh-add to allow sftp
 * connections using Gio.
 *
 * @param {string} cert_path - Absolute path to a x509 certificate in PEM format
 * @param {string} key_path - Absolute path to a private key in PEM format
 *
 * See: https://github.com/KDE/kdeconnect-kde/blob/master/core/kdeconnectconfig.cpp#L119
 */
Gio.TlsCertificate.new_for_paths = function (cert_path, key_path) {
    // Check if the certificate/key pair already exists
    let cert_exists = GLib.file_test(cert_path, GLib.FileTest.EXISTS);
    let key_exists = GLib.file_test(key_path, GLib.FileTest.EXISTS);

    // Create a new certificate and private key if necessary
    if (!cert_exists || !key_exists) {
        let id = GLib.get_host_name();
        let proc = new Gio.Subprocess({
            argv: [
                gsconnect.metadata.bin.openssl, 'req',
                '-new', '-x509', '-sha256',
                '-out', cert_path,
                '-newkey', 'rsa:4096', '-nodes',
                '-keyout', key_path,
                '-days', '3650',
                '-subj', `/O=andyholmes.github.io/OU=GSConnect/CN=${id}`
            ],
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        });
        proc.init(null);
        proc.wait_check(null);
    }

    return Gio.TlsCertificate.new_from_files(cert_path, key_path);
};

Object.defineProperties(Gio.TlsCertificate.prototype, {
    /**
     * Compute a SHA1 fingerprint of the certificate.
     * See: https://gitlab.gnome.org/GNOME/glib/issues/1290
     *
     * @return {string} - A SHA1 fingerprint of the certificate.
     */
    'fingerprint': {
        value: function() {
            if (!this.__fingerprint) {
                let proc = new Gio.Subprocess({
                    argv: [gsconnect.metadata.bin.openssl, 'x509', '-noout', '-fingerprint', '-sha1', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
                });
                proc.init(null);

                let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
                this.__fingerprint = /[a-zA-Z0-9:]{59}/.exec(stdout)[0];

                proc.wait_check(null);
            }

            return this.__fingerprint;
        },
        enumerable: false
    },

    /**
     * The common name of the certificate.
     */
    'common_name': {
        get: function() {
            if (!this.__common_name) {
                let proc = new Gio.Subprocess({
                    argv: [gsconnect.metadata.bin.openssl, 'x509', '-noout', '-subject', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
                });
                proc.init(null);

                let stdout = proc.communicate_utf8(this.certificate_pem, null)[1];
                this.__common_name = /(?:cn|CN) ?= ?([^,]*)/.exec(stdout)[1];

                proc.wait_check(null);
            }

            return this.__common_name;
        },
        enumerable: true
    },

    /**
     * The common name of the certificate.
     */
    'certificate_der': {
        get: function() {
            if (!this.__certificate_der) {
                let proc = new Gio.Subprocess({
                    argv: [gsconnect.metadata.bin.openssl, 'x509', '-outform', 'der', '-inform', 'pem'],
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
                });
                proc.init(null);

                let stdout = proc.communicate(new GLib.Bytes(this.certificate_pem), null)[1];
                this.__certificate_der = stdout.toArray();

                proc.wait_check(null);
            }

            return this.__certificate_der;
        },
        enumerable: true
    }
});

