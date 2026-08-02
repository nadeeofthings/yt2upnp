# Release v1.2.0

## Release Title
v1.2.0 — Persistent Speaker Registry, On-Demand SSDP Scanning & Custom Speaker Naming

---

## Release Notes

## 🚀 What's New in v1.2.0

### 💾 Persistent Speaker Registry
- **Saved Devices (`data/devices.json`)**: All discovered speakers are now saved permanently to configuration storage. On container restart, all remembered speakers start up instantly without waiting for network discovery scans.
- **Offline Device Visibility**: The Web Dashboard keeps track of saved speakers and clearly displays their `Online`/`Offline` status.

### 🔍 On-Demand SSDP Scanning (No Background Scans)
- **"Scan for Speakers" Button**: Removed periodic 60-second background SSDP scans that could disrupt Wi-Fi connections or tear down active bridges. You can now trigger a focused 10-second SSDP scan anytime directly from the Web Dashboard when adding new speakers.
- **Initial Auto-Scan**: On first installation (when no saved devices exist), `yt2upnp` automatically runs an initial 10-second scan to get you up and running without manual steps.

### ✏️ Custom Friendly Speaker Naming
- **Custom Display Names**: Click the edit button (✏️) next to any speaker in the Web Dashboard to assign a custom display name (e.g., shorten *"Sonos Play 3: Kitchen"* to *"Kitchen"*).
- **Real-Time Cast Target Updates**: Renaming a speaker automatically restarts its bridge on the same port and updates the receiver name shown in your mobile YouTube Music cast menu.
- **Speaker Removal**: Click the delete button (🗑️) to forget unwanted or decommissioned speakers from your configuration.

---

## 📦 Upgrading

To update your running Docker container on Unraid or Linux:

```bash
cd /mnt/user/appdata/yt2upnp
git pull origin feature/persistent-speaker-registry
docker build -t yt2upnp:latest .
```
And restart the container in your Docker manager.
