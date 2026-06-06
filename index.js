const http = require('http');
const httpProxy = require('http-proxy');
const { SonosRendererBridge } = require('./renderer');
const { Client } = require('node-ssdp');
const axios = require('axios');
const os = require('os');
const { exec } = require('child_process');

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
            console.log(`[Proxy] Forwarding request for video ${videoId} to YouTube stream`);
            
            // Forward request to YouTube googlevideo URL
            proxy.web(req, res, {
                target: streamUrl,
                ignorePath: true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
        } catch (err) {
            console.error(`[Proxy] Failed to resolve stream for video ${videoId}:`, err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to resolve stream');
        }
    } else if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeBridges: activeBridges.size }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PROXY_PORT, () => {
    console.log(`[Proxy Server] Stream proxy server listening on port ${PROXY_PORT}`);
});

// Bridge management
const activeBridges = new Map(); // UDN -> SonosRendererBridge instance
let nextAvailablePort = RECEIVER_PORT_START;
const processedLocations = new Set(); // Keep track of locations currently being fetched

async function handleDevice(location) {
    if (processedLocations.has(location)) return;
    processedLocations.add(location);

    try {
        // Fetch UPnP Device Description XML
        const response = await axios.get(location, { timeout: 5000 });
        const xml = response.data;

        // Parse friendlyName, UDN, and deviceType using RegExp
        const deviceTypeMatch = xml.match(/<deviceType>(.*?)<\/deviceType>/);
        const friendlyNameMatch = xml.match(/<friendlyName>(.*?)<\/friendlyName>/);
        const udnMatch = xml.match(/<UDN>(.*?)<\/UDN>/);

        const deviceType = deviceTypeMatch ? deviceTypeMatch[1] : '';
        const friendlyName = friendlyNameMatch ? friendlyNameMatch[1] : '';
        const udn = udnMatch ? udnMatch[1] : '';

        // We only care about MediaRenderer devices
        if (!deviceType.includes('MediaRenderer')) {
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
console.log(`[Discovery] Initializing SSDP client bound to interface: ${SERVER_IP}`);
const ssdpClient = new Client({
    interfaces: [SERVER_IP],
    explicitSocketBind: true
});

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
    for (const bridge of activeBridges.values()) {
        await bridge.stop();
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
    for (const bridge of activeBridges.values()) {
        await bridge.stop();
    }
    server.close(() => {
        console.log('[System] Proxy server closed. Exiting.');
        process.exit(0);
    });
});
