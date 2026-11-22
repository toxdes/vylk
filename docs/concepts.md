# How vylk works

vylk is a notes app for one person. You run the vylk program on a computer that you control, and you use the app in a web browser.

## The program and the app

The vylk program is a small web server. It stores your notes and sends them to the app. The app is the page that you open in your browser at an address such as `http://localhost:8080`.

The program and the browser can be on the same computer or on different devices. For example, vylk can run on a home server while you write on your laptop and your phone. Every device uses the same notes.

vylk has no user accounts. One password protects the whole app, and everyone who knows that password can read and change every note. vylk does not support shared notebooks or several users.

## Where your notes are stored

vylk keeps your notes in two places on the computer that runs the program:

- The notes folder holds one file for each note. The file contains the note text in Markdown. Its name is the note ID, such as `0f2e4f4b1e33db362bc94813757060bd.md`. You can open these files in any text editor.
- The database file, `vylk.db`, holds everything else. This includes note titles, tags, pins, your preferences, signed-in devices, and the history that vylk uses to sync your devices.

Neither part is complete without the other. A backup must contain both, copied at the same time. To find out how, read [Back up your notes](how-to.md#back-up-your-notes).

By default, both are in the folder where you start vylk. To choose other locations, set `VYLK_DIR` and `VYLK_DB`. The [command-line reference](cli-reference.md#environment-variables) lists every setting.

When you turn on encryption, the notes folder and the database store titles, tags, and note text in encrypted form. For details, read [End-to-end encryption](encryption.md).

## Devices

vylk calls each browser profile a device. All tabs and windows of one browser profile are one device. Two browsers on the same computer are two devices.

When you sign in, the device stays signed in for 180 days. vylk extends that period while you use the device. To see every signed-in device, open **Preferences**, and then select **Account**. You can sign out any device from that list.

Each device also keeps a copy of your notes. Signing out does not delete this copy. Anyone who uses that browser profile can read it unless you turn on encryption.

## Saving and sync

When you type, the app saves the note on your device first. It then sends the change to the vylk program, which passes it on to your other devices. The status next to the note shows where the change is:

- **Saving** means that the change is on this device and is waiting to reach the program.
- **Saved** means that the program has the change.
- **Offline** means that the device cannot reach the program. Your changes stay on this device until it reconnects.

Each open app keeps a connection to the program. The program sends a signal on this connection every 25 seconds. If the app receives nothing for 70 seconds, it shows that you are offline. When the connection returns, the app downloads the changes that it missed and then sends the changes that it kept.

Do not clear your browser data while changes are waiting. Clearing it deletes those changes.

## Offline use

After you sign in once, a device can open the app and edit notes without a connection to the program. The app stores itself and your notes in the browser. New notes, edits, and deletions wait on the device and sync when the device reconnects.

The browser can store the app only when you open vylk over HTTPS or on `localhost`. On a plain `http://` address of another computer, the app needs a connection to load. To set up HTTPS, read [Set up HTTPS](how-to.md#set-up-https).

## Conflicting edits

Two devices can change the same note before either one syncs. For example, you edit a note on your phone while it is offline and also edit it on your laptop. When the phone reconnects, vylk compares both versions with the version that they started from.

If the devices changed different lines, vylk combines the changes. It also combines a title or tag change made on only one device. If both devices changed the same part of the note, vylk shows **Resolve conflicting edits**. To find out what to do there, read [Resolve conflicting edits](how-to.md#resolve-conflicting-edits).

## When the database changes

Each vylk database has its own identity. Your devices remember the identity of the database that they synced with. If you start vylk with a different database at the same address, every device notices the new identity, stops syncing, and shows **Notes database changed**.

This protects the changes that are waiting on the device. vylk does not send them to the wrong database, and it does not delete them without your choice. To find out what to do, read [Respond to "Notes database changed"](how-to.md#respond-to-notes-database-changed).

An older backup of the same database has the same identity. If you restore one, devices do not show this message.
