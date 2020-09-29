'use strict';

const GLib = imports.gi.GLib;


/**
 * The same regular expression used in GNOME Shell
 *
 * http://daringfireball.net/2010/07/improved_regex_for_matching_urls
 */
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:http|https)://' +                 // scheme://
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces.
 * This allows passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
const _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
const _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
const _lenientDigits = '[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+';
const _lenientNumber = `${_lenientDigits}(?:${_telParam})*`;

const _smsRegex = new RegExp(
    '^' +
    'sms:' +                                // scheme
    '(?:[/]{2,3})?' +                       // Gio.File returns ":///"
    '(' +                                   // one or more...
        _lenientNumber +                    // phone numbers
        '(?:,' + _lenientNumber + ')*' +    // separated by commas
    ')' +
    '(?:\\?(' +                             // followed by optional...
        _smsParam +                         // parameters...
        '(?:&' + _smsParam + ')*' +         // separated by "&" (unescaped)
    '))?' +
    '$', 'g');                              // fragments (#foo) not allowed


const _numberRegex = new RegExp(
    '^' +
    '(' + _lenientDigits + ')' +            // phone number digits
    '((?:' + _telParam + ')*)' +            // followed by optional parameters
    '$', 'g');


/**
 * Searches @str for URLs and returns an array of objects with %url
 * properties showing the matched URL string, and %pos properties indicating
 * the position within @str where the URL was found.
 *
 * @param {string} str - the string to search
 * @return {Object[]} the list of match objects, as described above
 */
function findUrls(str) {
    _urlRegexp.lastIndex = 0;

    const res = [];
    let match;

    while ((match = _urlRegexp.exec(str))) {
        const name = match[2];
        const url = GLib.uri_parse_scheme(name) ? name : `http://${name}`;
        res.push({name, url, pos: match.index + match[1].length});
    }

    return res;
}


/**
 * Return a string with URLs couched in <a> tags, parseable by Pango and
 * using the same RegExp as GNOME Shell.
 *
 * @param {string} str - The string to be modified
 * @param {string} [title] - An optional title (eg. alt text, tooltip)
 * @return {string} the modified text
 */
function linkify(str, title = null) {
    const text = GLib.markup_escape_text(str, -1);

    _urlRegexp.lastIndex = 0;

    if (title) {
        return text.replace(
            _urlRegexp,
            `$1<a href="$2" title="${title}">$2</a>`
        );
    } else {
        return text.replace(_urlRegexp, '$1<a href="$2">$2</a>');
    }
}


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var SmsURI = class URI {
    constructor(uri) {
        _smsRegex.lastIndex = 0;
        const [, recipients, query] = _smsRegex.exec(uri);

        this.recipients = recipients.split(',').map(recipient => {
            _numberRegex.lastIndex = 0;
            const [, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (const param of params.substr(1).split(';')) {
                    const [key, value] = param.split('=');

                    // add phone-context to beginning of
                    if (key === 'phone-context' && value.startsWith('+'))
                        return value + unescape(number);
                }
            }

            return unescape(number);
        });

        if (query) {
            for (const field of query.split('&')) {
                const [key, value] = field.split('=');

                if (key === 'body') {
                    if (this.body)
                        throw URIError('duplicate "body" field');

                    this.body = value ? decodeURIComponent(value) : undefined;
                }
            }
        }
    }

    toString() {
        const uri = `sms:${this.recipients.join(',')}`;

        return this.body ? `${uri}?body=${escape(this.body)}` : uri;
    }
};

