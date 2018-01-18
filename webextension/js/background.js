var connected = false;
var devices = [];
var port = null;
var reconnectDelay = 100;
var reconnectTimer = null;
var reconnectResetTimer = null;


function logError(error) {
    // Suppress errors caused by Mozilla polyfill
    // TODO: Fix these somehow?
    if (
        error.message !== "Could not establish connection. Receiving end does not exist." &&
        error.message !== "The message port closed before a response was received."
    ) {
        console.error(error.message)
    }
};


function toggleAction(tab) {
    if (!tab) {
        console.error("Missing tab for toggleAction");
        return;
    } else if (typeof tab.id !== "number") {
        console.error("tab.id should be number:", tab);
        return;
    } else if (typeof tab.url !== "string") {
        console.error("tab.url should be string:", tab);
        return;
    }

    if (tab.url.indexOf("chrome://") > -1 || tab.url.indexOf("about:") > -1) {
        browser.browserAction.disable(tab.id);
    } else {
        browser.browserAction.enable(tab.id);
    }
};


function postMessage(message) {
    console.log("SEND: " + JSON.stringify(message));
    
    if (!port || !message || !message.type) {
        console.error("Missing message parameters");
    }
    port.postMessage(message);
};


function sendMessage(message) {
    browser.runtime.sendMessage(message).then(
        function () {
            return true;
        }
    ).catch(logError);
};


/**
 * Forward Messages from popup.js
 */
function onMessage(message, sender, sendResponse) {
    console.log("REQUEST: " + JSON.stringify(message));
    
    if (sender.url.indexOf("/background.html") < 0 ) {
        postMessage(message);
    }
    
    return Promise.resolve();
};


/**
 * Context Menu
 */
function contextMenuCallback(info, tab) {
    let [id, action] = info.menuItemId.split(":");
    
    postMessage({
        type: "share",
        data: {
            device: id,
            url: info.linkUrl || info.srcUrl || info.frameUrl || info.pageUrl,
            action: action
        }
    });
};


function createContextMenus(tab) {
    browser.contextMenus.removeAll().then(() => {
        let contexts = ["page", "frame", "link", "image", "video", "audio"];
    
        // This is page we don't want the context menu on
        if (tab.url.indexOf("chrome://") > -1 || tab.url.indexOf("about:") > -1) {
            return;
        // There's multiple devices
        } else if (devices.length > 1) {
            browser.contextMenus.create({
                id: "contextMenuMultipleDevices",
                title: browser.i18n.getMessage("contextMenuMultipleDevices"),
                contexts: contexts
            });
            
            for (let device of devices) {
                if (device.share && device.telephony) {
                    browser.contextMenus.create({
                        id: device.id,
                        title: device.name,
                        parentId: "contextMenuMultipleDevices"
                    });
                    
                    browser.contextMenus.create({
                        id: device.id + ":share",
                        title: browser.i18n.getMessage("shareMessage"),
                        parentId: device.id,
                        contexts: contexts,
                        onclick: contextMenuCallback,
                    });
                    
                    browser.contextMenus.create({
                        id: device.id + ":telephony",
                        title: browser.i18n.getMessage("telephonyMessage"),
                        parentId: device.id,
                        contexts: contexts,
                        onclick: contextMenuCallback,
                    });
                } else {
                    let pluginAction, pluginName;
                    
                    if (device.share) {
                        pluginAction = "share";
                        pluginName = browser.i18n.getMessage("shareMessage");
                    } else {
                        pluginAction = "telephony";
                        pluginName = browser.i18n.getMessage("telephonyMessage");
                    }
                    
                    browser.contextMenus.create({
                        id: device.id + ":" + pluginAction,
                        title: browser.i18n.getMessage(
                            "contextMenuSinglePlugin",
                            [device.name, pluginName]
                        ),
                        parentId: "contextMenuMultipleDevices",
                        contexts: contexts,
                        onclick: contextMenuCallback,
                    });
                }
            }
        // There's only one device
        } else if (devices.length) {
            let device = devices[0];
                
            if (device.share && device.telephony) {
                browser.contextMenus.create({
                    id: device.id,
                    title: device.name,
                    contexts: contexts
                });
                
                browser.contextMenus.create({
                    id: device.id + ":share",
                    title: browser.i18n.getMessage("shareMessage"),
                    parentId: device.id,
                    contexts: contexts,
                    onclick: contextMenuCallback,
                });
                
                browser.contextMenus.create({
                    id: device.id + ":telephony",
                    title: browser.i18n.getMessage("telephonyMessage"),
                    parentId: device.id,
                    contexts: contexts,
                    onclick: contextMenuCallback,
                });
            } else {
                let pluginAction, pluginName;
                
                if (device.share) {
                    pluginAction = "share";
                    pluginName = browser.i18n.getMessage("shareMessage");
                } else {
                    pluginAction = "telephony";
                    pluginName = browser.i18n.getMessage("telephonyMessage");
                }
                
                browser.contextMenus.create({
                    id: device.id + ":" + pluginAction,
                    title: browser.i18n.getMessage(
                        "contextMenuSinglePlugin",
                        [device.name, pluginName]
                    ),
                    contexts: contexts,
                    onclick: contextMenuCallback,
                });
            }
        }
        
    });
};


