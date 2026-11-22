# Getting started

In this tutorial, you install vylk on your computer, open it in your web browser, and write your first note. You need about ten minutes and permission to install programs on your computer.

vylk is a notes app that you run yourself. It has two parts:

- The vylk program runs on your computer and stores your notes.
- Your web browser shows the app. You write and read your notes there.

The program must keep running while you use the app. To learn more, read [How vylk works](concepts.md).

## Install vylk

Find the section for your computer and follow its steps. Each section ends with the command that starts vylk.

In each start command, replace `replace-with-your-password` with a password that you choose. You use this password to sign in to vylk. Keep the quotes around it.

### Ubuntu or Debian

1. Open the **Terminal** app.
2. Add the toxdes package repository. You do this only once.

```sh
sudo apt update && sudo apt install -y ca-certificates curl gnupg && curl -fsSL https://packages.toxdes.com/apt/pubkey.gpg | sudo gpg --dearmor --yes -o /usr/share/keyrings/toxdes-archive-keyring.gpg && echo "deb [signed-by=/usr/share/keyrings/toxdes-archive-keyring.gpg] https://packages.toxdes.com/apt stable main" | sudo tee /etc/apt/sources.list.d/toxdes.list && sudo apt update
```

3. Install vylk.

```sh
sudo apt install vylk
```

4. Start vylk.

```sh
VYLK_PASSWORD='replace-with-your-password' vylk
```

### Fedora

1. Open the **Terminal** app.
2. Add the toxdes package repository. You do this only once.

```sh
printf '%s\n' '[toxdes]' 'name=Toxdes' 'baseurl=https://packages.toxdes.com/rpm' 'enabled=1' 'gpgcheck=1' 'repo_gpgcheck=1' 'gpgkey=https://packages.toxdes.com/rpm/pubkey.gpg' | sudo tee /etc/yum.repos.d/toxdes.repo
```

3. Install vylk.

```sh
sudo dnf install vylk
```

4. Start vylk.

```sh
VYLK_PASSWORD='replace-with-your-password' vylk
```

### Arch Linux

1. Open a terminal.
2. Install the `vylk-bin` package from the AUR. The `vylk` package builds the latest release from source, and `vylk-git` builds the newest development code.

```sh
yay -S vylk-bin
```

3. Start vylk.

```sh
VYLK_PASSWORD='replace-with-your-password' vylk
```

### Other Linux systems

1. Open a terminal.
2. Download vylk and install it to `/usr/bin/vylk`. For an ARM processor, replace `amd64` with `arm64`.

```sh
curl -fsSL https://packages.toxdes.com/releases/vylk___VYLK_VERSION___amd64.tar.gz | sudo tar xzC /
```

3. Start vylk.

```sh
VYLK_PASSWORD='replace-with-your-password' vylk
```

### macOS

1. Open the **Terminal** app.
2. Install vylk with [Homebrew](https://brew.sh).

```sh
brew install toxdes/tap/vylk
```

3. Start vylk.

```sh
VYLK_PASSWORD='replace-with-your-password' vylk
```

If you do not use Homebrew, download the ZIP file for your Mac instead. Use [Apple silicon](https://packages.toxdes.com/releases/vylk-__VYLK_VERSION__-macos-arm64.zip) for an M-series processor and [Intel](https://packages.toxdes.com/releases/vylk-__VYLK_VERSION__-macos-amd64.zip) for an Intel processor. Extract it, open **Terminal** in the extracted folder, and start vylk with `./vylk` in place of `vylk`.

### Windows

1. Download [vylk for Windows](https://packages.toxdes.com/releases/vylk_windows_amd64___VYLK_VERSION__.exe).
2. Open the folder that contains the downloaded file.
3. Right-click an empty area of the folder, and then select **Open in Terminal**.
4. Set your password.

```powershell
$env:VYLK_PASSWORD="replace-with-your-password"
```

5. Start vylk.

```powershell
.\vylk_windows_amd64___VYLK_VERSION__.exe
```

### Docker

If you already use Docker, you can run vylk in a container on Linux, macOS, or Windows. The `vylk-data` volume keeps your notes when you replace the container.

```sh
docker run -d --name vylk -p 127.0.0.1:8080:8080 -e VYLK_PASSWORD='replace-with-your-password' -v vylk-data:/data toxdes/vylk:__VYLK_VERSION__
```

The container does not open your browser. Go to the next section and open the address yourself.

## Open vylk

When vylk starts, it prints a line like this one:

```text
vylk running on :8080 (notes: /home/you/notes, db: ./vylk.db)
```

vylk also opens `http://127.0.0.1:8080` in your web browser. If no browser window opens, go to [http://localhost:8080](http://localhost:8080) yourself.

You see the **Password** field.

1. Enter the password from your start command.
2. Select **Sign in**.

You see your notes list. It is empty.

If the terminal shows `address already in use`, another program uses port 8080. Start vylk on another port. For example, put `PORT=8081` before `VYLK_PASSWORD` in the start command, and then open `http://localhost:8081`.

## Write your first note

1. Select **+ New note**.
2. In **Title**, enter `Shopping list`.
3. In **Tags**, enter `home`.
4. In the large text area, enter this text:

```markdown
- [ ] Bread
- [ ] **Milk**
```

This text is Markdown, a simple way to format plain text. You can also select text and use the toolbar buttons above the editor, such as **Bold** and **Task list**.

5. Select the **Split view** button above the editor. Hold the pointer over a button to see its name.

The preview opens next to the editor. It shows two checkboxes, and "Milk" is in bold.

6. In the preview, select the checkbox next to "Bread".

The text in the editor changes to `- [x] Bread`. vylk saves your note as you type. The status next to the note shows **Saved** when the note is stored.

7. Select the **Back to notes** arrow.

Your note is in the list, with the `home` tag. Above the list, select **home** to show only the notes that have that tag. Select **All** to show every note again.

## Stop and restart vylk

1. In the terminal, press `Ctrl+C`.

The terminal shows `shutting down...`, and vylk stops. The app in your browser stops working until you start vylk again. Your notes stay on your computer.

2. Run the start command again from the same folder.

Your note is still there. vylk keeps notes in the `notes` folder and the `vylk.db` file, inside the folder where you started it. Start vylk from the same folder every time, or vylk starts with an empty notes list.

For Docker, use `docker stop vylk` and `docker start vylk`.

## Next steps

- [Use vylk on your phone and other devices](how-to.md#open-vylk-on-another-device).
- [Back up your notes](how-to.md#back-up-your-notes).
- [Turn on end-to-end encryption](how-to.md#turn-on-encryption).
- Browse all [how-to guides](how-to.md).
