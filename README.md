# Camera Alerts

Relays Blue Iris camera alerts to WhatsApp.

Blue Iris POSTs to this listener when a camera triggers. Snapshots go to the **Home Cameras** WhatsApp group, and video clips (fetched from Blue Iris and downscaled) go to **Home Cameras Clips**.

## How it works

The listener runs on port `1234` with two endpoints. Both return `200 OK` straight away and do the work in the background. A repeat of the same `cam` + `alert_time` that's still being processed is ignored.

### `POST /alert`: snapshot

```json
{ "cam": "Driveway", "memo": "person:87%", "image": "<base64 JPEG>", "alert_time": "..." }
```

Posts the image to **Home Cameras** with the caption `dd-MM-yy HH:mm:ss - <cam> - <memo>`.

### `POST /clip`: video clip

```json
{ "cam": "Driveway", "memo": "person:87%", "clip": "<clip path, or @-1>", "alert_time": "..." }
```

1. Logs in to the Blue Iris JSON API.
2. If `clip` is empty or `@-1`, waits until Blue Iris has indexed the alert, then uses the camera's latest one.
3. Downloads the clip. `.mp4` alert clips are fetched directly; anything else is exported to MP4 by Blue Iris first.
4. Transcodes it to 640×360 H.264/AAC with ffmpeg and posts it to **Home Cameras Clips**.

Any other request returns `404`.

## Setup

### Prerequisites

- Node.js 18+
- Chromium at `/usr/bin/chromium` or `/usr/bin/chromium-browser`. Puppeteer's bundled browser is used if neither exists.
- `ffmpeg` on the `PATH`
- A WhatsApp account to send as, which must be a member of both groups

### Install

```bash
npm install
```

### Configuration

Blue Iris connection details come from a `.env` file. It isn't in version control.

```ini
BI_HOST=<blue-iris-host>
BI_PORT=<port>
BI_USERNAME=<user>
BI_PASSWORD=<password>
```

The listener connects to Blue Iris over HTTPS and accepts its self-signed certificate. It refuses to start if any of these variables is missing.

Other settings are constants in `src/index.ts`:

| Constant | Default | Description |
|---|---|---|
| `PORT` | `1234` | Port the listener binds to |
| `WHATSAPP_GROUP` | `'Home Cameras'` | Group for snapshots |
| `WHATSAPP_CLIPS_GROUP` | `'Home Cameras Clips'` | Group for clips |
| `KNOWN_GROUP_IDS` | | Fallback group IDs (see [Known issues](#known-issues)) |

### First run (WhatsApp auth)

Run it by hand and scan the QR code with WhatsApp on your phone (**Linked devices → Link a device**):

```bash
set -a; . ./.env; set +a
npm run listener
```

The session is saved in `runtime-data/`, so later runs log in automatically.

## Production deployment (systemd)

In production it runs as `camera-alerts.service` (`/etc/systemd/system/camera-alerts.service`), as user `admin` from `/opt/camera-alerts`, with `EnvironmentFile=/opt/camera-alerts/.env` and `Restart=on-failure`. Logs go to journald.

```bash
sudo systemctl status camera-alerts
sudo systemctl restart camera-alerts
journalctl -u camera-alerts -f        # live logs
```

Two drop-ins in `/etc/systemd/system/camera-alerts.service.d/` complete the setup:

- **`notify-ready.conf`** makes the service `Type=notify` (`NotifyAccess=all`, `TimeoutStartSec=15min`). It runs `systemd-notify --ready` only after WhatsApp is linked, both groups are found and port 1234 is listening. Until then `systemctl status` shows `activating (start)`, not `active (running)`, so "running" really means connected.
- **`needs-auth.conf`** (`RestartPreventExitStatus=78`): see the next section.

Don't run `npm run listener` by hand while the service is running, because both would use the same WhatsApp session in `runtime-data/`.

### Re-authenticating under systemd

If WhatsApp isn't linked (first install, or the device was unlinked from the phone), the service doesn't try to show a QR code. It logs `WhatsApp is not linked…` or `WhatsApp was logged out…`, shuts down cleanly and exits with code 78. Systemd doesn't restart it, so `systemctl status camera-alerts` shows `failed` with `status=78/CONFIG`. To re-link:

1. `sudo systemctl stop camera-alerts`
2. From `/opt/camera-alerts` as `admin`, run it by hand (see [First run](#first-run-whatsapp-auth)) and scan the QR code. You have 5 minutes per QR code.
3. Once it logs `Listening for alerts on port 1234`, stop it with Ctrl+C and run `sudo systemctl start camera-alerts`.

If WhatsApp disconnects for any other reason, it exits with code 1 and systemd restarts it. It doesn't sit there connected to nothing and silently drop alerts.

## Troubleshooting

If alerts stop arriving:

1. **`systemctl status camera-alerts`**
   - `failed … status=78/CONFIG`: WhatsApp needs re-linking (see above).
   - `activating (auto-restart)`: it's crash-looping. Check the log.
2. **`journalctl -u camera-alerts -n 100 --no-pager`**
   - `Alert sent: …` / `Clip sent: …`: the listener is sending. If nothing arrives in WhatsApp anyway, see the first [known issue](#known-issues).
   - `WhatsApp not ready, dropping alert`: an alert arrived before WhatsApp connected.
   - `Error handling /clip …`: usually a Blue Iris login, export or ffmpeg failure. The error says which.
   - No `Alert:` lines at all: Blue Iris isn't reaching the listener. Check its alert action and the port.

## Known issues

- **Messages dropped without any error.** In September 2026 alerts stopped arriving while the log showed them sent. The cause was an old `whatsapp-web.js` fork that no longer matched current WhatsApp Web. The dependency is now pinned to a commit of the maintained [`wwebjs/whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js). If it happens again, update that pin to a recent upstream commit.
- **`getChats()` fails** on current WhatsApp Web builds, so groups can't be found by name. `getGroupID()` falls back to the hardcoded IDs in `KNOWN_GROUP_IDS`, and the log shows `falling back to known ID` at every startup; that's expected. Sending isn't affected. If a group is recreated, update its ID there. Remove the fallback once this is fixed upstream.

## Security notes

- `runtime-data/` holds the WhatsApp session tokens and `.env` holds the Blue Iris login. Both are in `.gitignore`.
- The listener binds to `0.0.0.0` with no authentication. Make sure port 1234 is only reachable from the LAN.
