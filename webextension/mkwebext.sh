#!/bin/bash

# A script for building GSConnect WebExtension zips for Chrome or Firefox.
# TODO: Mozilla Firefox extension requires node 'web-ext'

# Simple usage check
if [ "${1}" != "firefox" ] && [ "${1}" != "chrome" ] && [ "${1}" != "i18n" ]; then
    echo "Usage: mkwebext [firefox|chrome|i18n]"
    echo "Build an unsigned ZIP of the WebExtension for Chrome or Firefox."
    echo
    echo "  chrome        Build Google Chrome/Chromium Extension (unsigned zip)"
    echo "  firefox       Build Mozilla Firefox Add-on zip (unsigned zip)"
    echo "  i18n          Update translations"
    echo ""
    echo "Building the Mozilla Fireox extension requires the 'web-ext' node module."

    exit
fi

# Clean-up old files
rm -rf ${1}.zip

# Update translations
if [ "${1}" == "i18n" ]; then
    echo -n "Updating translations..."

    ./gettext.js

    echo "done"
    exit
fi

# Copy relevant files
mkdir ${1}

mkdir ${1}/images
cp -R js ${1}/
cp -R _locales ${1}/
cp background.html ${1}/
cp manifest.${1}.json ${1}/manifest.json
cp popup.html ${1}/
cp stylesheet.css ${1}/

# Build Mozilla Firefox Add-on
if [ "${1}" == "firefox" ]; then
    echo -n "Building Mozilla Firefox Add-on..."

    # Firefox only needs SVG
    cp -R images/*.svg ${1}/images

    # Make the ZIP
    ~/node_modules/.bin/web-ext -s ${1} build > /dev/null 2>&1
    mv web-ext-artifacts/gsconnect-*.zip ${1}.zip

    # Cleanup
    rm -rf ${1} web-ext-artifacts

# Build Google Chrome/Chromium Extension
elif [ "${1}" == "chrome" ]; then
    echo -n "Building Google Chrome/Chromium Extension..."

    # Chrome needs SVG and PNG
    cp -R images/* ${1}/images/

    # Make the ZIP
    cd chrome/
    zip -r ../chrome.zip *

    # Cleanup
    cd ..
    rm -rf ${1}
fi

echo "done"
echo ""
echo "WebExtension saved as '${1}.zip'"
