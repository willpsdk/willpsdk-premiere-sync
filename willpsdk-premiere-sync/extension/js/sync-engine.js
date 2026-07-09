// willpsdk Premiere Sync — sync engine
// Discovery (UDP broadcast), a small HTTP server for pull + push, two-way
// file sync and .prproj relinking. Runs inside the CEP panel on plain Node
// built-ins, no npm deps.

'use strict';

var WVS = (function () {

    // node is only there in CEP's mixed context; bail cleanly otherwise
    var nodeAvailable = false;
    var nr = null;
    try {
        nr = (window.cep_node && window.cep_node.require) ? window.cep_node.require : require;
        nodeAvailable = !!nr;
    } catch (e) { nodeAvailable = false; }

    if (!nodeAvailable) {
        return { available: false };
    }

    var fs = nr('fs');
    var path = nr('path');
    var os = nr('os');
    var http = nr('http');
    var dgram = nr('dgram');
    var crypto = nr('crypto');
    var zlib = nr('zlib');
    var urlMod = nr('url');
    var NBuffer = (window.cep_node && window.cep_node.Buffer) ? window.cep_node.Buffer : Buffer;

    var MAGIC = 'WILLPS_VIDEO_SYNC_1';
    var DISCOVERY_PORT = 41336;
    var SERVER_PORT_BASE = 41337;
    var BROADCAST_INTERVAL_MS = 3000;
    var PEER_TIMEOUT_MS = 12000;
    var AUTO_SYNC_INTERVAL_MS = 30000;
    var MANIFEST_CACHE_MS = 10000;
    var BACKUPS_KEPT = 10;

    // minimal event emitter
    var listeners = {};
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
    function emit(ev, data) {
        (listeners[ev] || []).forEach(function (fn) {
            try { fn(data); } catch (e) { console.error(e); }
        });
    }

    // config dir keeps its original hidden name so existing installs keep their data
    var CONFIG_DIR = path.join(os.homedir(), '.willps-video-sync');
    var CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
    var config = null;

    function defaultConfig() {
        return {
            deviceId: crypto.randomBytes(8).toString('hex'),
            deviceName: os.hostname(),
            syncFolder: path.join(os.homedir(), 'Documents', 'willpsdk Premiere Sync'),
            twoWaySync: true,
            shared: [],        // {id, name, projectPath}
            subscriptions: []  // {peerDeviceId, peerName, projectId, name, dest, projectRel, snapshot, pushedSources, localOverrides, lastSync}
        };
    }

    function loadConfig() {
        try {
            if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
            if (fs.existsSync(CONFIG_FILE)) {
                config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                var d = defaultConfig();
                Object.keys(d).forEach(function (k) {
                    if (config[k] === undefined) config[k] = d[k];
                });
            } else {
                config = defaultConfig();
                saveConfig();
            }
        } catch (e) {
            console.error('Config load failed, using defaults', e);
            config = defaultConfig();
        }
    }

    function saveConfig() {
        try {
            if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        } catch (e) { console.error('Config save failed', e); }
    }

    function shortHash(s) {
        return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8);
    }

    function sanitizeName(s) {
        return String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    }

    function ensureDir(dir) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // join base + a peer-supplied rel, rejecting anything that escapes base
    // (don't trust rel from the network — e.g. "../../../etc/x")
    function safeJoin(base, rel) {
        var resolvedBase = path.resolve(base);
        var candidate = path.resolve(resolvedBase, rel);
        if (candidate !== resolvedBase && candidate.indexOf(resolvedBase + path.sep) !== 0) {
            throw new Error('Rejected unsafe path from peer: ' + rel);
        }
        return candidate;
    }

    function statOrNull(p) {
        try {
            var s = fs.statSync(p);
            return s.isFile() ? { size: s.size, mtime: Math.floor(s.mtimeMs) } : null;
        } catch (e) { return null; }
    }

    function xmlEscape(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function xmlUnescape(s) {
        return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g,
                    function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
    }

    // path.join but using the remote machine's separator (guessed from its
    // absolute path) — for building paths that live on the other computer
    function joinRemote(remoteDir) {
        var sep = (remoteDir.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(remoteDir)) ? '\\' : '/';
        var out = remoteDir.replace(/[\\/]+$/, '');
        for (var i = 1; i < arguments.length; i++) out += sep + arguments[i];
        return out;
    }

    // timestamped copy into "WVS Backups" next to the file, keep last N
    function backupFile(file) {
        try {
            if (!fs.existsSync(file)) return;
            var dir = path.join(path.dirname(file), 'WVS Backups');
            ensureDir(dir);
            var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var base = path.basename(file);
            fs.copyFileSync(file, path.join(dir, base + '.' + ts + '.bak'));
            var mine = fs.readdirSync(dir).filter(function (n) {
                return n.indexOf(base + '.') === 0 && /\.bak$/.test(n);
            }).sort();
            while (mine.length > BACKUPS_KEPT) {
                fs.unlinkSync(path.join(dir, mine.shift()));
            }
        } catch (e) { console.error('backup failed', e); }
    }

    function localIPs() {
        var out = [];
        var ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach(function (name) {
            (ifaces[name] || []).forEach(function (a) {
                if (a.family === 'IPv4' && !a.internal) {
                    out.push({ address: a.address, netmask: a.netmask });
                }
            });
        });
        return out;
    }

    function broadcastAddr(address, netmask) {
        var a = address.split('.').map(Number);
        var m = netmask.split('.').map(Number);
        return a.map(function (o, i) { return (o & m[i]) | (~m[i] & 255); }).join('.');
    }

    // a .prproj is gzipped XML (sometimes plain). media paths sit in
    // <ActualMediaFilePath> / <FilePath> / <OriginalFilePath>.
    function readPrprojXml(prprojPath) {
        var buf = fs.readFileSync(prprojPath);
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            return { xml: zlib.gunzipSync(buf).toString('utf8'), gzipped: true };
        }
        return { xml: buf.toString('utf8'), gzipped: false };
    }

    function parsePrprojMedia(prprojPath) {
        var xml = readPrprojXml(prprojPath).xml;
        var seen = {};
        var re = /<(ActualMediaFilePath|FilePath|OriginalFilePath)(?:\s[^>]*)?>([^<]+)<\/\1>/g;
        var m;
        while ((m = re.exec(xml)) !== null) {
            var p = xmlUnescape(m[2]).trim();
            // absolute paths only (windows drive or posix)
            if (/^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === '/') seen[p] = true;
        }
        return Object.keys(seen);
    }

    // rewrite media paths inside a .prproj (the relink step).
    // opts.backup -> keep a .original.prproj before first rewrite
    // opts.outFile -> write elsewhere, leave the input alone
    function rewriteProjectPaths(prprojFile, mapping, opts) {
        opts = opts || { backup: true };
        var info = readPrprojXml(prprojFile);
        var xml = info.xml;
        var replaced = 0;

        // longest first so nested paths don't collide
        Object.keys(mapping).sort(function (a, b) { return b.length - a.length; })
            .forEach(function (orig) {
                var neu = mapping[orig];
                var variants = [
                    [orig, neu],
                    [xmlEscape(orig), xmlEscape(neu)],
                    // sometimes stored with forward slashes even on windows
                    [orig.replace(/\\/g, '/'), neu],
                    [xmlEscape(orig.replace(/\\/g, '/')), xmlEscape(neu)]
                ];
                variants.forEach(function (v) {
                    if (v[0] === v[1] || xml.indexOf(v[0]) === -1) return;
                    var pieces = xml.split(v[0]);
                    replaced += pieces.length - 1;
                    xml = pieces.join(v[1]);
                });
            });

        var target = opts.outFile || prprojFile;
        if (replaced > 0 || opts.outFile) {
            if (opts.backup && !opts.outFile) {
                var bk = prprojFile.replace(/\.prproj$/i, '') + '.original.prproj';
                if (!fs.existsSync(bk)) fs.copyFileSync(prprojFile, bk);
            }
            var buf = NBuffer.from(xml, 'utf8');
            fs.writeFileSync(target, info.gzipped ? zlib.gzipSync(buf) : buf);
        }
        return replaced;
    }

    // layout inside a synced project folder:
    //   <ProjectName>.prproj
    //   media/<hash-of-source-dir>/<basename>
    var manifestCache = {}; // shareId -> {at, files, fileMap}

    function relForMedia(absPath) {
        return 'media/' + shortHash(path.dirname(absPath)) + '/' + path.basename(absPath);
    }

    // Hash of a .prproj's ungzipped XML. We can't use mtime/size to tell if a
    // project changed: Premiere re-saves it on trivial interactions and gzip
    // output differs every time, so a timestamp rule ends up pushing no-op
    // saves over real edits. Hashing the XML makes those saves invisible.
    // Cached by path+mtime+size; null if unreadable (mid-write).
    var xhashCache = {}; // absPath -> {size, mtime, hash}
    function xmlHashOf(prprojPath, st) {
        st = st || statOrNull(prprojPath);
        if (!st) return null;
        var c = xhashCache[prprojPath];
        if (c && c.size === st.size && c.mtime === st.mtime) return c.hash;
        try {
            var xml = readPrprojXml(prprojPath).xml;
            var h = crypto.createHash('md5').update(xml).digest('hex');
            xhashCache[prprojPath] = { size: st.size, mtime: st.mtime, hash: h };
            return h;
        } catch (e) { return null; }
    }

    function buildManifest(share) {
        var cached = manifestCache[share.id];
        if (cached && (Date.now() - cached.at) < MANIFEST_CACHE_MS) return cached.files;

        var files = [];
        var fileMap = {};

        function add(abs, rel, isProj) {
            var st = statOrNull(abs);
            if (!st) return;
            var entry = { rel: rel, orig: abs, size: st.size, mtime: st.mtime };
            if (isProj) {
                var h = xmlHashOf(abs, st);
                if (h) entry.xhash = h;
            }
            files.push(entry);
            fileMap[rel] = abs;
        }

        if (fs.existsSync(share.projectPath)) {
            add(share.projectPath, path.basename(share.projectPath), true);
            var media;
            try { media = parsePrprojMedia(share.projectPath); }
            catch (e) { media = []; console.error('prproj parse failed', e); }
            media.forEach(function (abs) {
                if (abs !== share.projectPath) add(abs, relForMedia(abs));
            });
        }

        manifestCache[share.id] = { at: Date.now(), files: files, fileMap: fileMap };
        return files;
    }

    function fileMapFor(share) {
        buildManifest(share);
        return manifestCache[share.id].fileMap;
    }

    // stable name (both sides derive the same one) for a pushed-in media file
    function pushedMediaName(rel) {
        return shortHash(rel) + '_' + sanitizeName(rel.split('/').pop());
    }

    // ---- http server ----
    var server = null;
    var serverPort = 0;

    function findShare(id) {
        for (var i = 0; i < config.shared.length; i++) {
            if (config.shared[i].id === id) return config.shared[i];
        }
        return null;
    }

    function sendJson(res, code, obj) {
        var body = JSON.stringify(obj);
        res.writeHead(code, {
            'Content-Type': 'application/json',
            'Content-Length': NBuffer.byteLength(body)
        });
        res.end(body);
    }

    function handleRequest(req, res) {
        var parsed = urlMod.parse(req.url, true);
        var parts = parsed.pathname.split('/').filter(Boolean);

        try {
            if (req.method === 'PUT') return handlePush(req, res, parts, parsed.query);
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' });

            if (parts[0] === 'ping') {
                return sendJson(res, 200, {
                    m: MAGIC, id: config.deviceId, name: config.deviceName
                });
            }

            if (parts[0] === 'projects' && parts.length === 1) {
                var list = config.shared.map(function (s) {
                    var files = buildManifest(s);
                    var total = 0, latest = 0;
                    files.forEach(function (f) {
                        total += f.size;
                        if (f.mtime > latest) latest = f.mtime;
                    });
                    return {
                        id: s.id, name: s.name,
                        fileCount: files.length, totalSize: total,
                        updated: latest,
                        available: fs.existsSync(s.projectPath)
                    };
                });
                return sendJson(res, 200, { deviceId: config.deviceId, deviceName: config.deviceName, projects: list });
            }

            if (parts[0] === 'project' && parts.length === 3 && parts[2] === 'manifest') {
                var share = findShare(parts[1]);
                if (!share) return sendJson(res, 404, { error: 'not found' });
                return sendJson(res, 200, {
                    id: share.id, name: share.name,
                    projectRel: path.basename(share.projectPath),
                    files: buildManifest(share)
                });
            }

            if (parts[0] === 'project' && parts.length === 3 && parts[2] === 'file') {
                var share2 = findShare(parts[1]);
                if (!share2) return sendJson(res, 404, { error: 'not found' });
                var rel = parsed.query.rel;
                var map = fileMapFor(share2);
                // only manifest-registered files are servable (traversal guard)
                var abs = map[rel];
                if (!abs || !fs.existsSync(abs)) return sendJson(res, 404, { error: 'file not found' });
                var st = fs.statSync(abs);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': st.size,
                    'X-WVS-Mtime': String(Math.floor(st.mtimeMs))
                });
                var stream = fs.createReadStream(abs);
                stream.on('error', function () { try { res.destroy(); } catch (e) {} });
                return stream.pipe(res);
            }

            sendJson(res, 404, { error: 'not found' });
        } catch (e) {
            console.error('server error', e);
            try { sendJson(res, 500, { error: String(e) }); } catch (e2) {}
        }
    }

    // receive a pushed file. writable targets are limited to files already in
    // the manifest, or new media that only ever lands in "WVS Media" under a
    // name we choose — never an arbitrary path from the client.
    function handlePush(req, res, parts, query) {
        if (!(parts[0] === 'project' && parts.length === 3 && parts[2] === 'push')) {
            req.resume();
            return sendJson(res, 404, { error: 'not found' });
        }
        var share = findShare(parts[1]);
        if (!share) { req.resume(); return sendJson(res, 404, { error: 'not found' }); }

        var rel = String(query.rel || '');
        var mtime = parseInt(query.mtime, 10) || Date.now();
        var map = fileMapFor(share);
        var destAbs = map[rel];
        if (!destAbs) {
            if (/^media\//.test(rel)) {
                destAbs = path.join(path.dirname(share.projectPath), 'WVS Media', pushedMediaName(rel));
            } else {
                req.resume();
                return sendJson(res, 400, { error: 'bad rel' });
            }
        }
        var isProj = destAbs === share.projectPath;

        try { ensureDir(path.dirname(destAbs)); }
        catch (e) { req.resume(); return sendJson(res, 500, { error: String(e) }); }

        var tmp = destAbs + '.wvs-part';
        var out = fs.createWriteStream(tmp);
        var failed = false;
        function bail(err) {
            if (failed) return;
            failed = true;
            try { out.destroy(); } catch (e) {}
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
            sendJson(res, 500, { error: String(err) });
        }
        out.on('error', bail);
        req.on('error', bail);
        req.pipe(out);
        out.on('finish', function () {
            if (failed) return;
            out.close(function () {
                try {
                    if (fs.existsSync(destAbs)) {
                        if (isProj) backupFile(destAbs);
                        fs.unlinkSync(destAbs);
                    }
                    fs.renameSync(tmp, destAbs);
                    fs.utimesSync(destAbs, new Date(), new Date(mtime));
                    delete manifestCache[share.id];
                    sendJson(res, 200, { ok: true, path: destAbs });
                    if (isProj) emit('push-received', { share: share });
                } catch (e) {
                    bail(e && e.code === 'EPERM'
                        ? 'File is locked (project open in Premiere on the other machine?): ' + e.message
                        : e);
                }
            });
        });
    }

    function startServer(attempt) {
        attempt = attempt || 0;
        var port = SERVER_PORT_BASE + attempt;
        server = http.createServer(handleRequest);
        server.on('error', function (err) {
            if (err.code === 'EADDRINUSE' && attempt < 10) {
                startServer(attempt + 1);
            } else {
                console.error('HTTP server failed', err);
                emit('error', 'Could not start file server: ' + err.message);
            }
        });
        server.listen(port, '0.0.0.0', function () {
            serverPort = port;
            emit('server-started', port);
        });
    }

    // ---- discovery ----
    var udp = null;
    var peers = {}; // deviceId -> {deviceId, name, host, port, lastSeen}
    var broadcastTimer = null;

    function startDiscovery() {
        udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        udp.on('message', function (msg, rinfo) {
            try {
                var data = JSON.parse(msg.toString('utf8'));
                if (data.m !== MAGIC || data.id === config.deviceId) return;
                var isNew = !peers[data.id];
                peers[data.id] = {
                    deviceId: data.id,
                    name: data.name,
                    host: rinfo.address,
                    port: data.port,
                    lastSeen: Date.now()
                };
                if (isNew) emit('peers-changed', getPeers());
            } catch (e) { /* not ours */ }
        });

        udp.on('error', function (err) {
            console.error('UDP error', err);
        });

        udp.bind(DISCOVERY_PORT, function () {
            try { udp.setBroadcast(true); } catch (e) {}
            broadcastTimer = setInterval(broadcastPresence, BROADCAST_INTERVAL_MS);
            broadcastPresence();
        });

        // prune dead peers
        setInterval(function () {
            var now = Date.now();
            var changed = false;
            Object.keys(peers).forEach(function (id) {
                if (now - peers[id].lastSeen > PEER_TIMEOUT_MS) {
                    delete peers[id];
                    changed = true;
                }
            });
            if (changed) emit('peers-changed', getPeers());
        }, 4000);
    }

    function broadcastPresence() {
        if (!udp || !serverPort) return;
        var payload = NBuffer.from(JSON.stringify({
            m: MAGIC, id: config.deviceId, name: config.deviceName, port: serverPort, v: 1
        }));
        var targets = { '255.255.255.255': true };
        localIPs().forEach(function (ip) {
            targets[broadcastAddr(ip.address, ip.netmask)] = true;
        });
        Object.keys(targets).forEach(function (addr) {
            try { udp.send(payload, 0, payload.length, DISCOVERY_PORT, addr); } catch (e) {}
        });
    }

    function getPeers() {
        return Object.keys(peers).map(function (id) { return peers[id]; });
    }

    // ---- http client ----
    function httpGetJson(host, port, urlPath) {
        return new Promise(function (resolve, reject) {
            var req = http.get({ host: host, port: port, path: urlPath, timeout: 8000 }, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    try {
                        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                        resolve(JSON.parse(NBuffer.concat(chunks).toString('utf8')));
                    } catch (e) { reject(e); }
                });
            });
            req.on('timeout', function () { req.destroy(new Error('timeout')); });
            req.on('error', reject);
        });
    }

    function downloadFile(host, port, urlPath, destFile, onBytes) {
        return new Promise(function (resolve, reject) {
            ensureDir(path.dirname(destFile));
            var tmp = destFile + '.wvs-part';
            var req = http.get({ host: host, port: port, path: urlPath, timeout: 20000 }, function (res) {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                var out = fs.createWriteStream(tmp);
                res.on('data', function (c) { if (onBytes) onBytes(c.length); });
                res.pipe(out);
                out.on('finish', function () {
                    out.close(function () {
                        try {
                            if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
                            fs.renameSync(tmp, destFile);
                            resolve();
                        } catch (e) { reject(e); }
                    });
                });
                out.on('error', reject);
                res.on('error', reject);
            });
            req.on('timeout', function () { req.destroy(new Error('timeout')); });
            req.on('error', reject);
        });
    }

    function uploadFile(host, port, urlPath, srcFile, onBytes) {
        return new Promise(function (resolve, reject) {
            var st = statOrNull(srcFile);
            if (!st) return reject(new Error('Local file missing: ' + srcFile));
            var req = http.request({
                host: host, port: port, path: urlPath, method: 'PUT',
                headers: { 'Content-Length': st.size }, timeout: 30000
            }, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    if (res.statusCode === 200) resolve(JSON.parse(NBuffer.concat(chunks).toString('utf8') || '{}'));
                    else reject(new Error('Push rejected (HTTP ' + res.statusCode + '): ' +
                        NBuffer.concat(chunks).toString('utf8').slice(0, 200)));
                });
            });
            req.on('timeout', function () { req.destroy(new Error('timeout')); });
            req.on('error', reject);
            var s = fs.createReadStream(srcFile);
            s.on('data', function (c) { if (onBytes) onBytes(c.length); });
            s.on('error', reject);
            s.pipe(req);
        });
    }

    // ---- sharing ----
    function shareProject(prprojPath) {
        prprojPath = String(prprojPath);
        if (!fs.existsSync(prprojPath)) throw new Error('Project file not found: ' + prprojPath);

        var existing = config.shared.filter(function (s) { return s.projectPath === prprojPath; });
        if (existing.length) {
            delete manifestCache[existing[0].id]; // force refresh
            return existing[0];
        }

        var share = {
            id: shortHash(prprojPath + ':' + config.deviceId),
            name: path.basename(prprojPath).replace(/\.prproj$/i, ''),
            projectPath: prprojPath
        };
        config.shared.push(share);
        saveConfig();
        emit('shared-changed', config.shared);
        return share;
    }

    function unshareProject(id) {
        config.shared = config.shared.filter(function (s) { return s.id !== id; });
        delete manifestCache[id];
        saveConfig();
        emit('shared-changed', config.shared);
    }

    // ---- syncing (subscriber side, two-way) ----
    var activeSyncs = {}; // subscriptionKey -> true

    // hooks the UI installs to reach into Premiere:
    //   beforeSync(sub)             -> save the open project so edits hit disk
    //   afterProjectPull(sub, file) -> reload the project if it's open
    var hooks = {};
    function setHooks(h) { hooks = h || {}; }

    function subKey(peerDeviceId, projectId) { return peerDeviceId + ':' + projectId; }

    function findSubscription(peerDeviceId, projectId) {
        for (var i = 0; i < config.subscriptions.length; i++) {
            var s = config.subscriptions[i];
            if (s.peerDeviceId === peerDeviceId && s.projectId === projectId) return s;
        }
        return null;
    }

    // Two-way sync against a peer's shared project. Per file, vs the snapshot
    // from last sync: remote-only change -> pull, local-only -> push, both ->
    // newest wins (prproj backed up first). New media the local project picked
    // up gets pushed into the peer's "WVS Media" folder.
    //
    // The .prproj is never sent as-is: it's reverse-relinked to the peer's
    // paths on push, and forward-relinked to local paths on pull.
    // onProgress: {phase, file, filesDone, filesTotal, bytesDone, bytesTotal}
    function syncProject(peerDeviceId, projectId, onProgress) {
        var peer = peers[peerDeviceId];
        if (!peer) return Promise.reject(new Error('Device is no longer online'));
        var key = subKey(peerDeviceId, projectId);
        if (activeSyncs[key]) return Promise.reject(new Error('Sync already in progress'));
        activeSyncs[key] = true;
        onProgress = onProgress || function () {};

        var sub = findSubscription(peerDeviceId, projectId);
        var twoWay = config.twoWaySync !== false;
        var manifest, dest, overrides, pushedSources;
        var pulls = [], pushMedia = [], pushNew = [], pushProj = false, pullProj = null;
        var bytesTotal = 0, bytesDone = 0, filesDone = 0, filesTotal = 0;

        function localPathFor(rel) {
            return (overrides && overrides[rel]) || safeJoin(dest, rel);
        }

        function progress(phase, file) {
            onProgress({ phase: phase, file: file, filesDone: filesDone,
                         filesTotal: filesTotal, bytesDone: bytesDone, bytesTotal: bytesTotal });
        }

        // let Premiere flush unsaved edits to disk before we compare
        var pre = Promise.resolve();
        if (sub && hooks.beforeSync) {
            pre = Promise.resolve()
                .then(function () { return hooks.beforeSync(sub); })
                .catch(function (e) { console.error('beforeSync hook failed', e); });
        }

        return pre
            .then(function () {
                return httpGetJson(peer.host, peer.port, '/project/' + projectId + '/manifest');
            })
            .then(function (m) {
                manifest = m;
                dest = sub ? sub.dest : path.join(config.syncFolder, sanitizeName(manifest.name));
                overrides = (sub && sub.localOverrides) || {};
                pushedSources = (sub && sub.pushedSources) || {};
                ensureDir(dest);

                var snapshot = (sub && sub.snapshot) || {};
                var projEntry = null;
                manifest.files.forEach(function (f) {
                    if (f.rel === manifest.projectRel) projEntry = f;
                });
                if (!projEntry) throw new Error('Project file missing on source machine');
                var remoteProjDir = projEntry.orig.replace(/[\\/][^\\/]+$/, '');

                // ---- decide per file ----------------------------------------
                manifest.files.forEach(function (f) {
                    var isProj = f.rel === manifest.projectRel;
                    var local = localPathFor(f.rel);
                    var st = statOrNull(local);
                    var snap = snapshot[f.rel];
                    // migrate pre-two-way snapshots (no lmtime recorded)
                    if (snap && snap.lmtime === undefined) {
                        snap = { size: snap.size, mtime: snap.mtime, lsize: snap.size, lmtime: snap.mtime };
                    }
                    var remoteChanged, localChanged;
                    if (isProj) {
                        // content comparison — a re-save with identical XML
                        // (Premiere does this constantly) is NOT a change
                        var lx = null;
                        if (st) {
                            lx = (snap && st.mtime === snap.lmtime && st.size === snap.lsize && snap.lxhash)
                                ? snap.lxhash : xmlHashOf(local, st);
                        }
                        remoteChanged = !snap ||
                            ((snap.xhash && f.xhash)
                                ? snap.xhash !== f.xhash
                                : (snap.mtime !== f.mtime || snap.size !== f.size));
                        localChanged = !!(st && snap &&
                            ((snap.lxhash && lx)
                                ? lx !== snap.lxhash
                                : (st.mtime !== snap.lmtime || st.size !== snap.lsize)));
                    } else {
                        remoteChanged = !snap || snap.mtime !== f.mtime || snap.size !== f.size;
                        localChanged = !!(st && snap && (st.mtime !== snap.lmtime || st.size !== snap.lsize));
                    }

                    if (!st) {
                        if (isProj) pullProj = f; else pulls.push(f);
                    } else if (remoteChanged && localChanged) {
                        // conflict: newest wins
                        if (f.mtime >= st.mtime) { if (isProj) pullProj = f; else pulls.push(f); }
                        else if (twoWay) { if (isProj) pushProj = true; else pushMedia.push(f); }
                    } else if (remoteChanged) {
                        // resume shortcut: first sync, media already fully present
                        if (!snap && !isProj && st.size === f.size) return;
                        if (isProj) pullProj = f; else pulls.push(f);
                    } else if (localChanged && twoWay) {
                        if (isProj) pushProj = true; else pushMedia.push(f);
                    }
                });

                // new media the local project now references
                var localProj = safeJoin(dest, manifest.projectRel);
                if (twoWay && pushProj && fs.existsSync(localProj)) {
                    var localMedia = [];
                    try { localMedia = parsePrprojMedia(localProj); } catch (e) {}
                    localMedia.forEach(function (abs) {
                        if (abs.toLowerCase().indexOf(dest.toLowerCase()) === 0) return; // managed copy
                        if (pushedSources[abs]) return;  // pushed previously
                        var st = statOrNull(abs);
                        if (!st) return;
                        pushNew.push({
                            abs: abs, size: st.size, mtime: st.mtime,
                            rel: 'media/b' + shortHash(config.deviceId + ':' + abs) + '/' + path.basename(abs)
                        });
                    });
                }

                // totals
                pulls.forEach(function (f) { bytesTotal += f.size; });
                if (pullProj) bytesTotal += pullProj.size;
                pushMedia.forEach(function (f) { bytesTotal += f.size; });
                pushNew.forEach(function (n) { bytesTotal += n.size; });
                if (pushProj) bytesTotal += (statOrNull(localProj) || { size: 0 }).size;
                filesTotal = pulls.length + (pullProj ? 1 : 0) + pushMedia.length +
                             pushNew.length + (pushProj ? 1 : 0);
                progress('starting');

                var chain = Promise.resolve();

                // 1. pull media
                pulls.forEach(function (f) {
                    chain = chain.then(function () {
                        progress('downloading', f.rel);
                        var urlPath = '/project/' + projectId + '/file?rel=' + encodeURIComponent(f.rel);
                        return downloadFile(peer.host, peer.port, urlPath, localPathFor(f.rel), function (n) {
                            bytesDone += n; progress('downloading', f.rel);
                        }).then(function () {
                            filesDone++;
                            try { fs.utimesSync(localPathFor(f.rel), new Date(), new Date(f.mtime)); } catch (e) {}
                        });
                    });
                });

                // 2. pull project file (backup + relink)
                if (pullProj) {
                    chain = chain.then(function () {
                        progress('downloading', pullProj.rel);
                        if (fs.existsSync(localProj)) backupFile(localProj);
                        var urlPath = '/project/' + projectId + '/file?rel=' + encodeURIComponent(pullProj.rel);
                        return downloadFile(peer.host, peer.port, urlPath, localProj, function (n) {
                            bytesDone += n; progress('downloading', pullProj.rel);
                        }).then(function () {
                            filesDone++;
                            progress('relinking');
                            var mapping = {};
                            manifest.files.forEach(function (f) {
                                if (f.rel === manifest.projectRel) return;
                                mapping[f.orig] = localPathFor(f.rel);
                            });
                            try { rewriteProjectPaths(localProj, mapping, { backup: false }); }
                            catch (e) { console.error('relink failed (project still synced)', e); }
                        });
                    });
                }

                // 3. push changed + new media
                pushMedia.forEach(function (f) {
                    chain = chain.then(function () {
                        progress('uploading', f.rel);
                        var src = localPathFor(f.rel);
                        var st = statOrNull(src);
                        var urlPath = '/project/' + projectId + '/push?rel=' + encodeURIComponent(f.rel) +
                                      '&mtime=' + st.mtime;
                        return uploadFile(peer.host, peer.port, urlPath, src, function (n) {
                            bytesDone += n; progress('uploading', f.rel);
                        }).then(function () { filesDone++; });
                    });
                });

                var newRemotePaths = {}; // absLocal -> remote abs path (for relink + bookkeeping)
                pushNew.forEach(function (n) {
                    chain = chain.then(function () {
                        progress('uploading', path.basename(n.abs));
                        var urlPath = '/project/' + projectId + '/push?rel=' + encodeURIComponent(n.rel) +
                                      '&mtime=' + n.mtime;
                        return uploadFile(peer.host, peer.port, urlPath, n.abs, function (b) {
                            bytesDone += b; progress('uploading', path.basename(n.abs));
                        }).then(function (resp) {
                            filesDone++;
                            newRemotePaths[n.abs] = resp.path ||
                                joinRemote(remoteProjDir, 'WVS Media', pushedMediaName(n.rel));
                        });
                    });
                });

                // 4. push project file (reverse-relinked temp copy)
                if (pushProj) {
                    chain = chain.then(function () {
                        progress('uploading', manifest.projectRel);
                        var reverse = {};
                        manifest.files.forEach(function (f) {
                            if (f.rel === manifest.projectRel) return;
                            reverse[localPathFor(f.rel)] = f.orig;
                        });
                        Object.keys(newRemotePaths).forEach(function (abs) {
                            reverse[abs] = newRemotePaths[abs];
                        });
                        Object.keys(pushedSources).forEach(function (abs) {
                            reverse[abs] = pushedSources[abs];
                        });
                        var tmpPush = path.join(dest, '.wvs-push.prproj');
                        fs.copyFileSync(localProj, tmpPush);
                        try { rewriteProjectPaths(tmpPush, reverse, { backup: false }); }
                        catch (e) { console.error('reverse relink failed', e); }
                        var st = statOrNull(localProj);
                        var urlPath = '/project/' + projectId + '/push?rel=' +
                                      encodeURIComponent(manifest.projectRel) + '&mtime=' + st.mtime;
                        return uploadFile(peer.host, peer.port, urlPath, tmpPush, function (n) {
                            bytesDone += n; progress('uploading', manifest.projectRel);
                        }).then(function () {
                            filesDone++;
                            try { fs.unlinkSync(tmpPush); } catch (e) {}
                        }, function (err) {
                            try { fs.unlinkSync(tmpPush); } catch (e) {}
                            throw err;
                        });
                    });
                }

                return chain.then(function () {
                    return { pushed: pushMedia.length + pushNew.length + (pushProj ? 1 : 0),
                             newRemotePaths: newRemotePaths };
                });
            })
            .then(function (r) {
                // if we pushed, the source manifest changed — refetch it
                var refetch = r.pushed > 0
                    ? httpGetJson(peer.host, peer.port, '/project/' + projectId + '/manifest')
                    : Promise.resolve(manifest);
                return refetch.then(function (m2) {
                    // remember our uploads so we don't re-download them next time
                    Object.keys(r.newRemotePaths).forEach(function (abs) {
                        pushedSources[abs] = r.newRemotePaths[abs];
                        m2.files.forEach(function (f) {
                            if (f.orig === r.newRemotePaths[abs]) overrides[f.rel] = abs;
                        });
                    });

                    var snapshot = {};
                    m2.files.forEach(function (f) {
                        var local = localPathFor(f.rel);
                        var st = statOrNull(local);
                        snapshot[f.rel] = {
                            size: f.size, mtime: f.mtime,
                            lsize: st ? st.size : 0, lmtime: st ? st.mtime : 0
                        };
                        if (f.rel === m2.projectRel) {
                            if (f.xhash) snapshot[f.rel].xhash = f.xhash;
                            var lh = st ? xmlHashOf(local, st) : null;
                            if (lh) snapshot[f.rel].lxhash = lh;
                        }
                    });

                    if (!sub) {
                        sub = { peerDeviceId: peerDeviceId, peerName: peer.name, projectId: projectId };
                        config.subscriptions.push(sub);
                    }
                    sub.name = m2.name;
                    sub.dest = dest;
                    sub.projectRel = m2.projectRel;
                    sub.snapshot = snapshot;
                    sub.pushedSources = pushedSources;
                    sub.localOverrides = overrides;
                    sub.lastSync = Date.now();
                    saveConfig();

                    delete activeSyncs[key];
                    progress('done');
                    emit('subscriptions-changed', config.subscriptions);

                    var projectFile = safeJoin(dest, m2.projectRel);
                    if (pullProj && hooks.afterProjectPull) {
                        try { hooks.afterProjectPull(sub, projectFile); }
                        catch (e) { console.error('afterProjectPull hook failed', e); }
                    }
                    return {
                        downloaded: pulls.length + (pullProj ? 1 : 0),
                        pushed: r.pushed,
                        dest: dest,
                        projectFile: projectFile
                    };
                });
            })
            .catch(function (err) {
                delete activeSyncs[key];
                throw err;
            });
    }

    function removeSubscription(peerDeviceId, projectId) {
        config.subscriptions = config.subscriptions.filter(function (s) {
            return !(s.peerDeviceId === peerDeviceId && s.projectId === projectId);
        });
        saveConfig();
        emit('subscriptions-changed', config.subscriptions);
    }

    // ---- auto-sync loop ----
    function subscriptionNeedsSync(sub, manifest) {
        var snapshot = sub.snapshot || {};
        return manifest.files.some(function (f) {
            var snap = snapshot[f.rel];
            if (!snap) return true;
            var isProj = f.rel === sub.projectRel;
            var remoteChanged = (isProj && snap.xhash && f.xhash)
                ? snap.xhash !== f.xhash
                : (snap.mtime !== f.mtime || snap.size !== f.size);
            if (remoteChanged) return true;
            var local;
            try {
                local = (sub.localOverrides && sub.localOverrides[f.rel]) ||
                        safeJoin(sub.dest, f.rel);
            } catch (e) { return false; } // hostile rel — ignore it here; syncProject rejects it loudly
            var st = statOrNull(local);
            if (!st) return true; // local copy missing
            var lm = snap.lmtime !== undefined ? snap.lmtime : snap.mtime;
            var ls = snap.lsize !== undefined ? snap.lsize : snap.size;
            if (st.mtime === lm && st.size === ls) return false;
            if (isProj && snap.lxhash) {
                var h = xmlHashOf(local, st);
                if (h && h === snap.lxhash) return false; // no-op re-save — not a change
            }
            return true; // local change (push needed)
        });
    }

    function autoSyncTick() {
        config.subscriptions.forEach(function (sub) {
            var peer = peers[sub.peerDeviceId];
            if (!peer) return;
            var key = subKey(sub.peerDeviceId, sub.projectId);
            if (activeSyncs[key]) return;

            httpGetJson(peer.host, peer.port, '/project/' + sub.projectId + '/manifest')
                .then(function (manifest) {
                    if (subscriptionNeedsSync(sub, manifest)) {
                        emit('auto-sync-started', sub);
                        return syncProject(sub.peerDeviceId, sub.projectId, function (p) {
                            emit('sync-progress', { sub: sub, progress: p });
                        }).then(function (res) {
                            emit('auto-sync-finished', { sub: sub, result: res });
                        });
                    }
                })
                .catch(function (e) { /* peer flaky — retry next tick */ });
        });
    }

    // ---- public api ----
    function start() {
        loadConfig();
        startServer(0);
        startDiscovery();
        setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);
        emit('started', getState());
    }

    function getState() {
        return {
            deviceId: config.deviceId,
            deviceName: config.deviceName,
            syncFolder: config.syncFolder,
            twoWaySync: config.twoWaySync !== false,
            serverPort: serverPort,
            ips: localIPs().map(function (i) { return i.address; }),
            shared: config.shared,
            subscriptions: config.subscriptions,
            peers: getPeers()
        };
    }

    function setSettings(opts) {
        if (opts.deviceName) config.deviceName = String(opts.deviceName).slice(0, 60);
        if (opts.syncFolder) config.syncFolder = String(opts.syncFolder);
        if (opts.twoWaySync !== undefined) config.twoWaySync = !!opts.twoWaySync;
        saveConfig();
        emit('settings-changed', getState());
    }

    function fetchPeerProjects(peerDeviceId) {
        var peer = peers[peerDeviceId];
        if (!peer) return Promise.reject(new Error('Device offline'));
        return httpGetJson(peer.host, peer.port, '/projects');
    }

    return {
        available: true,
        start: start,
        on: on,
        setHooks: setHooks,
        getState: getState,
        setSettings: setSettings,
        shareProject: shareProject,
        unshareProject: unshareProject,
        getPeers: getPeers,
        fetchPeerProjects: fetchPeerProjects,
        syncProject: syncProject,
        removeSubscription: removeSubscription,
        parsePrprojMedia: parsePrprojMedia,
        rewriteProjectPaths: rewriteProjectPaths
    };
})();
