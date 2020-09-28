'use strict';


var CONNECTED = false;
var DEVICES = [];
var TARGET_URL = null;


// Suppress errors caused by Mozilla polyfill
// TODO: not sure if these are relevant anymore
const _MUTE = [
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
];


// Simple error logging function
// eslint-disable-next-line no-redeclare
function logError(error) {
    if (!_MUTE.includes(error.message))
        console.error(error.message);
}


/**
 * Share a URL, either direct to the browser or by SMS
 *
 * @param {string} device - The deviceId
 * @param {string} action - Currently either 'share' or 'telephony'
 * @param {string} url - The URL to share
 */
async function sendUrl(device, action, url) {
    try {
        window.close();

        await browser.runtime.sendMessage({
            type: 'share',
            data: {
                device: device,
                url: url,
                action: action,
            },
        });
    } catch (e) {
        logError(e);
    }
}


/**
 * Create and return a device element for the popup menu
 *
 * @param {object} device - A JSON object describing a connected device
 * @return {HTMLElement} - A <div> element with icon, name and actions
 */
function getDeviceElement(device) {
    const deviceElement = document.createElement('div');
    deviceElement.className = 'device';

    const deviceIcon = document.createElement('img');
    deviceIcon.className = 'device-icon';
    deviceIcon.src = `images/${device.type}.svg`;
    deviceElement.appendChild(deviceIcon);

    const deviceName = document.createElement('span');
    deviceName.className = 'device-name';
    deviceName.textContent = device.name;
    deviceElement.appendChild(deviceName);

    if (device.share) {
        const shareButton = document.createElement('img');
        shareButton.className = 'plugin-button';
        shareButton.src = 'images/open-in-browser.svg';
        shareButton.title = browser.i18n.getMessage('shareMessage');
        shareButton.addEventListener(
            'click',
            () => sendUrl(device.id, 'share', URL)
        );
        deviceElement.appendChild(shareButton);
    }

    if (device.telephony) {
        const telephonyButton = document.createElement('img');
        telephonyButton.className = 'plugin-button';
        telephonyButton.src = 'images/message.svg';
        telephonyButton.title = browser.i18n.getMessage('smsMessage');
        telephonyButton.addEventListener(
            'click',
            () => sendUrl(device.id, 'telephony', URL)
        );
        deviceElement.appendChild(telephonyButton);
    }

    return deviceElement;
}


/**
 * Populate the browserAction popup
 */
function setPopup() {
    const devNode = document.getElementById('popup');

    while (devNode.hasChildNodes())
        devNode.removeChild(devNode.lastChild);

    if (CONNECTED && DEVICES.length) {
        for (const device of DEVICES) {
            const deviceElement = getDeviceElement(device);
            devNode.appendChild(deviceElement);
        }

        return;
    }

    // Disconnected or no devices
    const message = document.createElement('span');
    message.className = 'popup-menu-message';
    devNode.appendChild(message);

    // The native-messaging-host or service is disconnected
    if (!CONNECTED)
        message.textContent = browser.i18n.getMessage('popupMenuDisconnected');

    // There are no devices
    else
        message.textContent = browser.i18n.getMessage('popupMenuNoDevices');
}


/**
 * Callback for receiving a message forwarded by background.js
 *
 * @param {Object} message - A JSON message object
 * @param {runtime.MessageSender} sender - The sender of the message.
 */
function onPortMessage(message, sender) {
    try {
        // console.log(`WebExtension-popup RECV: ${JSON.stringify(message)}`);

        if (sender.url.includes('/background.html')) {
            if (message.type === 'connected') {
                CONNECTED = message.data;
            } else if (message.type === 'devices') {
                CONNECTED = true;
                DEVICES = message.data;
            }

            setPopup();
        }
    } catch (e) {
        logError(e);
    }
}


/**
 * Set the current URL and repopulate the popup, on-demand
 */
async function onPopup() {
    try {
        const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
        });

        if (tabs.length)
            TARGET_URL = tabs[0].url;

        setPopup();
        await browser.runtime.sendMessage({type: 'devices'});
    } catch (e) {
        logError(e);
    }
}


/**
 * Startup: listen for forwarded messages and populate the popup on-demand
 */
browser.runtime.onMessage.addListener(onPortMessage);
document.addEventListener('DOMContentLoaded', onPopup);

