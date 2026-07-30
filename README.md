# yt2upnp

`yt2upnp` is a lightweight, self-hosted Docker bridge that connects **YouTube Music** (and the standard YouTube mobile app) to **Sonos speakers** and other UPnP/DLNA media renderers on your local network.

It allows you to cast music directly from your phone's native YouTube Music app using the Cast button, without needing to use the Sonos app.

---

## Features

- **Direct YouTube Music Casting**: Cast audio straight from the YouTube / YouTube Music mobile app to any Sonos speaker.
- **Native Speaker Grouping**: Group multiple Sonos speakers together directly from the Web Dashboard. Audio plays in sync across all grouped rooms, and a virtual group target (e.g., *Sonos Group: Living Room + Kitchen*) automatically appears in your YouTube Music cast menu!
- **Web Admin Dashboard**: Accessible via web browser on port `8085` (`http://<SERVER_IP>:8085`).
  - View real-time speaker states and media metadata (album art, title, artist, album, track position & duration).
  - Web-based playback controls: Play, Pause, Stop, Skip Next/Previous, Seek, and Volume control.
  - Interactive Speaker Group Manager to create and disband multi-room speaker groups.
- **Robust Error Recovery & Caching**: Bounded URL caching, status response caching, and automatic recovery from UPnP network subscription timeouts.

---

## How it Works

1. **SSDP Discovery**: The application continuously scans your local network for UPnP MediaRenderer devices (such as Sonos speakers).
2. **Lounge Receiver Emulation**: For each speaker found, it spins up an emulated YouTube Cast receiver (using the YouTube Lounge protocol) named after that speaker. These appear in your mobile YouTube Music cast menu.
3. **Virtual Group Receivers**: When a speaker group is created via the dashboard, `yt2upnp` commands follower speakers to join the group coordinator using native Sonos UPnP grouping and spawns a single unified Cast receiver for the entire group.
4. **HTTP Proxying**: When you cast a video, the bridge uses `yt-dlp` to resolve the direct audio stream URL from YouTube. Since Sonos and other UPnP speakers only support HTTP (and YouTube uses HTTPS), the bridge acts as an HTTP proxy, piping the stream directly to the speaker.
5. **URL & Status Caching**: The bridge caches resolved stream URLs for 30 minutes and status queries for 1.5 seconds, ensuring fast playback start times, low latency seek response, and minimal network load on your speakers.

---

## Prerequisites

- **Host Network Mode**: Because UPnP discovery uses UDP multicast (port 1900), the Docker container **must** run in Host Network Mode (`network_mode: host`). This is required so the container can receive multicast discovery packets from your local network.
- **Docker & Docker Compose**: Installed on your host machine (e.g. Unraid, Synology, or Linux server).

---

## Configuration

You can configure `yt2upnp` using the following environment variables in `docker-compose.yml`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SERVER_IP` | *Auto-detected* | The local network IP of the server running `yt2upnp`. Set this manually if auto-detection picks the wrong interface. |
| `PROXY_PORT` | `8085` | The port for the stream proxy server and Web Dashboard. |
| `RECEIVER_PORT_START` | `8090` | The starting TCP port for the dynamically spawned virtual YouTube Cast receivers. |

---

## Installation & Deployment

### 1. Clone the Repository
Clone the files into a directory on your host server (e.g. `/mnt/user/appdata/yt2upnp` on Unraid):
```bash
git clone <your-repo-url> yt2upnp
cd yt2upnp
```

### 2. Run with Docker Compose
To build and start the bridge in detached mode:
```bash
docker compose up -d --build
```
This will:
1. Build the image installing Node.js, `ffmpeg`, and `yt-dlp`.
2. Spin up the container sharing the host network.
3. Keep the service running in the background with `restart: unless-stopped`.

---

## Usage & Web Dashboard

### Casting Audio
1. Open **YouTube Music** (or the **YouTube** app) on your mobile device.
2. Tap the **Cast** icon.
3. Select your Sonos speaker (or Sonos Group) from the list.
4. Play music! Volume, pause/resume, and track skipping work directly from your phone.

### Web Dashboard
Open `http://<SERVER_IP>:8085/` in any web browser to:
- View live playback details & high-res cover art.
- Create new speaker groups by selecting a Coordinator and Member speakers.
- Adjust volume and control playback remotely.

---

## File Structure

- `index.js`: Main orchestrator, SSDP listener, API routing, and HTTP stream proxy server.
- `renderer.js`: Sonos player command mapper, UPnP monkey patches, and isolated token stores.
- `dashboard.html`: Glassmorphism admin web UI for media control and speaker group management.
- `Dockerfile`: Multi-stage Alpine-based container build configuration.
- `docker-compose.yml`: Local Docker orchestrator settings (configured for host networking).
- `data/`: Directory where speaker pairing tokens and saved group configurations are persisted (`groups.json`).

---

## License

MIT License. Free and open source.
