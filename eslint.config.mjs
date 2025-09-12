// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later
import globals from 'globals';
import js from '@eslint/js';
import stylisticJs from '@stylistic/eslint-plugin-js';
import jsdoc from 'eslint-plugin-jsdoc';
import {defineConfig, globalIgnores} from 'eslint/config';

export default defineConfig([
    js.configs.recommended,
    jsdoc.configs['flat/recommended'],
    globalIgnores([
        '**/*.js',
	'!src/**/*.js',
	'!installed-tests/**/*.js',
	'!webextension/**/*.js',
	'webextension/js/browser-polyfill*',
    ]),
    {
	files: [
	    'src/**/*.js',
	    'installed-tests/**/*.js',
	    'webextension/**/*.js',
	],
        plugins: {
            '@stylistic/js': stylisticJs,
            jsdoc,
        },
        languageOptions: {
            globals: {
                ...globals['shared-node-browser'],
                ARGV: 'readonly',
                Debugger: 'readonly',
                GIRepositoryGType: 'readonly',
                globalThis: 'readonly',
                imports: 'readonly',
                Intl: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                global: false,
                debug: false,
                _: false,
                _C: false,
                _N: false,
                ngettext: false,
            },

            ecmaVersion: 'latest',
            sourceType: 'module',
        },

        rules: {
            '@stylistic/js/array-bracket-newline': ['error', 'consistent'],
            '@stylistic/js/array-bracket-spacing': ['error', 'never'],
            'array-callback-return': 'error',
            '@stylistic/js/arrow-spacing': 'error',
            'block-scoped-var': 'error',
            '@stylistic/js/block-spacing': 'error',
            '@stylistic/js/brace-style': 'error',

            '@stylistic/js/comma-dangle': ['error', {
                arrays: 'always-multiline',
                objects: 'always-multiline',
                functions: 'never',
            }],

            '@stylistic/js/comma-spacing': ['error', {
                before: false,
                after: true,
            }],

            '@stylistic/js/comma-style': ['error', 'last'],
            '@stylistic/js/computed-property-spacing': 'error',
            curly: ['error', 'multi-or-nest', 'consistent'],
            '@stylistic/js/dot-location': ['error', 'property'],
            '@stylistic/js/eol-last': 'error',
            eqeqeq: 'error',
            '@stylistic/js/func-call-spacing': 'error',
            'func-name-matching': 'error',

            'func-style': ['error', 'declaration', {
                allowArrowFunctions: true,
            }],

            'grouped-accessor-pairs': ['error', 'getBeforeSet'],

            '@stylistic/js/indent': ['error', 4, {
                ignoredNodes: [
                    'CallExpression[callee.object.name=GObject][callee.property.name=registerClass] > ClassExpression:first-child',
                ],

                MemberExpression: 'off',
                SwitchCase: 1,
            }],

            '@stylistic/js/key-spacing': ['error', {
                beforeColon: false,
                afterColon: true,
            }],

            '@stylistic/js/keyword-spacing': ['error', {
                before: true,
                after: true,
            }],

            '@stylistic/js/linebreak-style': ['error', 'unix'],
            '@stylistic/js/lines-between-class-members': 'error',

            'max-nested-callbacks': ['error', {
                max: 5,
            }],

            '@stylistic/js/max-statements-per-line': 'error',
            '@stylistic/js/new-parens': 'error',
            'no-array-constructor': 'error',
            'no-caller': 'error',

            'no-constant-condition': ['error', {
                checkLoops: false,
            }],

            'no-empty': ['error', {
                allowEmptyCatch: true,
            }],

            'no-extra-bind': 'error',

            'no-implicit-coercion': ['error', {
                allow: ['!!'],
            }],

            'no-iterator': 'error',
            'no-label-var': 'error',
            'no-lonely-if': 'error',
            'no-loop-func': 'error',
            'no-nested-ternary': 'error',
            'no-object-constructor': 'error',
            'no-new-wrappers': 'error',
            'no-octal-escape': 'error',
            'no-proto': 'error',
            'no-prototype-builtins': 'off',

            'no-restricted-properties': ['error', {
                object: 'Lang',
                property: 'bind',
                message: 'Use arrow notation or Function.prototype.bind()',
            }, {
                object: 'Lang',
                property: 'Class',
                message: 'Use ES6 classes',
            }, {
                object: 'imports',
                property: 'mainloop',
                message: 'Use GLib main loops and timeouts',
            }],

            'no-restricted-syntax': ['error', {
                selector: 'MethodDefinition[key.name=\'_init\'] > FunctionExpression[params.length=1] > BlockStatement[body.length=1] CallExpression[arguments.length=1][callee.object.type=\'Super\'][callee.property.name=\'_init\'] > Identifier:first-child',
                message: '_init() that only calls super._init() is unnecessary',
            }, {
                selector: 'MethodDefinition[key.name=\'_init\'] > FunctionExpression[params.length=0] > BlockStatement[body.length=1] CallExpression[arguments.length=0][callee.object.type=\'Super\'][callee.property.name=\'_init\']',
                message: '_init() that only calls super._init() is unnecessary',
            }],

            'no-return-assign': 'error',
            'no-self-compare': 'error',
            'no-shadow-restricted-names': 'error',
            '@stylistic/js/no-tabs': 'error',
            'no-template-curly-in-string': 'error',
            'no-throw-literal': 'error',
            '@stylistic/js/no-trailing-spaces': 'error',
            'no-undef-init': 'error',
            'no-unneeded-ternary': 'error',
            'no-unused-expressions': 'error',

            'no-unused-vars': ['error', {
                args: 'none',
                vars: 'local',
            }],

            'no-useless-call': 'error',
            'no-useless-computed-key': 'error',
            'no-useless-concat': 'error',
            'no-useless-constructor': 'error',
            'no-useless-rename': 'error',
            'no-useless-return': 'error',
            '@stylistic/js/no-whitespace-before-property': 'error',
            'no-with': 'error',
            '@stylistic/js/nonblock-statement-body-position': ['error', 'below'],

            '@stylistic/js/object-curly-newline': ['error', {
                consistent: true,
            }],

            '@stylistic/js/object-curly-spacing': 'error',
            'operator-assignment': 'error',
            '@stylistic/js/operator-linebreak': 'error',
            'prefer-const': 'error',
            'prefer-numeric-literals': 'error',
            'prefer-promise-reject-errors': 'error',
            'prefer-rest-params': 'error',
            'prefer-spread': 'error',

            '@stylistic/js/quotes': ['error', 'single', {
                avoidEscape: true,
            }],

            'require-await': 'error',
            '@stylistic/js/rest-spread-spacing': 'error',
            '@stylistic/js/semi': ['error', 'always'],

            '@stylistic/js/semi-spacing': ['error', {
                before: false,
                after: true,
            }],

            '@stylistic/js/semi-style': 'error',
            '@stylistic/js/space-before-blocks': 'error',

            '@stylistic/js/space-before-function-paren': ['error', {
                named: 'never',
                anonymous: 'always',
                asyncArrow: 'always',
            }],

            '@stylistic/js/space-in-parens': 'error',

            '@stylistic/js/space-infix-ops': ['error', {
                int32Hint: false,
            }],

            '@stylistic/js/space-unary-ops': 'error',
            '@stylistic/js/spaced-comment': 'error',
            '@stylistic/js/switch-colon-spacing': 'error',
            'symbol-description': 'error',
            '@stylistic/js/template-curly-spacing': 'error',
            '@stylistic/js/template-tag-spacing': 'error',
            'unicode-bom': 'error',

            '@stylistic/js/wrap-iife': ['error', 'inside'],
            '@stylistic/js/yield-star-spacing': 'error',
            yoda: 'error',

            'jsdoc/tag-lines': ['error', 'any', {'startLines': 1}],
        },
    },
    {
        files: ['webextension/js/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.webextensions,
            },
        },
        rules: {
            'no-console': ['error', {
                allow: ['warn', 'error'],
            }],
        },
    },
    {
        files: ['installed-tests/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.jasmine,
                ...globals['shared-node-browser'],
                clearInterval: 'writable',
                clearTimeout: 'writable',
                setInterval: 'writable',
                setTimeout: 'writable',
            },
        },
        rules: {
            'no-restricted-globals': ['error', {
                name: 'fdescribe',
                message: 'Do not commit fdescribe(). Use describe() instead.',
            }, {
                name: 'fit',
                message: 'Do not commit fit(). Use it() instead.',
            }],

            'no-restricted-syntax': ['error', {
                selector: 'CallExpression[callee.name=\'it\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }, {
                selector: 'CallExpression[callee.name=\'describe\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }, {
                selector: 'CallExpression[callee.name=\'beforeEach\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }, {
                selector: 'CallExpression[callee.name=\'afterEach\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }, {
                selector: 'CallExpression[callee.name=\'beforeAll\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }, {
                selector: 'CallExpression[callee.name=\'afterAll\'] > ArrowFunctionExpression',
                message: 'Arrow functions can mess up some Jasmine APIs. Use function () instead',
            }],
        },
    },
]);
