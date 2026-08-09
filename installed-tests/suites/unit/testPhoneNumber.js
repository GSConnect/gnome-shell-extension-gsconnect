// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Config from '../config.js';

// eslint-disable-next-line no-unused-vars
const {default: Service} = await import(`file://${Config.PACKAGE_DATADIR}/service/init.js`);


describe('A patched String definition', function () {

    it('has phone Number methods', function () {
        const aNumber = '+1 (212) 555-1212';

        expect(aNumber.toPhoneNumber).toBeDefined();
        expect(aNumber.equalsPhoneNumber).toBeDefined();
    });

    it('can clean up numbers with toPhoneNumber', function () {
        expect('+1 (212) 555-1212'.toPhoneNumber()).toBe('12125551212');
        expect('1-212-555-1212'.toPhoneNumber()).toBe('12125551212');
        expect('+01 212 555 1212'.toPhoneNumber()).toBe('12125551212');
        expect(''.toPhoneNumber()).toBe('');
        expect('CALL-GNOME'.toPhoneNumber()).toBe('CALLGNOME');
    });

    it('can compare numbers with equalsPhoneNumber', function () {
        const aNumber = '+1 (212) 555-1212';
        const bNumber = '+01 212 555 1212';
        const cNumber = '555-1212';
        const badNumber = 'CALL-GNOME';
        const emptyNumber = '';

        expect(aNumber.equalsPhoneNumber(bNumber)).toBeTrue();
        expect(aNumber.equalsPhoneNumber(cNumber)).toBeTrue();
        expect(bNumber.equalsPhoneNumber(cNumber)).toBeTrue();

        expect(aNumber.equalsPhoneNumber(badNumber)).toBeFalse();
        expect(aNumber.equalsPhoneNumber(emptyNumber)).toBeFalse();

        expect(badNumber.equalsPhoneNumber(emptyNumber)).toBeFalse();
    });
});
