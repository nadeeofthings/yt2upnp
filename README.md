# yt2upnp

`yt2upnp` is a lightweight, self-hosted Docker bridge that connects **YouTube Music** (and the standard YouTube mobile app) to **Sonos speakers** and other UPnP/DLNA media renderers on your local network.

It allows you to cast music directly from your phone's native YouTube Music app using the Cast button, without needing to use the Sonos app.

## How it Works

1. **SSDP Discovery**: The application continuously scans your local network for UPnP MediaRenderer devices (such as Sonos speakers).
2. **Lounge Receiver Emulation**: For each speaker found, it spins up an emulated YouTube Cast receiver (using the YouTube Lounge protocol) named after that speaker. These appear in your mobile YouTube Music cast menu.
3. **HTTP Proxying**: When you cast a video, the bridge runs `yt-dlp` to resolve the direct audio stream URL from YouTube. Since Sonos and other UPnP speakers only support HTTP (and YouTube uses HTTPS), the bridge acts as an HTTP proxy, piping the stream directly to the speaker.
4. **URL Caching**: The bridge caches resolved stream URLs for 30 minutes. This avoids calling `yt-dlp` on every byte-range request from the speaker, facilitating instant playback and seek response.

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
| `PROXY_PORT` | `8085` | The port the HTTP stream proxy server will run on. |
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
1. Build the image installing Node.js, `ffmpeg`, and the latest `yt-dlp` binary.
2. Spin up the container sharing the host network.
3. Keep the service running in the background.

---

## Usage

1. Open **YouTube Music** (or the **YouTube** app) on your Android or iOS device.
2. Tap the **Cast** icon.
3. You will see your Sonos speakers listed directly under their friendly names (e.g., *Living Room*, *Kitchen*).
4. Tap the speaker to connect and start playing! You can control playback, pause/resume, and adjust volume directly from your phone.

---

## File Structure

- `index.js`: Main orchestrator, SSDP listener, and HTTP proxy server.
- `renderer.js`: Sonos player command mapper and isolated token stores.
- `Dockerfile`: Multi-stage Alpine-based container build configuration.
- `docker-compose.yml`: Local Docker orchestrator settings (configured for host networking).
- `data/`: Directory where individual speaker pairing configurations are persisted.

---

## License

MIT License. Free and open source.
