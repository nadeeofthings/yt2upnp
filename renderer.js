const YouTubeCastReceiver = require('yt-cast-receiver');
const Player = YouTubeCastReceiver.Player;
// Defensive fallback in case DataStore is not exported directly
const DataStore = YouTubeCastReceiver.DataStore || class {};

const MediaRendererClient = require('upnp-mediarenderer-client');
const DeviceClient = require('upnp-device-client');
const et = require('elementtree');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- UPnP DeviceClient Monkey Patch for Nested Services (e.g. Sonos) ---
const originalGetDeviceDescription = DeviceClient.prototype.getDeviceDescription;

DeviceClient.prototype.getDeviceDescription = function(callback) {
  var self = this;
  originalGetDeviceDescription.call(this, function(err, desc) {
    if (err) return callback(err);

    // If AVTransport is missing from the root device, search in nested devices
    if (desc && (!desc.services || !desc.services['urn:upnp-org:serviceId:AVTransport'])) {
      console.log(`[Patch] AVTransport service not found in root device. Searching nested devices in XML...`);

      axios.get(self.url)
        .then(response => {
          try {
            const doc = et.parse(response.data);
            const baseUrl = extractBaseUrl(self.url);

            // Find all services in the XML (including nested ones)
            const allServices = doc.findall('.//service');
            allServices.forEach(function(service) {
              const tmp = extractFields(service, [
                'serviceType',
                'serviceId',
                'SCPDURL',
                'controlURL',
                'eventSubURL'
              ]);

              const id = tmp.serviceId;
              if (id && !desc.services[id]) {
                delete tmp.serviceId;
                // Make URLs absolute
                tmp.SCPDURL = buildAbsoluteUrl(baseUrl, tmp.SCPDURL);
                tmp.controlURL = buildAbsoluteUrl(baseUrl, tmp.controlURL);
                tmp.eventSubURL = buildAbsoluteUrl(baseUrl, tmp.eventSubURL);

                desc.services[id] = tmp;
                console.log(`[Patch] Added nested service: ${id}`);
              }
            });

            // Store updated description in cache
            self.deviceDescription = desc;
            callback(null, desc);
          } catch (e) {
            console.error('[Patch] Error parsing XML for nested services:', e);
            callback(null, desc); // Fallback to original desc
          }
        })
        .catch(fetchErr => {
          console.error('[Patch] Error fetching XML for nested services:', fetchErr);
          callback(null, desc); // Fallback to original desc
        });
    } else {
      callback(null, desc);
    }
  });
};

// Monkey patch callAction to prevent crash on missing errorDescription
DeviceClient.prototype.callAction = function(serviceId, actionName, params, callback) {
  var self = this;
  var resolvedServiceId = (serviceId.indexOf(':') === -1) 
    ? 'urn:upnp-org:serviceId:' + serviceId 
    : serviceId;

  this.getServiceDescription(resolvedServiceId, function(err, desc) {
    if(err) return callback(err);

    if(!desc.actions[actionName]) {
      var err = new Error('Action ' + actionName + ' not implemented by service');
      err.code = 'ENOACTION';
      return callback(err);
    }

    var service = self.deviceDescription.services[resolvedServiceId];

    // Build SOAP action body
    var envelope = et.Element('s:Envelope');
    envelope.set('xmlns:s', 'http://schemas.xmlsoap.org/soap/envelope/');
    envelope.set('s:encodingStyle', 'http://schemas.xmlsoap.org/soap/encoding/');

    var body = et.SubElement(envelope, 's:Body');
    var action = et.SubElement(body, 'u:' + actionName);
    action.set('xmlns:u', service.serviceType);

    Object.keys(params).forEach(function(paramName) {
      var tmp = et.SubElement(action, paramName);
      var value = params[paramName];
      tmp.text = (value === null || value === undefined)
        ? '' 
        : params[paramName].toString();
    });

    var doc = new et.ElementTree(envelope);
    var xml = doc.write({ 
      xml_declaration: true,
    });

    // Send action request
    var options = require('url').parse(service.controlURL);
    options.method = 'POST';
    options.headers = {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(xml),
      'Connection': 'close',
      'SOAPACTION': '"' + service.serviceType + '#' + actionName + '"'
    };

    var http = require('http');
    var req = http.request(options, function(res) {
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });
      res.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          var doc = et.parse(buf.toString());

          if(res.statusCode !== 200) {
            var errorCode = doc.findtext('.//errorCode');
            var errorDescription = doc.findtext('.//errorDescription');
            var errorStr = errorDescription ? errorDescription.trim() : 'Unknown UPnP Error';

            var err = new Error(errorStr + ' (' + errorCode + ')');
            err.code = 'EUPNP';
            err.statusCode = res.statusCode;
            err.errorCode = errorCode;
            return callback(err);
          }

          // Extract response outputs
          var serviceDesc = self.serviceDescriptions[resolvedServiceId];
          var actionDesc = serviceDesc.actions[actionName];
          var outputs = actionDesc.outputs.map(function(desc) {
            return desc.name;
          });

          var result = {};
          outputs.forEach(function(name) {
            result[name] = doc.findtext('.//' + name);
          });

          callback(null, result);
        } catch (parseErr) {
          callback(parseErr);
        }
      });
    });

    req.on('error', callback);
    req.end(xml);
  });
};

