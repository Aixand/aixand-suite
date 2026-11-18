# Prepare and pair a receiving companion

Prepare a Python 3.11+ receiver on Windows, macOS or Linux. The CLI commands below remain receiver setup examples. The Suite Devices/chat steps are a retained integration qualification procedure: [current Server handlers are absent](../reference/status.md), so this is not an available end-to-end UI workflow. Do not infer pairing or delivery from the UI alone.

## Set up

1. Connect the **Suite host and receiving computers** to the same NetBird account.
   Being able to list a peer through the API does not prove that the Suite host
   can connect to it.
2. Open **Suite → Settings → Devices**. Save your NetBird HTTPS API URL and a
   service-user API token permitted to read peers. The default URL is
   `https://api.netbird.io/api`; a self-hosted HTTPS API is also supported.
3. Expand **Pair a device** and download `aixand-connect.pyz` on the receiving
   computer. Install Python 3.11+ if needed.
4. Start the companion on that computer using its **NetBird IPv4 address** and
   the folder where files should arrive:

   Linux/macOS:

   ```sh
   python3 aixand-connect.pyz --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" --pair
   ```

   Windows PowerShell:

   ```powershell
   py -3 aixand-connect.pyz --bind 100.80.1.2 --receive-dir "$env:USERPROFILE\Downloads\Aixand" --pair
   ```

   Substitute the actual NetBird address. The receiving folder is created if
   absent. Keep the process running; this MVP does not install a background
   service. Restart with the same arguments **without `--pair`** to retain pairing.
5. Permit TCP **47831** from the Suite host to the receiver in NetBird's access
   policy and the device's host firewall. A different port can be selected with
   `--port` and entered in Suite's pairing form.
6. In Suite, load NetBird devices, select the receiver, choose a unique name,
   and enter the one-time pairing code displayed by the companion. The code
   expires after ten minutes and is never entered in chat.
7. Open a native chat associated with a saved project and ask:

   > Copy `dist/app.zip` to my Windows PC.

The source is on the **Suite host**, inside that chat's project. Files on the
computer running your browser must first be uploaded into the project through
another mechanism. A scratch chat without a saved project cannot send files.

To change a receiving folder or regenerate pairing, stop the companion, restart
with the desired folder and `--pair`, and pair the device again in Suite. Pairing
replaces its previous Suite credential. One receiver pairs with one Suite owner.
Only one receiver process can use a state directory at a time.

## Verify your first transfer

Run this human smoke check only after Server routing is restored and qualified.

Create a small disposable text file in the chat's saved project on the Suite
host. Ask the chat to send it to the paired device. Confirm the destination
exists and its contents match. Suite should report verified delivery, not only
upload progress. If the acknowledgment is lost, use **Check delivery** to inspect
the retained receipt before attempting another send.

Stop the companion with Ctrl+C when finished. Delivered files remain on the
receiver; remove only your disposable test file when no longer needed. Keep the
same state directory and omit `--pair` when restarting an established pairing.
The companion installs no automatic login service. If persistent access is wanted,
review an OS-specific startup plan with the user before changing startup settings.

## Configure direct Codex

Install and sign in to Codex on the remote computer (`codex login`). Update its
companion download, stop the old process, and add `--project-root` when restarting.
For example, on a Homebrew Mac with Python 3.11+:

```sh
/opt/homebrew/bin/python3 "$HOME/dev/aixand-connect.pyz" \
  --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" \
  --project-root "$HOME/dev"
```

Use that computer's actual NetBird address. Omit `--pair` to preserve the existing
pairing. `--project-root` must already exist and can be repeated. `--codex` selects
an explicit executable if it is not on PATH or in a standard installation location.
Keep the companion running; automatic startup at login is not installed by this MVP.

The retained UI entry is **Direct Codex · native login**. Its application route is unavailable in this checkout. See the [direct session contract](../integrations/direct-codex.md) for approval, reconnect and process ownership.

## Configure a manager interpreter

Install optional packages in the selected manager environment with `python -m pip install "aixand-suite-connect[managers]"`. Compatible Agent Manager and Conversation Manager packages and the device's native Codex executable are required on macOS/Linux; Server Manager and Undercurrent are not required for this chat helper.

Connect discovers Python environments through installed manager CLI scripts.
If the SDK is in another environment, select its interpreter explicitly:

```sh
python3 "$HOME/dev/aixand-connect.pyz" \
  --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" \
  --project-root "$HOME/dev" \
  --manager-python "$HOME/.aixand/connect/manager-env/bin/python"
```

Keep the usual bind, receive directory, project roots and state directory when
restarting; omit `--pair` to preserve pairing. SDK installation and the runtime
remain device administration tasks. Discovery is cached for up to 30 seconds.

The retained inventory UI is **Settings → Devices → Managers on this device → Check managers**. It lists Agent, Conversation, MCP, Prompt and Skill packages without launching a worker. Current Server routing must be restored before using that UI. Installed packages do not establish authentication or provider readiness. See [managed ownership and selection](../integrations/managers.md).
