# How-to guides

If you have not used vylk before, start with [Getting started](getting-started.md).

## Write and organize

### Organize notes with tags

1. Open a note.
2. In **Tags**, enter one or more tags, separated by commas. For example, enter `home, recipes`.
3. Select **Back to notes**.

The tags appear above the notes list. Select a tag to show only the notes that have it. Select **All** to show every note.

If **Tags** is not visible, select **Details** above the editor.

### Link one note to another

1. In the note text, enter the title of another note between double square brackets. For example, enter `[[Shopping list]]`.
2. In the preview, select the link.

vylk opens the note with that title. Upper and lower case do not matter. If no note has that title, vylk creates a new note with that title and opens it.

### Pin a note to the top of the list

In the notes list, select **Pin note** on the note. Pinned notes appear first. The other notes follow, with the most recently changed note first. To unpin a note, select **Unpin note**.

### Choose a view

Use the buttons above the editor to change how a note is shown.

| View             | Shows                                        | Shortcut |
| ---------------- | -------------------------------------------- | -------- |
| **Write view**   | The Markdown text only                       | `Ctrl+1` |
| **Preview view** | The formatted note only                      | `Ctrl+2` |
| **Split view**   | The text and the formatted note side by side | `Ctrl+3` |
| Zen mode         | One page without other controls              | `Ctrl+4` |

On macOS, use `Command` in place of `Ctrl`.

In Split view, drag the bar between the two panes to change their widths. In the preview, you can select task checkboxes and drag blocks to change their order. To leave Zen mode, select **Exit Zen mode**.

To choose the view that opens with each note, open **Preferences**, select **Editor**, and change **Open notes in**.

### Change how vylk looks

1. Select **Preferences**.
2. Select **Appearance** to change the theme, the accent color, the interface font, and the content width.
3. Select **Editor** to change the editor and preview fonts, the toolbar, and the save controls.
4. Select **Zen mode** to change the Zen mode font, the page width, and the word count.

vylk saves each change at once and applies it to all your devices. To undo all changes, select **Account**, select **Restore default settings**, and then select **Restore settings**. Your notes do not change.

### Use keyboard shortcuts

Some shortcuts are a key combination. Others are a sequence: press the prefix `Ctrl+E`, release it, and then press one more key.

| Action                                    | Shortcut           |
| ----------------------------------------- | ------------------ |
| Save the note now                         | `Ctrl+S`           |
| Bold                                      | `Ctrl+B`           |
| Italic                                    | `Ctrl+I`           |
| Create a note                             | `Ctrl+E`, then `N` |
| Open preferences                          | `Ctrl+E`, then `P` |
| Edit the title                            | `Ctrl+E`, then `T` |
| Edit the tags                             | `Ctrl+E`, then `G` |
| Return to the editor                      | `Ctrl+E`, then `E` |
| Switch between the editor and the preview | `Ctrl+E`, then `4` |
| Open AI Assist, when it is on             | `Ctrl+E`, then `A` |

On macOS, use `Command` in place of `Ctrl`.

To change a shortcut or the prefix, open **Preferences** and select **Shortcuts**.

## AI Assist

AI Assist sends text from a note to an AI service that you choose. The AI can answer questions and suggest changes. vylk changes the note only when you accept a suggestion. AI Assist is off until you turn it on.

### Set up AI Assist

You need an API key from an AI service. A chat subscription, such as ChatGPT Plus or Claude Pro, does not include an API key. The service bills API use separately.

