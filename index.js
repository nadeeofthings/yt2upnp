const http = require('http');
const httpProxy = require('http-proxy');
const { SonosRendererBridge } = require('./renderer');
const { Client } = require('node-ssdp');
const axios = require('axios');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROXY_PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 8085;
const RECEIVER_PORT_START = process.env.RECEIVER_PORT_START ? parseInt(process.env.RECEIVER_PORT_START, 10) : 8090;

// Auto-detect local network IP
function getLocalIpAddress() {
    if (process.env.SERVER_IP) {
        return process.env.SERVER_IP;
    }
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

const SERVER_IP = getLocalIpAddress();
const PROXY_URL_BASE = `http://${SERVER_IP}:${PROXY_PORT}`;

console.log(`[System] Server IP address set to: ${SERVER_IP}`);
console.log(`[System] Proxy base URL set to: ${PROXY_URL_BASE}`);

const GROUPS_FILE = path.join(__dirname, 'data', 'groups.json');
let savedGroups = [];
const activeGroups = new Map(); // groupName -> { config, bridge, port }
const activeBridges = new Map(); // UDN -> SonosRendererBridge instance
let nextAvailablePort = RECEIVER_PORT_START;

function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            savedGroups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            console.log(`[Groups] Loaded ${savedGroups.length} saved groups from configuration.`);
        }
    } catch (err) {
        console.error('[Groups] Error loading groups.json:', err.message);
        savedGroups = [];
    }
}

function saveGroups() {
    try {
        const dir = path.dirname(GROUPS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(savedGroups, null, 2), 'utf8');
        console.log('[Groups] Saved group configuration.');
    } catch (err) {
        console.error('[Groups] Error saving groups.json:', err.message);
    }
}

loadGroups();

