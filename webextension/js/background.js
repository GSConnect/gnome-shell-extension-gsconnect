// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const _ABOUT = /^chrome:|^about:/;

const _CONTEXTS = [
    'audio',
    'page',
    'frame',
    'link',
    'image',
    // FIREFOX-ONLY: mkwebext.sh will automatically remove this
    'tab',
    'video',
];

// Suppress errors caused by Mozilla polyfill
// TODO: not sure if these are relevant anymore
const _MUTE = [
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
];


/**
 * State of the extension.
 */
const State = {
    connected: false,
    devices: [],
    port: null,
};

var reconnectDelay = 100;
var reconnectTimer = null;
var reconnectResetTimer = null;


/**
 * Simple error logging function
 *
 * @param {Error} error - A caught exception
 */
function logError(error) {
    if (!_MUTE.includes(error.message))
        console.error(error.message);
}

// browser.action.onClicked.addListener(onContextItem);

/**
 * Callback for activation of the extension toolbar icon
 *
 * @param {browser.tabs.Tab} tab - the current tab
 */
function toggleAction(tab = null) {
    try {
        // Disable on "about:" pages
        if (_ABOUT.test(tab.url))
            browser.action.disable(tab.id);
        else {
            browser.action.enable(tab.id);
        }
    } catch {
        browser.action.disable();
    }
}


/**
 * Send a message to the native-messaging-host
 *
 * @param {object} message - The message to forward
 */
async function postMessage(message) {
    try {
        // console.log(`WebExtension SEND: ${JSON.stringify(message)}`);

        if (!State.port || !message || !message.type) {
            console.warn('Missing message parameters');
            return;
        }

        await State.port.postMessage(message);
    } catch (e) {
        logError(e);
    }
}


/**
 * Forward a message from the action popup to the NMH
 *
 * @param {object} message - A message from the NMH to forward
 * @param {*} sender - A message from the NMH to forward
 */
async function onPopupMessage(message, sender) {
    try {
        if (sender.url.includes('/popup.html'))
            await postMessage(message);
    } catch (e) {
        logError(e);
    }
}


/**
 * Forward a message from the NMH to the action popup
 *
 * @param {object} message - A message from the NMH to forward
 */
async function forwardPortMessage(message) {
    try {
        await browser.runtime.sendMessage(message);
    } catch (e) {
        logError(e);
    }
}


/**
 * Context Menu Item Callback
 *
 * @param {browser.menus.OnClickData} info - Information about the item and context
 */
async function onContextItem(info) {
    try {
        const [id, action] = info.menuItemId.split(':');

        await postMessage({
            type: 'share',
            data: {
                device: id,
                url: info.linkUrl || info.srcUrl || info.frameUrl || info.pageUrl,
                action: action,
            },
        });
    } catch (e) {
        logError(e);
    }
}


/**
 * Populate the context menu
 *
 * @param {browser.tabs.Tab} tab - The current tab
 */
async function createContextMenu(tab) {
    try {
        // Clear context menu
        await browser.contextMenus.removeAll();

        // Bail on "about:" page or no devices
        if (_ABOUT.test(tab.url) || State.devices.length === 0)
            return;

        // Multiple devices; we'll have at least one submenu level
        if (State.devices.length > 1) {
            await browser.contextMenus.create({
                id: 'contextMenuMultipleDevices',
                title: browser.i18n.getMessage('contextMenuMultipleDevices'),
                contexts: _CONTEXTS,
            });

            for (const device of State.devices) {
                if (device.share && device.telephony) {
                    await browser.contextMenus.create({
                        id: device.id,
                        title: device.name,
                        parentId: 'contextMenuMultipleDevices',
                    });

                    await browser.contextMenus.create({
                        id: `${device.id}:share`,
                        title: browser.i18n.getMessage('shareMessage'),
                        parentId: device.id,
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });

                    await browser.contextMenus.create({
                        id: `${device.id}:telephony`,
                        title: browser.i18n.getMessage('smsMessage'),
                        parentId: device.id,
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });
                } else {
                    let pluginAction, pluginName;

                    if (device.share) {
                        pluginAction = 'share';
                        pluginName = browser.i18n.getMessage('shareMessage');
                    } else {
                        pluginAction = 'telephony';
                        pluginName = browser.i18n.getMessage('smsMessage');
                    }

                    await browser.contextMenus.create({
                        id: `${device.id}:${pluginAction}`,
                        title: browser.i18n.getMessage(
                            'contextMenuSinglePlugin',
                            [device.name, pluginName]
                        ),
                        parentId: 'contextMenuMultipleDevices',
                        contexts: _CONTEXTS,
                        // onclick: onContextItem,
                    });
                }
            }

        // One device; we'll create a top level menu
        } else {
            const device = State.devices[0];

            if (device.share && device.telephony) {
                await browser.contextMenus.create({
                    id: device.id,
                    title: device.name,
                    contexts: _CONTEXTS,
                });

                await browser.contextMenus.create({
                    id: `${device.id}:share`,
                    title: browser.i18n.getMessage('shareMessage'),
                    parentId: device.id,
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });

                await browser.contextMenus.create({
                    id: `${device.id}:telephony`,
                    title: browser.i18n.getMessage('smsMessage'),
                    parentId: device.id,
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });
            } else {
                let pluginAction, pluginName;

                if (device.share) {
                    pluginAction = 'share';
                    pluginName = browser.i18n.getMessage('shareMessage');
                } else {
                    pluginAction = 'telephony';
                    pluginName = browser.i18n.getMessage('smsMessage');
                }

                await browser.contextMenus.create({
                    id: `${device.id}:${pluginAction}`,
                    title: browser.i18n.getMessage(
                        'contextMenuSinglePlugin',
                        [device.name, pluginName]
                    ),
                    contexts: _CONTEXTS,
                    // onclick: onContextItem,
                });
            }
        }
    } catch (e) {
        logError(e);
    }
}


