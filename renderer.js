const ytcr = require('yt-cast-receiver');
const Player = ytcr.Player;
const YouTubeCastReceiver = ytcr.YouTubeCastReceiver;
// Defensive fallback in case DataStore is not exported directly
const DataStore = ytcr.DataStore || class {};

const MediaRendererClient = require('upnp-mediarenderer-client');
const fs = require('fs');
const path = require('path');

// A custom data store for each speaker to isolate pairing tokens
class FileDataStore extends DataStore {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.data = {};
        
        // Ensure the directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        if (fs.existsSync(filePath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                console.error(`[DataStore] Error reading file ${filePath}:`, e);
            }
        }
    }

    async get(key) {
        return this.data[key];
    }

    async set(key, value) {
        this.data[key] = value;
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error(`[DataStore] Error writing file ${this.filePath}:`, e);
        }
    }
}

class SonosPlayer extends Player {
    constructor(upnpClient, name, proxyUrlBase) {
        super();
        this.client = upnpClient;
        this.name = name;
        this.proxyUrlBase = proxyUrlBase;
        this.isLoading = false;

        // Set up event listeners from the Sonos UPnP client to sync state with YouTube
        this.client.on('playing', () => {
            console.log(`[Player:${this.name}] UPnP playing event received`);
            this.isLoading = false;
            this.notifyPlayed();
        });

        this.client.on('paused', () => {
            console.log(`[Player:${this.name}] UPnP paused event received`);
            this.notifyPaused();
        });

        this.client.on('stopped', () => {
            console.log(`[Player:${this.name}] UPnP stopped event received`);
            if (this.isLoading) {
                console.log(`[Player:${this.name}] Ignoring stopped event during load transition`);
                return;
            }
            this.notifyStopped();
        });

        this.client.on('status', (status) => {
            console.log(`[Player:${this.name}] UPnP status change:`, status);
            // Some renderers don't emit separate events but report state in status
            if (status.TransportState) {
                const state = status.TransportState;
                if (state === 'PLAYING' && this.isLoading) {
                    this.isLoading = false;
                    this.notifyPlayed();
                } else if (state === 'PAUSED') {
                    this.notifyPaused();
                } else if (state === 'STOPPED' && !this.isLoading) {
                    this.notifyStopped();
                }
            }
        });
    }

    async doPlay(video, position) {
        console.log(`[Player:${this.name}] doPlay: videoId=${video.id}, title="${video.title}", startPosition=${position}s`);
        this.isLoading = true;
        this.notifyLoading();

        // Construct the stream URL pointing to our HTTP proxy
        const streamUrl = `${this.proxyUrlBase}/stream?id=${video.id}`;
        
        const options = {
            autoplay: true,
            contentType: 'audio/x-m4a', // Best audio format mapping for YouTube's AAC audio stream
            metadata: {
                title: video.title || 'YouTube Music',
                type: 'audio'
            }
        };

        return new Promise((resolve) => {
            this.client.load(streamUrl, options, (err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Error loading track into UPnP client:`, err);
                    this.isLoading = false;
                    resolve(false);
                } else {
                    console.log(`[Player:${this.name}] Track loaded successfully`);
                    if (position > 0) {
                        // If starting from a specific position, seek once playing begins
                        const seekOnPlaying = () => {
                            console.log(`[Player:${this.name}] Seeking to starting position: ${position}s`);
                            this.client.seek(position, (seekErr) => {
                                if (seekErr) console.error(`[Player:${this.name}] Seek error:`, seekErr);
                            });
                            this.client.removeListener('playing', seekOnPlaying);
                        };
                        this.client.on('playing', seekOnPlaying);
                    }
                    resolve(true);
                }
            });
        });
    }

    async doPause() {
        console.log(`[Player:${this.name}] doPause`);
        return new Promise((resolve) => {
            this.client.pause((err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Pause error:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async doResume() {
        console.log(`[Player:${this.name}] doResume`);
        return new Promise((resolve) => {
            this.client.play((err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Resume/Play error:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async doStop() {
        console.log(`[Player:${this.name}] doStop`);
        this.isLoading = false;
        return new Promise((resolve) => {
            this.client.stop((err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Stop error:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async doSeek(position) {
        console.log(`[Player:${this.name}] doSeek to ${position}s`);
        return new Promise((resolve) => {
            this.client.seek(position, (err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Seek error:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async doSetVolume(volume) {
        console.log(`[Player:${this.name}] doSetVolume level=${volume.level}, muted=${volume.muted}`);
        return new Promise((resolve) => {
            this.client.setVolume(volume.level, (err) => {
                if (err) {
                    console.error(`[Player:${this.name}] SetVolume error:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async doGetVolume() {
        return new Promise((resolve) => {
            this.client.getVolume((err, volume) => {
                if (err) {
                    resolve({ level: 30, muted: false });
                } else {
                    resolve({ level: volume, muted: false });
                }
            });
        });
    }

    async doGetPosition() {
        return new Promise((resolve) => {
            this.client.getPosition((err, position) => {
                if (err) {
                    resolve(0);
                } else {
                    resolve(position);
                }
            });
        });
    }

    async doGetDuration() {
        return new Promise((resolve) => {
            this.client.getDuration((err, duration) => {
                if (err) {
                    resolve(0);
                } else {
                    resolve(duration);
                }
            });
        });
    }
}

class SonosRendererBridge {
    constructor(deviceUrl, friendlyName, udn, proxyUrlBase, receiverPort) {
        this.deviceUrl = deviceUrl;
        this.friendlyName = friendlyName;
        this.udn = udn;
        this.proxyUrlBase = proxyUrlBase;
        this.receiverPort = receiverPort;

        console.log(`[Bridge:${friendlyName}] Initializing bridge on port ${receiverPort}...`);
        
        // Initialize the MediaRendererClient
        this.upnpClient = new MediaRendererClient(deviceUrl);
        
        // Initialize the Player
        this.player = new SonosPlayer(this.upnpClient, friendlyName, proxyUrlBase);
        
        // Initialize isolated file-based DataStore
        const cleanName = friendlyName.replace(/[^a-zA-Z0-9]/g, '_');
        const storePath = path.join(__dirname, 'data', `lounge_${cleanName}.json`);
        this.dataStore = new FileDataStore(storePath);

        // Initialize the YouTubeCastReceiver
        this.receiver = new YouTubeCastReceiver(this.player, {
            name: friendlyName,
            screenName: friendlyName,
            port: receiverPort,
            dataStore: this.dataStore
        });
        
        this.receiver.on('senderConnect', (sender) => {
            console.log(`[Bridge:${friendlyName}] YouTube sender connected: ${sender.name}`);
        });

        this.receiver.on('senderDisconnect', (sender) => {
            console.log(`[Bridge:${friendlyName}] YouTube sender disconnected: ${sender.name}`);
        });
    }

    async start() {
        console.log(`[Bridge:${this.friendlyName}] Starting YouTube Cast receiver...`);
        try {
            await this.receiver.start();
            console.log(`[Bridge:${this.friendlyName}] Receiver started successfully on port ${this.receiverPort}`);
        } catch (err) {
            console.error(`[Bridge:${this.friendlyName}] Failed to start receiver:`, err);
            throw err;
        }
    }

    async stop() {
        console.log(`[Bridge:${this.friendlyName}] Stopping bridge...`);
        try {
            await this.receiver.stop();
            console.log(`[Bridge:${this.friendlyName}] Bridge stopped`);
        } catch (err) {
            console.error(`[Bridge:${this.friendlyName}] Error during stop:`, err);
        }
    }
}

module.exports = {
    SonosRendererBridge
};