async function createOrUpdateGroup(groupName, coordinatorUdn, memberUdns) {
    console.log(`[Groups] Creating/updating group "${groupName}" with coordinator ${coordinatorUdn} and members:`, memberUdns);

    // 1. Remove this group if it already exists
    await deleteGroup(groupName);

    // 2. Add to savedGroups
    const groupConfig = { name: groupName, coordinatorUdn, memberUdns };
    savedGroups = savedGroups.filter(g => g.name !== groupName);
    savedGroups.push(groupConfig);
    saveGroups();

    // 3. Apply UPnP groupings for online devices
    const coordinatorBridge = activeBridges.get(coordinatorUdn);
    if (!coordinatorBridge) {
        console.log(`[Groups] Coordinator ${coordinatorUdn} is not online yet. Group bridge will start when it is discovered.`);
        return;
    }

    // Call joinGroup on all online members
    const groupClients = [coordinatorBridge.upnpClient];
    for (const memberUdn of memberUdns) {
        const memberBridge = activeBridges.get(memberUdn);
        if (memberBridge) {
            console.log(`[Groups] Ordering ${memberBridge.friendlyName} to join coordinator ${coordinatorBridge.friendlyName}`);
            await memberBridge.player.joinGroup(coordinatorUdn);
            groupClients.push(memberBridge.upnpClient);
        }
    }

    // 4. Spawn the virtual group Cast receiver
    const groupPort = nextAvailablePort++;
    const virtualUdn = `uuid:group:${groupName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const groupFriendlyName = `Sonos Group: ${groupName}`;

    const groupBridge = new SonosRendererBridge(
        coordinatorBridge.deviceUrl,
        groupFriendlyName,
        virtualUdn,
        PROXY_URL_BASE,
        groupPort,
        groupClients
    );

    activeGroups.set(groupName, {
        config: groupConfig,
        bridge: groupBridge,
        port: groupPort
    });

    await groupBridge.start();
    console.log(`[Groups] Virtual group bridge "${groupFriendlyName}" started on port ${groupPort}`);
}

async function deleteGroup(groupName) {
    const activeGroup = activeGroups.get(groupName);
    if (activeGroup) {
        console.log(`[Groups] Disbanding active group "${groupName}"...`);
        // Stop the virtual bridge
        await activeGroup.bridge.stop();
        activeGroups.delete(groupName);
    }

    // Find the config
    const config = savedGroups.find(g => g.name === groupName);
    if (config) {
        // Ungroup all online members
        for (const memberUdn of config.memberUdns) {
            const memberBridge = activeBridges.get(memberUdn);
            if (memberBridge) {
                console.log(`[Groups] Restoring follower speaker "${memberBridge.friendlyName}" to standalone coordinator status`);
                await memberBridge.player.leaveGroup();
            }
        }
        // Remove from config
        savedGroups = savedGroups.filter(g => g.name !== groupName);
        saveGroups();
    }
}

async function checkAndApplyGroupingsForDevice(udn, bridge) {
    // 1. Check if the newly discovered device is a member (follower) of an active/saved group
    for (const groupConfig of savedGroups) {
        if (groupConfig.memberUdns.includes(udn)) {
            const coordinatorBridge = activeBridges.get(groupConfig.coordinatorUdn);
            if (coordinatorBridge) {
                console.log(`[Groups] Discovered follower "${bridge.friendlyName}" for active group "${groupConfig.name}". Ordering it to join coordinator.`);
                await bridge.player.joinGroup(groupConfig.coordinatorUdn);
                
                // Add this client to the group bridge's groupClients list if it's already active
                const activeGroup = activeGroups.get(groupConfig.name);
                if (activeGroup && activeGroup.bridge && activeGroup.bridge.player) {
                    if (!activeGroup.bridge.player.groupClients.includes(bridge.upnpClient)) {
                        activeGroup.bridge.player.groupClients.push(bridge.upnpClient);
                    }
                }
            }
        }
    }

    // 2. Check if the newly discovered device is the coordinator of a saved group
    for (const groupConfig of savedGroups) {
        if (groupConfig.coordinatorUdn === udn) {
            if (!activeGroups.has(groupConfig.name)) {
                console.log(`[Groups] Discovered coordinator "${bridge.friendlyName}" for group "${groupConfig.name}". Starting group bridge...`);
                
                // Gather any group member clients that are already online
                const groupClients = [bridge.upnpClient];
                for (const memberUdn of groupConfig.memberUdns) {
                    const memberBridge = activeBridges.get(memberUdn);
                    if (memberBridge) {
                        console.log(`[Groups] Group member "${memberBridge.friendlyName}" is already online. Joining group.`);
                        await memberBridge.player.joinGroup(udn);
                        groupClients.push(memberBridge.upnpClient);
                    }
                }

                const groupPort = nextAvailablePort++;
                const virtualUdn = `uuid:group:${groupConfig.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                const groupFriendlyName = `Sonos Group: ${groupConfig.name}`;

                const groupBridge = new SonosRendererBridge(
                    bridge.deviceUrl,
                    groupFriendlyName,
                    virtualUdn,
                    PROXY_URL_BASE,
                    groupPort,
                    groupClients
                );

                activeGroups.set(groupConfig.name, {
                    config: groupConfig,
                    bridge: groupBridge,
                    port: groupPort
                });

                await groupBridge.start();
            }
        }
    }
}

// Stream URL cache
const urlCache = new Map(); // videoId -> { url, expiresAt }

async function getYouTubeStreamUrl(videoId) {
    const cached = urlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
        console.log(`[Cache] Using cached stream URL for video ${videoId}`);
        return cached.url;
    }

    console.log(`[System] Resolving stream URL for video ${videoId} using yt-dlp...`);
    return new Promise((resolve, reject) => {
        // -g: print URL, -f bestaudio: grab best audio stream (favoring m4a AAC)
        const command = `yt-dlp -g -f "bestaudio[ext=m4a]/bestaudio" "https://www.youtube.com/watch?v=${videoId}"`;
        exec(command, (err, stdout, stderr) => {
            if (err) {
                console.error(`[yt-dlp] Error resolving stream URL for ${videoId}:`, stderr);
                reject(err);
                return;
            }
            const url = stdout.trim();
            if (!url) {
                reject(new Error('No URL returned by yt-dlp'));
                return;
            }
            // Cache for 30 minutes
            urlCache.set(videoId, {
                url,
                expiresAt: Date.now() + 30 * 60 * 1000
            });
            console.log(`[Cache] Cached stream URL for video ${videoId}`);
            resolve(url);
        });
    });
}