/**
 * Message Handling
 */
function onPortMessage(message) {
    console.log("RECEIVE: " + JSON.stringify(message));
    
    // The native messaging host's connection to the service has changed
    if (message.type === "connected") {
        connected = message.data;
        
        if (connected) {
            postMessage({ type: "devices" });
        } else {
            devices = [];
        }
    // We're being sent a list of devices (so the NMH must be connected)
    } else if (message.type === "devices") {
        connected = true;
        devices = message.data;
    }
    
    browser.tabs.query({ active: true, currentWindow: true}).then((tabs) => {
        createContextMenus(tabs[0]);
    });
    
    // Forward the message to popup.html
    sendMessage(message);
    
    return Promise.resolve();
};


function resetReconnect() {
    reconnectDelay = 100;
};


function onDisconnect() {
    connected = false;
    port = null;
    browser.browserAction.setBadgeText({ text: "\u26D4" });
    browser.browserAction.setBadgeBackgroundColor({ color: [198, 40, 40, 255] });
    sendMessage({ type: "connected", data: false });
    
    // Disconnected, cancel back-off reset
    if (typeof reconnectResetTimer === "number") {
        window.clearTimeout(reconnectResetTimer);
        reconnectResetTimer = null;
    }
    
    // Don't queue more than one reconnect
    if (typeof reconnectTimer === "number") {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    var message;
    
    if (browser.runtime.lastError) {
        message = browser.runtime.lastError.message;
    }
    console.warn("Disconnected from native host: " + message);

    // Exponential back-off on reconnect
    reconnectTimer = window.setTimeout(() => {
        connect();
    }, reconnectDelay);
    reconnectDelay = reconnectDelay * 2;
    
    return Promise.resolve();
};


function connect() {
    port = browser.runtime.connectNative("org.gnome.shell.extensions.gsconnect");
    browser.browserAction.setBadgeText({ text: "" });
    browser.browserAction.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
    sendMessage({ type: "connected", data: false });
    
    // Reset the back-off delay if we stay connected
    reconnectResetTimer = window.setTimeout(() => {
        reconnectDelay = 100;
    }, reconnectDelay * 0.9);

    port.onDisconnect.addListener(onDisconnect);
    port.onMessage.addListener(onPortMessage);
    port.postMessage({ type: "devices" });
};


connect();


browser.runtime.onMessage.addListener(onMessage);

// browserAction
browser.tabs.onActivated.addListener((info) => {
    browser.tabs.get(info.tabId).then(toggleAction);
});

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    toggleAction(tab);
});

// contextMenu
browser.tabs.onActivated.addListener((info) => {
    browser.tabs.get(info.tabId).then(createContextMenus);
});

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    createContextMenus(tab);
});