1. Create an API key on the website of the service.
2. In vylk, open **Preferences**, select **AI**, and turn on **Enable AI Assist**.
3. Select **Add configuration**.
4. Enter a **Name**, the **Endpoint**, the **Model**, and the **API Key**. Use the endpoint from the table. For a model name, see the website of the service or [models.dev](https://models.dev/).
5. Select **Test**. When **OK** appears, select **Save**.

| Service    | Endpoint                       |
| ---------- | ------------------------------ |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI     | `https://api.openai.com/v1`    |
| Anthropic  | `https://api.anthropic.com/v1` |

Other services that support the OpenAI API format also work, including a model that runs on your own computer. The first configuration that you save after a successful test becomes the default. To use another configuration, select **Set default** next to it.

### Ask the AI about a note

1. Open a note in Write view. AI Assist is not available in the other views.
2. Select **Open AI**, or press `Ctrl+E`, then `A`. To ask about part of the note, select the text first and then select **Ask AI**.
3. Choose what the AI can read: **No note text**, **Selected text**, or **Entire note**.
4. Type your request and press `Enter`.
5. Review each suggested change. Select **Accept change** or **Reject change**, or select **Accept all**. vylk saves each accepted change to the note.

The AI does not see the title, the tags, or text that you did not share. vylk sends the shared text and your messages through your vylk server to the AI service. This includes encrypted notes: vylk decrypts the shared text on your device before it sends it. The server keeps API keys in its database, so keep your backups private.

## Use other devices

### Open vylk on another device

Use this method for a phone, a tablet, or another computer on the same network. It works only while encryption is off. With encryption on, [set up HTTPS](#set-up-https) first.

1. Find the local IP address of the computer that runs vylk, such as `192.168.1.10`.
2. Allow incoming connections to port `8080` in that computer's firewall.
3. On the other device, open `http://192.168.1.10:8080`. Use your own address.
4. Sign in with your vylk password.

On a plain `http://` address, anyone on the network can read your password and notes as they travel. Use this method only on a network that you trust. If you run vylk in Docker with `-p 127.0.0.1:8080:8080`, other devices cannot connect. Use a reverse proxy, or change the option to `-p 8080:8080`.

### Set up HTTPS

You need HTTPS to use encryption from other devices, to install vylk as an app, and to use vylk offline on other devices. vylk does not create certificates. A reverse proxy, such as [Caddy](https://caddyserver.com), receives HTTPS connections and forwards them to vylk.

This example assumes that you have a domain name, such as `notes.example.com`, that points to your server. Caddy gets a certificate for it.

1. Install Caddy on the computer that runs vylk.
2. Put these lines in the Caddy configuration file, `Caddyfile`.

```text
notes.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

3. Start vylk with `VYLK_TRUST_PROXY=1`. With this setting, vylk reads the client address and the HTTPS status from the headers that Caddy adds.
4. Block port `8080` in the firewall, so that devices connect only through Caddy.
5. Open `https://notes.example.com` on each device.

Every device must trust the certificate. A certificate for a public domain name, such as the one that Caddy gets, is trusted by default.

### Install vylk as an app

You can add vylk to the home screen of a phone or to the app list of a computer. The address must use HTTPS, or `localhost` on the computer that runs vylk.

- In Chrome or Edge on a computer, select the install icon in the address bar.
- In Chrome on Android, open the menu, and then select **Add to Home screen** or **Install app**.
- In Safari on iPhone or iPad, select **Share**, and then select **Add to Home Screen**.

### Use vylk offline

1. Open vylk over HTTPS, or on `localhost`, on the device.
2. Sign in while the device can reach vylk.

You can now open vylk and edit notes on that device without a connection. The status shows **Offline**. Your changes sync when the device reconnects. Do not clear the browser data for vylk while the status shows **Offline** or **Saving**, or you lose those changes.

### Sign out a device

1. Open **Preferences**, and then select **Account**.
2. Find the device in **Devices**. The current device shows **This device**.
3. Select **Sign out** next to the device.
4. Select **Sign out** again to confirm.

A device that is offline signs out when it reconnects. Signing out does not delete the notes that the device already has. If you lost a device and encryption is on, also [change your password](#change-your-password).

## Encryption

### Turn on encryption

Before you start:

- [Back up your notes](#back-up-your-notes).
- Open vylk over HTTPS, or on `localhost` on the computer that runs vylk.
- Keep the setup window open until it finishes. It can take several minutes for many notes.

To turn on encryption:

1. Open **Preferences**, and then select **Encryption**.
2. Select **Set up encryption**.
3. In **Current password**, enter your vylk password, and then select **Continue**.
4. Write down the 24 words of your recovery key, or select **Download recovery key**. Keep the recovery key away from the computer that runs vylk.
5. Select **I've saved my key**.
6. Enter the 24 words in order, one at a time.
7. Select **Encrypt notes**.

When setup finishes, every device is signed out. Sign in again with the same password. Then:

1. Restart vylk.
2. [Change your password](#change-your-password). Until you do, the server's `VYLK_PASSWORD` setting can unlock your notes.
3. Open vylk on each of your other devices and sign in. Each device encrypts its stored notes when you sign in.

For an explanation of what encryption protects, read [End-to-end encryption](encryption.md).

### Resume encryption setup

If setup stopped before it finished, vylk keeps your notes readable but does not save changes to them.

1. Open **Preferences**, and then select **Encryption**.
2. Select **Resume encryption**.
3. Enter your vylk password, the password used when setup started, and the recovery key from that setup.

### Sign in with your recovery key

1. On the sign-in page, select **Forgot password?**.
2. Select **I have my recovery key**.
3. Enter the 24 words in order, or paste the whole key.
4. Select **Sign in**.

vylk asks you to change your password. Select **Change password** and choose a new one.

### Change your password

1. Open **Preferences**, and then select **Encryption**.
2. Select **Change password**.
3. Select **I know my encryption password** or **I have my recovery key**, and enter it.
4. Enter the new password in **New password** and **Repeat new password**.
5. To keep other devices signed in, clear **Sign out other devices**.
6. Select **Save password**.

Use the new password to sign in on every device. Your recovery key does not change.

### Replace your recovery key

Replace the recovery key if someone else might have seen it.

1. Open **Preferences**, and then select **Encryption**.
2. Select **Change recovery key**.
3. Confirm that it is you with your password or your current recovery key.
4. Write down or download the new 24 words, and then confirm them.
5. Select **Save recovery key**.

The old recovery key stops working. Your other devices are signed out.

### If you lose your password and recovery key

Nobody can decrypt your notes, and a backup does not help, because the backup is encrypted too. To use vylk again, start with an empty notes list:

1. Stop vylk.
2. Move the notes folder and the `vylk.db` file to another folder. Do not delete them if you might find your password or recovery key later.
3. Start vylk.

vylk starts with no notes and no encryption. Each device shows **Notes database changed**. Select **Switch** on each device.

## Keep your notes safe

### Back up your notes

A backup must contain the notes folder and the database file from the same moment.

1. Stop vylk.
2. Copy the notes folder and the `vylk.db` file to your backup location. If the files `vylk.db-wal` and `vylk.db-shm` exist, copy them too.
3. Start vylk.

If vylk runs in Docker, copy the `vylk-data` volume:

```sh
docker stop vylk
docker run --rm -v vylk-data:/data -v "$PWD":/backup alpine tar czf /backup/vylk-backup.tar.gz -C /data .
docker start vylk
```

The file `vylk-backup.tar.gz` is created in the current folder. If encryption is on, keep your password or recovery key separately from the backup. You need one of them to read the backup.

### Restore a backup

1. Stop vylk.
2. Move the current notes folder and `vylk.db` file to another folder.
3. Copy the notes folder and the database files from the backup to their places.
4. Start vylk.
5. Reload vylk on each device.

If the backup came from another installation, each device shows **Notes database changed**. See the next guide.

### Respond to "Notes database changed"

vylk shows this message when the address now serves a different database than the one that the device synced with. For an explanation, read [When the database changes](concepts.md#when-the-database-changes).

- Select **Keep changes** if the device has changes that you want to keep. Then restart vylk with the earlier notes folder and database, and reload the page. The changes sync to that database.
- Select **Switch** to use the new database. This deletes the notes and the unsynced changes stored on this device. Notes stored by the program are not affected. You then sign in again.

### Resolve conflicting edits

vylk shows **Resolve conflicting edits** when two devices changed the same part of a note.

1. Compare **This device** and **Other device**.
2. Select **Use this device** or **Use other device**. You can then edit the result in **Merged note to save**. To see the text that both versions started from, select **Show the common original**.
3. Select **Save resolution**.

To keep both versions, select **Keep as copy**. To decide later, select **Resolve later**. The note keeps a conflict mark until you resolve it.

### Update vylk

Updates keep your notes and settings.

- Ubuntu or Debian: run `sudo apt update && sudo apt upgrade vylk`.
- Fedora: run `sudo dnf upgrade vylk`.
- Arch Linux: run `yay -Syu vylk-bin`.
- macOS with Homebrew: run `brew update && brew upgrade vylk`.
- Downloaded program: download the new version and replace the old file.
- Docker: remove the container with `docker rm -f vylk`. Then run your `docker run` command again with the new version tag. Keep the same volume.

After you update, restart vylk, and then reload vylk on each device.

### Move vylk to another computer

1. On the old computer, [back up your notes](#back-up-your-notes).
2. On the new computer, [install vylk](getting-started.md#install-vylk).
3. Copy the notes folder and the database files to the folder where you will start vylk.
4. Start vylk with the same password.

Your devices keep their notes and sync with the new computer if they use the same address. If the address changes, sign in at the new address on each device.

## Run vylk on a server

### Read the password from a file

Use `VYLK_PASSWORD_FILE` to keep the password out of the command line and the environment, for example with Docker secrets.

```sh
printf '%s' 'replace-with-your-password' > vylk-password
chmod 600 vylk-password
docker run -d --name vylk -p 127.0.0.1:8080:8080 -v vylk-data:/data -v "$PWD/vylk-password":/run/secrets/vylk_password:ro -e VYLK_PASSWORD_FILE=/run/secrets/vylk_password toxdes/vylk:__VYLK_VERSION__
```

### Run vylk without opening a browser

On a server without a screen, start vylk with `--no-browser`, or set `VYLK_NO_BROWSER=1`.

### Run a public demo

Set `VYLK_DISABLE_VAULT_CHANGES=true`. Visitors can still sign in and change notes, but they cannot turn on encryption, change the password or recovery key, or sign out other devices. For every setting, see the [command-line reference](cli-reference.md#environment-variables).
