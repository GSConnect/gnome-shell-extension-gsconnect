var connected = false;
var currentUrl = null;
var devices = [];


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


function sendMessage(message) {
    browser.runtime.sendMessage(message).then(() => {
        return true;
    }).catch(logError);
};


function sendUrl(device, url) {
    let [id, action] = device.split(":");
    
    sendMessage({
        type: "share",
        data: {
            device: id,
            url: url,
            action: action
        }
    });
    window.close();
};


function sendUrlCallback(target, url) {
    return () => { sendUrl(target, url); };
};


function addDevice(device) {
    let deviceElement = document.createElement("div");
    deviceElement.className = "device";
    
    let deviceIcon = document.createElement("img");
    deviceIcon.className = "device-icon";
    deviceIcon.src = "images/" + device.type + ".svg";
    deviceElement.appendChild(deviceIcon);
    
    let deviceName = document.createElement("span");
    deviceName.className = "device-name";
    deviceName.textContent = device.name;
    deviceElement.appendChild(deviceName);
    
    if (device.share) {
        let shareButton = document.createElement("img");
        shareButton.className = "plugin-button";
        shareButton.src = "images/open-in-browser.svg";
        shareButton.title = browser.i18n.getMessage("shareMessage");
        shareButton.addEventListener(
            "click", sendUrlCallback(device.id + ":share", currentUrl)
        );
        deviceElement.appendChild(shareButton);
    }
    
    if (device.telephony) {
        let telephonyButton = document.createElement("img");
        telephonyButton.className = "plugin-button";
        telephonyButton.src = "images/message.svg";
        telephonyButton.title = browser.i18n.getMessage("telephonyMessage");
        telephonyButton.addEventListener(
            "click", sendUrlCallback(device.id + ":telephony", currentUrl)
        );
        deviceElement.appendChild(telephonyButton);
    }
    
    return deviceElement;
};


function setPopup() {
    let devNode = document.getElementById("popup");
    
    while (devNode.hasChildNodes()) {
        devNode.removeChild(devNode.lastChild);
    }
    
    // The native messaging host is disconnected, or we're disconnected from it
    if (!connected) {
        let noDevices = document.createElement("span");
        noDevices.className = "popup-menu-disconnected";
        noDevices.textContent = browser.i18n.getMessage("popupMenuDisconnected");
        devNode.appendChild(noDevices);
    } else if (devices.length) {
        for (let device of devices) {
            devNode.appendChild(addDevice(device));
        }
    } else {
        let noDevices = document.createElement("span");
        noDevices.className = "popup-menu-no-devices";
        noDevices.textContent = browser.i18n.getMessage("popupMenuNoDevices");
        devNode.appendChild(noDevices);
    }
};


function onMessage(message, sender) {
    console.log("onMessage: " + JSON.stringify(message));
    
    if (sender.url.indexOf("/background.html") > -1) {
        if (message.type === "connected") {
            connected = message.data;
        } else if (message.type === "devices") {
            connected = true;
            devices = message.data;
        }
        
        setPopup();
    }
    
    return Promise.resolve();
};


function getCurrentTab(callback) {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs.length) {
            callback(tabs[0]);
        }
    });
};


document.addEventListener("DOMContentLoaded", () => {
    setPopup();
    sendMessage({ type: "devices" });
    
    getCurrentTab((tab) => {
        if (tab) {
            currentUrl = tab.url;
        }
    });
});


browser.runtime.onMessage.addListener(onMessage);