function buildAbsoluteUrl(base, url) {
  if(url === '') return '';
  if(url.substring(0, 4) === 'http') return url;
  if(url[0] === '/') {
    var root = base.split('/').slice(0, 3).join('/'); // http://host:port
    return root + url;
  } else {
    return base + '/' + url;
  }
}

function extractBaseUrl(url) {
  return url.split('/').slice(0, -1).join('/');
}

function extractFields(node, fields) {
  var data = {};
  fields.forEach(function(field) {
    var value = node.findtext('./' + field);
    if(typeof value !== 'undefined') {
      data[field] = value;
    }
  });
  return data;
}
// -----------------------------------------------------------------------



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

const PLAYER_STATUSES = YouTubeCastReceiver.Constants.PLAYER_STATUSES;

class SonosPlayer extends Player {
    constructor(upnpClient, name, proxyUrlBase, groupClients = []) {
        super();
        this.client = upnpClient;
        this.name = name;
        this.proxyUrlBase = proxyUrlBase;
        this.groupClients = groupClients; // Array of MediaRendererClient instances for group members
        this.isLoading = false;
        this.isExplicitStop = false;

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

            if (this.isExplicitStop) {
                console.log(`[Player:${this.name}] Explicit stop detected, not advancing.`);
                this.isExplicitStop = false;
                return;
            }

            console.log(`[Player:${this.name}] Track ended naturally. Advancing to next track...`);
            this.next().catch(e => {
                console.error(`[Player:${this.name}] Error advancing to next track:`, e);
            });
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

    notifyPlayed() {
        this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING).catch(e => {
            console.error(`[Player:${this.name}] Error notifying played state:`, e);
        });
    }

    notifyPaused() {
        this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED).catch(e => {
            console.error(`[Player:${this.name}] Error notifying paused state:`, e);
        });
    }

    notifyStopped() {
        this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED).catch(e => {
            console.error(`[Player:${this.name}] Error notifying stopped state:`, e);
        });
    }

    notifyLoading() {
        this.notifyExternalStateChange(PLAYER_STATUSES.LOADING).catch(e => {
            console.error(`[Player:${this.name}] Error notifying loading state:`, e);
        });
    }

    async doPlay(video, position) {

        console.log(`[Player:${this.name}] doPlay: videoId=${video.id}, title="${video.title}", startPosition=${position}s`);
        this.isLoading = true;
        this.isExplicitStop = false;
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
                            console.log(`[Player:${this.name}] Seeking to starting position: ${position}s (waiting 1.5s for buffer)...`);
                            setTimeout(() => {
                                this.client.seek(position, (seekErr) => {
                                    if (seekErr) console.error(`[Player:${this.name}] Seek error:`, seekErr);
                                });
                            }, 1500);
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
        this.isExplicitStop = true;
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
        this.isExplicitStop = false;
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
        this.isExplicitStop = true;
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
        const clientsToSet = this.groupClients && this.groupClients.length > 0
            ? this.groupClients
            : [this.client];

        const promises = clientsToSet.map(client => {
            return new Promise((resolve) => {
                client.setVolume(volume.level, (err) => {
                    if (err) {
                        console.error(`[Player:${this.name}] SetVolume error on speaker:`, err);
                    }
                    resolve(true);
                });
            });
        });

        await Promise.all(promises);
        return true;
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

    async joinGroup(coordinatorUdn) {
        console.log(`[Player:${this.name}] Joining group of coordinator: ${coordinatorUdn}`);
        return new Promise((resolve) => {
            this.client.callAction('AVTransport', 'SetAVTransportURI', {
                InstanceID: 0,
                CurrentURI: `x-rincon:${coordinatorUdn}`,
                CurrentURIMetaData: ''
            }, (err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Error joining group:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async leaveGroup() {
        console.log(`[Player:${this.name}] Leaving group to become standalone`);
        return new Promise((resolve) => {
            this.client.callAction('AVTransport', 'BecomeCoordinatorOfStandaloneGroup', {
                InstanceID: 0
            }, (err) => {
                if (err) {
                    console.error(`[Player:${this.name}] Error leaving group:`, err);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
}

class SonosRendererBridge {
    constructor(deviceUrl, friendlyName, udn, proxyUrlBase, receiverPort, groupClients = []) {
        this.deviceUrl = deviceUrl;
        this.friendlyName = friendlyName;
        this.udn = udn;
        this.proxyUrlBase = proxyUrlBase;
        this.receiverPort = receiverPort;
        this.groupClients = groupClients;

        console.log(`[Bridge:${friendlyName}] Initializing bridge on port ${receiverPort}...`);
        
        // Initialize the MediaRendererClient
        this.upnpClient = new MediaRendererClient(deviceUrl);
        
        // Initialize the Player
        this.player = new SonosPlayer(this.upnpClient, friendlyName, proxyUrlBase, groupClients);
        
        // Initialize isolated file-based DataStore
        const cleanName = friendlyName.replace(/[^a-zA-Z0-9]/g, '_');
        const storePath = path.join(__dirname, 'data', `lounge_${cleanName}.json`);
        this.dataStore = new FileDataStore(storePath);

        // Initialize the YouTubeCastReceiver
        this.receiver = new YouTubeCastReceiver(this.player, {
            device: {
                name: friendlyName,
                screenName: friendlyName
            },
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
