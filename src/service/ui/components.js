// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

export const MessagingInputText = GObject.registerClass({
    GTypeName: 'GSConnectMessagingTextInput',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-conversation-input-text.ui',
    Children: [
        'message-entry', 'send-text', 'emoji-button'
    ],
    Signals: {
        'message-send' : {
            param_types: [GObject.TYPE_STRING]
        },
    },
}, class MessagingInputText extends Gtk.Box {

    _init(params) {
        super._init();
        Object.assign(params);
        
        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            this._onStateChanged();
            if (keyval === Gdk.KEY_Return) {
                print("ok");
                if (state & Gdk.ModifierType.SHIFT_MASK) {
                    const text = this.message_entry.buffer.text;
                    this.message_entry.buffer.text = text + '\n';
                } else {
                    this._onSendMessage();
                    return Gdk.EVENT_STOP;
                }
            }
        });
        this.message_entry.add_controller(keyController);
    }
    
    /**
     * Handle window close request.
     *
     * @returns {boolean} False to allow the window to close.
     */
    destroy() {
        this.message_entry.buffer.disconnect(this._entryInsertedId);
        this.message_entry.buffer.disconnect(this._entryDeletedId);
        return false;
    }

    get text() {
        return this.message_entry.buffer.text;
    }

    set text(text) {
        this.message_entry.buffer.text = text;
    }
    
    get sensitive() {
        return this.message_entry.sensitive || this.send_text.sensitive || this.emoji_button.sensitive;
    }

    set sensitive(sensitive) {
        this.message_entry.sensitive = sensitive;
        this.send_text.sensitive = sensitive;
        this.emoji_button.sensitive = sensitive;
        if (sensitive == true)
            this._onStateChanged();
    }
    
    /**
     * Handle emoji selection and insert into message.
     *
     * @private
     * @param {Gtk.Widget} widget - The widget triggering the event.
     * @param {string} emoticon - The selected emoji/emoticon.
     */
    _onEmojiPicked(widget, emoticon) {
        const text = this.message_entry.buffer.text;
        this.message_entry.buffer.text = text + emoticon;
        this._onStateChanged();
    }

    _onSendMessage() {
        const text = this.message_entry.buffer.text.trim();
        if (text)
            this.emit('message-send', text);
    }

    /**
     * Update the state of the entry and send button based on connection and input.
     *
     * @private
     */
    _onStateChanged() {
        if (this.message_entry.buffer.text.trim().length) {
            this.send_text.sensitive = true;
        } else {
            this.send_text.sensitive = false;
        }
    }

});