// Create HTTP proxy server
const proxy = httpProxy.createProxyServer({
    secure: false, // Disable SSL verification for outgoing requests
    changeOrigin: true
});

proxy.on('error', (err, req, res) => {
    console.error('[Proxy] Error forwarding request:', err);
    if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy Error');
});

proxy.on('proxyRes', (proxyRes, req, res) => {
    console.log(`[Proxy] YouTube response: status=${proxyRes.statusCode}, type="${proxyRes.headers['content-type']}", size=${proxyRes.headers['content-length']} bytes`);
    
    // Force the Content-Type to audio/x-m4a so Sonos recognizes the stream format correctly
    proxyRes.headers['content-type'] = 'audio/x-m4a';
});


const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    if (parsedUrl.pathname === '/stream') {
        const videoId = parsedUrl.searchParams.get('id');
        
        // Strict input validation to prevent command injection
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid or missing video ID');
            return;
        }

        try {
            const streamUrl = await getYouTubeStreamUrl(videoId);
            console.log(`[Proxy] Requesting stream for video ${videoId} from YouTube...`);

            // Forward Range header if requested by the client (Sonos)
            const forwardHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            if (req.headers['range']) {
                forwardHeaders['range'] = req.headers['range'];
                console.log(`[Proxy] Range requested: ${req.headers['range']}`);
            }

            const response = await axios({
                method: 'get',
                url: streamUrl,
                responseType: 'stream',
                headers: forwardHeaders,
                validateStatus: () => true // Allow any status code (like 206, 302, etc.) to pass through
            });

            console.log(`[Proxy] YouTube response: status=${response.status}, type="${response.headers['content-type']}", size=${response.headers['content-length']} bytes`);

            // Set reply headers and force audio/x-m4a MIME type
            const replyHeaders = {};
            if (response.headers['content-type']) replyHeaders['content-type'] = 'audio/x-m4a';
            if (response.headers['content-length']) replyHeaders['content-length'] = response.headers['content-length'];
            if (response.headers['content-range']) replyHeaders['content-range'] = response.headers['content-range'];
            if (response.headers['accept-ranges']) replyHeaders['accept-ranges'] = response.headers['accept-ranges'];

            res.writeHead(response.status, replyHeaders);
            response.data.pipe(res);

            // Handle client socket abort/close
            req.on('close', () => {
                response.data.destroy();
            });
        } catch (err) {
            console.error(`[Proxy] Failed to resolve or proxy stream for video ${videoId}:`, err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Failed to resolve stream');
            }
        }
    } else if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeBridges: activeBridges.size }));
    } else if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'dashboard.html');
        fs.readFile(htmlPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading dashboard');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    } else if (parsedUrl.pathname === '/api/status') {
        // Return status of all devices and groups
        const devicePromises = Array.from(activeBridges.entries()).map(async ([udn, bridge]) => {
            let role = 'standalone';
            let activeGroupName = null;
            
            for (const groupConfig of savedGroups) {
                if (groupConfig.coordinatorUdn === udn) {
                    role = 'coordinator';
                    activeGroupName = groupConfig.name;
                    break;
                } else if (groupConfig.memberUdns.includes(udn)) {
                    role = 'follower';
                    activeGroupName = groupConfig.name;
                    break;
                }
            }

            let volume = 30;
            try {
                const volObj = await Promise.race([
                    bridge.player.doGetVolume(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))
                ]);
                volume = volObj.level;
            } catch(e) {}

            return {
                udn,
                friendlyName: bridge.friendlyName,
                location: bridge.deviceUrl,
                role,
                activeGroupName,
                volume
            };
        });

        Promise.all(devicePromises).then(devices => {
            const groups = savedGroups.map(g => {
                const activeGroup = activeGroups.get(g.name);
                return {
                    name: g.name,
                    coordinatorUdn: g.coordinatorUdn,
                    memberUdns: g.memberUdns,
                    online: !!activeGroup,
                    port: activeGroup ? activeGroup.port : null
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ devices, groups }));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
    } else if (parsedUrl.pathname === '/api/groups' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const { name, coordinatorUdn, memberUdns } = payload;
                if (!name || !coordinatorUdn || !Array.isArray(memberUdns)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameters' }));
                    return;
                }

                await createOrUpdateGroup(name, coordinatorUdn, memberUdns);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else if (parsedUrl.pathname === '/api/groups' && req.method === 'DELETE') {
        const name = parsedUrl.searchParams.get('name');
        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing group name parameter' }));
            return;
        }
        try {
            await deleteGroup(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    } else if (parsedUrl.pathname === '/api/volume' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const { udn, level } = payload;
                if (!udn || level === undefined) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameters' }));
                    return;
                }

                const levelNum = parseInt(level, 10);

                // Adjust volume of individual speaker
                const bridge = activeBridges.get(udn);
                if (bridge) {
                    await bridge.player.doSetVolume({ level: levelNum, muted: false });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                // Adjust volume of group if UDN matches a group coordinator's UDN or name
                let foundGroup = null;
                for (const [gName, groupObj] of activeGroups.entries()) {
                    if (groupObj.bridge.udn === udn || gName === udn) {
                        foundGroup = groupObj;
                        break;
                    }
                }

                if (foundGroup) {
                    await foundGroup.bridge.player.doSetVolume({ level: levelNum, muted: false });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Device or group not found' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PROXY_PORT, () => {
    console.log(`[Proxy Server] Stream proxy server listening on port ${PROXY_PORT}`);
});

// Bridge management
const processedLocations = new Set(); // Keep track of locations currently being fetched

async function handleDevice(location) {
    if (processedLocations.has(location)) return;
    processedLocations.add(location);

    try {
        // Fetch UPnP Device Description XML
        const response = await axios.get(location, { timeout: 5000 });
        const xml = response.data;

        // Parse friendlyName, roomName, modelName, UDN, and deviceType using RegExp
        const deviceTypeMatch = xml.match(/<deviceType>(.*?)<\/deviceType>/);
        const friendlyNameMatch = xml.match(/<friendlyName>(.*?)<\/friendlyName>/);
        const roomNameMatch = xml.match(/<roomName>(.*?)<\/roomName>/);
        const modelNameMatch = xml.match(/<modelName>(.*?)<\/modelName>/);
        const udnMatch = xml.match(/<UDN>(.*?)<\/UDN>/);

        const deviceType = deviceTypeMatch ? deviceTypeMatch[1] : '';
        const roomName = roomNameMatch ? roomNameMatch[1] : '';
        const modelName = modelNameMatch ? modelNameMatch[1] : '';
        const udn = udnMatch ? udnMatch[1] : '';

        // Clean model name (e.g. "Sonos Play:3" -> "Sonos Play 3")
        const cleanModelName = modelName.replace(/:/g, ' ');

        let friendlyName;
        if (cleanModelName && roomName) {
            friendlyName = `${cleanModelName}: ${roomName}`;
        } else {
            friendlyName = roomName || (friendlyNameMatch ? friendlyNameMatch[1] : '');
        }

        console.log(`[Discovery] Fetched description XML. Parsed: name="${friendlyName}", type="${deviceType}", udn="${udn}"`);

        // We care about MediaRenderer and Sonos ZonePlayer devices
        if (!deviceType.includes('MediaRenderer') && !deviceType.includes('ZonePlayer')) {
            console.log(`[Discovery] Ignoring device "${friendlyName}" because deviceType "${deviceType}" is not a MediaRenderer or ZonePlayer.`);
            processedLocations.delete(location);
            return;
        }


        if (!udn || !friendlyName) {
            processedLocations.delete(location);
            return;
        }

        if (activeBridges.has(udn)) {
            // Already bridged
            processedLocations.delete(location);
            return;
        }

        console.log(`[Discovery] Discovered new MediaRenderer: "${friendlyName}" at ${location} (UDN: ${udn})`);
        
        // Allocate a unique port for this speaker's YouTube Cast Receiver
        const receiverPort = nextAvailablePort++;
        
        // Create the bridge
        const bridge = new SonosRendererBridge(location, friendlyName, udn, PROXY_URL_BASE, receiverPort);
        activeBridges.set(udn, bridge);
        
        // Start the bridge
        await bridge.start();
        console.log(`[Discovery] Bridge for "${friendlyName}" started successfully!`);

        // Check if we need to apply groupings to this new device
        await checkAndApplyGroupingsForDevice(udn, bridge);
    } catch (err) {
        console.error(`[Discovery] Error handling device description from ${location}:`, err.message);
    } finally {
        processedLocations.delete(location);
    }
}

function handleDeviceBye(usn) {
    for (const [udn, bridge] of activeBridges.entries()) {
        if (usn.includes(udn)) {
            console.log(`[Discovery] Device offline notification for "${bridge.friendlyName}" (UDN: ${udn})`);
            bridge.stop().then(() => {
                activeBridges.delete(udn);
            });
            break;
        }
    }
}

// Start SSDP client
const RENDERER_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';

// Find the network interface name associated with SERVER_IP
let serverInterface = null;
const networkInterfaces = os.networkInterfaces();
for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
        if (net.address === SERVER_IP) {
            serverInterface = name;
            break;
        }
    }
    if (serverInterface) break;
}

const clientOptions = {
    explicitSocketBind: true
};

if (serverInterface) {
    console.log(`[Discovery] Initializing SSDP client bound to interface name: ${serverInterface} (${SERVER_IP})`);
    clientOptions.interfaces = [serverInterface];
} else {
    console.log(`[Discovery] Initializing SSDP client on all interfaces explicitly (could not map ${SERVER_IP})`);
}

const ssdpClient = new Client(clientOptions);


ssdpClient.on('response', (headers, statusCode, rinfo) => {
    if (headers.LOCATION) {
        console.log(`[Discovery] Received SSDP search response from ${rinfo.address} (${headers.LOCATION})`);
        handleDevice(headers.LOCATION);
    }
});

ssdpClient.on('notify', (headers) => {
    console.log(`[Discovery] Received SSDP notify NT=${headers.NT} NTS=${headers.NTS}`);
    if (headers.NT === RENDERER_ST) {
        if (headers.NTS === 'ssdp:alive' && headers.LOCATION) {
            console.log(`[Discovery] Device alive notify from: ${headers.LOCATION}`);
            handleDevice(headers.LOCATION);
        } else if (headers.NTS === 'ssdp:byebye' && headers.USN) {
            handleDeviceBye(headers.USN);
        }
    }
});


// Perform initial search
console.log(`[Discovery] Starting SSDP discovery for ${RENDERER_ST}...`);
ssdpClient.search(RENDERER_ST);

// Search periodically every 60 seconds to find any newly connected devices
setInterval(() => {
    console.log('[Discovery] Performing periodic SSDP search...');
    ssdpClient.search(RENDERER_ST);
}, 60000);

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\n[System] SIGINT received, shutting down bridges...');
    try {
        ssdpClient.stop();
    } catch (e) {}
    for (const group of activeGroups.values()) {
        try { await group.bridge.stop(); } catch (e) {}
    }
    for (const bridge of activeBridges.values()) {
        try { await bridge.stop(); } catch (e) {}
    }
    server.close(() => {
        console.log('[System] Proxy server closed. Exiting.');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('\n[System] SIGTERM received, shutting down bridges...');
    try {
        ssdpClient.stop();
    } catch (e) {}
    for (const group of activeGroups.values()) {
        try { await group.bridge.stop(); } catch (e) {}
    }
    for (const bridge of activeBridges.values()) {
        try { await bridge.stop(); } catch (e) {}
    }
    server.close(() => {
        console.log('[System] Proxy server closed. Exiting.');
        process.exit(0);
    });
});
