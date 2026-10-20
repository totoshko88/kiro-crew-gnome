/* confirm.js — one modal "are you sure?" dialog at a time. */

import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';

export class Confirmation {
    constructor() {
        this._dialog = null;
        this._dialogDestroyId = 0;
    }

    /** Show the dialog; onConfirm runs only when the action button is pressed. */
    ask({title, description, actionLabel}, onConfirm) {
        this._close();
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
                default: true
            },
            {
                label: actionLabel,
                action: () => {
                    dialog.close();
                    onConfirm();
                }
            }
        ]);
        this._dialogDestroyId = dialog.connect('destroy', () => {
            this._dialogDestroyId = 0;
            this._dialog = null;
        });
        this._dialog = dialog;
        dialog.open();
    }

    _close() {
        if (!this._dialog)
            return;
        this._dialog.disconnect(this._dialogDestroyId);
        this._dialogDestroyId = 0;
        this._dialog.destroy();
        this._dialog = null;
    }

    destroy() {
        this._close();
    }
}