/**
 * Message Handling
 *
 * @param {object} message - A message received from the NMH
 */
async function onPortMessage(message) {
    try {
        // console.log(`WebExtension RECV: ${JSON.stringify(message)}`);

        // The native-messaging-host's connection to the service has changed
        if (message.type === 'connected') {
            State.connected = message.data;

            if (State.connected)
                postMessage({type: 'devices'});
            else
                State.devices = [];

        // We're being sent a list of devices (so the NMH must be connected)
        } else if (message.type === 'devices') {
            State.connected = true;
            State.devices = message.data;
        }

        // Forward the message to popup.html
        forwardPortMessage(message);

        //
        const tabs = (await chrome.tabs.query({
            // active: true,
            currentWindow: true,
        })).filter(tab => tab.active);

        createContextMenu(tabs[0]);
    } catch (e) {
        logError(e);
    }
}


/**
 * Callback for disconnection from the native-messaging-host
 */
async function onDisconnect() {
    try {
        State.connected = false;
        State.port = null;
        browser.action.setBadgeText({text: '\u26D4'});
        browser.action.setBadgeBackgroundColor({color: [198, 40, 40, 255]});
        forwardPortMessage({type: 'connected', data: false});

        // Clear context menu
        await browser.contextMenus.removeAll();

        // Disconnected, cancel back-off reset
        if (typeof reconnectResetTimer === 'number') {
            clearTimeout(reconnectResetTimer);
            reconnectResetTimer = null;
        }

        // // Don't queue more than one reconnect
        if (typeof reconnectTimer === 'number') {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Log disconnection
        if (browser.runtime.lastError) {
            const message = browser.runtime.lastError.message;
            console.warn(`Disconnected: ${message}`);
        }

        // Exponential back-off on reconnect
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay *= 2;
    } catch (e) {
        logError(e);
    }
}


/**
 * Start and/or connect to the native-messaging-host
 */
async function connect() {
    try {
        State.port = browser.runtime.connectNative('org.gnome.shell.extensions.gsconnect');

        // Clear the badge and tell the popup we're disconnected
        browser.action.setBadgeText({text: ''});
        browser.action.setBadgeBackgroundColor({color: [0, 0, 0, 0]});

        // Reset the back-off delay if we stay connected
        reconnectResetTimer = setTimeout(() => {
            reconnectDelay = 100;
        }, reconnectDelay * 0.9);

        // Start listening and request a list of available devices
        State.port.onDisconnect.addListener(onDisconnect);
        State.port.onMessage.addListener(onPortMessage);
        await State.port.postMessage({type: 'devices'});
    } catch (e) {
        logError(e);
    }
}


// Forward messages from the action popup
browser.runtime.onMessage.addListener(onPopupMessage);

// Keep action up to date
browser.tabs.onActivated.addListener((info) => {
    browser.tabs.get(info.tabId).then(toggleAction);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url)
        toggleAction(tab);
});

// Keep contextMenu up to date
browser.tabs.onActivated.addListener((info) => {
    browser.tabs.get(info.tabId).then(createContextMenu);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url)
        createContextMenu(tab);
});


/**
 * Startup: set initial state of the action and try to connect
 */
toggleAction();
connect();
