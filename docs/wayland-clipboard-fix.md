# Wayland Clipboard Sync Fix (GNOME 46-50)

## Issue Description
On modern Wayland sessions (specifically tested on GNOME 49), pushing clipboard data from an Android device to the desktop via GSConnect fails silently. 

When the Android device pushes the clipboard payload, `journalctl` logs the following crash in the background daemon:
`_onHandleMethodCall@file:///[...]/shell/clipboard.js:140:30`

### Root Cause
The `SetText(text)` function originally relied exclusively on `Meta.SelectionSourceMemory.new`. In modern Wayland security models, background processes lacking explicit window focus are denied permission to set the clipboard via the `Meta.Selection` API, causing a silent rejection and failure to sync.

## The Solution
To bypass the strict Wayland background window restriction while remaining native to the GNOME environment, the logic was refactored to utilize the Shell's UI toolkit clipboard API (`St.Clipboard`).

### Code Changes
1. **Imported the St library:**
   `import St from 'gi://St';`
2. **Refactored `SetText(text)` logic:**
   The function now attempts to grab the default `St.Clipboard` and set the text natively:
   ```javascript
   const clipboard = St.Clipboard.get_default();
   clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
   ```
3. **Graceful Fallback:**
   Because `St.Clipboard.set_text` fails silently (returns void without throwing exceptions) when denied by Wayland, the logic verifies the write by reading the clipboard back immediately. If the text does not match, it falls back to the original `Meta.SelectionSourceMemory` implementation.

## Testing
This fix was locally patched and verified working on **GNOME 49.4 (Wayland)**. Both Android-to-PC and PC-to-Android clipboard syncing operate seamlessly.
