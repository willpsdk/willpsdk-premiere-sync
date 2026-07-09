// willpsdk Premiere Sync — panel UI.
// Talks to Premiere through CSInterface/ExtendScript and to the network
// layer through the WVS engine (same JS context).

'use strict';

var cs = new CSInterface();

// helpers
function $(id) { return document.getElementById(id); }

function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function fmtBytes(n) {
    if (n === 0 || !n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtAgo(ts) {
    if (!ts) return 'never';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
}

function toast(msg, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
}

function evalJsx(script) {
    return new Promise(function (resolve) {
        cs.evalScript(script, function (res) {
            if (!res || res === 'EvalScript error.') {
                resolve({ ok: false, error: 'Premiere scripting error' });
                return;
            }
            try { resolve(JSON.parse(res)); }
            catch (e) { resolve({ ok: false, error: 'Bad response: ' + res }); }
        });
    });
}

function jsxStr(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// live sync progress, keyed by subscription
var progressState = {}; // "peerId:projectId" -> progress object

// no node = no engine; show a message instead of a broken panel
if (!WVS.available) {
    $('fatal').classList.remove('hidden');
    $('fatal').innerHTML =
        '<b>Node.js is not available in this panel.</b><br>' +
        'The extension was installed without its manifest, or an old CEP runtime is in use. ' +
        'Reinstall with the provided installer and restart Premiere Pro.';
    $('btn-add').disabled = true;
} else {
    boot();
}

function boot() {

    // rendering
    function renderDeviceLine() {
        var st = WVS.getState();
        $('device-line').textContent =
            st.deviceName + '  ·  ' + (st.ips[0] || 'no network') +
            (st.serverPort ? ':' + st.serverPort : '') +
            '  ·  ' + st.peers.length + ' device' + (st.peers.length === 1 ? '' : 's') + ' found';
        $('status-dot').classList.toggle('online', !!st.serverPort);
    }

    function renderShared() {
        var st = WVS.getState();
        var list = $('shared-list');
        list.innerHTML = '';
        if (!st.shared.length) {
            list.appendChild(el('div', 'empty',
                'Nothing shared yet. Click Add Project and pick a project on this computer to share it with your other machines.'));
            return;
        }
        st.shared.forEach(function (s) {
            var card = el('div', 'card');
            var r1 = el('div', 'row1');
            r1.appendChild(el('div', 'name', s.name));
            var acts = el('div', 'card-actions');
            var rm = el('button', 'btn small danger', 'Stop sharing');
            rm.onclick = function () { WVS.unshareProject(s.id); };
            acts.appendChild(rm);
            r1.appendChild(acts);
            card.appendChild(r1);
            card.appendChild(el('div', 'meta', s.projectPath));
            list.appendChild(card);
        });
    }

    function progressCard(prog) {
        var wrap = el('div', 'progress-wrap');
        var bar = el('div', 'progress-bar');
        var fill = el('div');
        var pct = prog.bytesTotal ? Math.round(prog.bytesDone / prog.bytesTotal * 100) : 0;
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        wrap.appendChild(bar);
        var verb = prog.phase === 'uploading' ? '↑ ' : prog.phase === 'downloading' ? '↓ ' : '';
        var label = prog.phase === 'relinking' ? 'Relinking media paths…'
            : verb + (prog.file ? prog.file + '  ·  ' : '') +
              fmtBytes(prog.bytesDone) + ' / ' + fmtBytes(prog.bytesTotal) +
              '  (' + prog.filesDone + '/' + prog.filesTotal + ' files)';
        wrap.appendChild(el('div', 'progress-label', label));
        return wrap;
    }

    function renderSynced() {
        var st = WVS.getState();
        var list = $('synced-list');
        list.innerHTML = '';

        // a first-time sync has no subscription yet, still show its progress
        var subKeys = {};
        st.subscriptions.forEach(function (s) { subKeys[s.peerDeviceId + ':' + s.projectId] = true; });
        Object.keys(progressState).forEach(function (key) {
            if (subKeys[key]) return;
            var prog = progressState[key];
            var card = el('div', 'card');
            var r1 = el('div', 'row1');
            var name = el('div', 'name', (prog.name || 'Project') + ' ');
            name.appendChild(el('span', 'badge busy', 'First sync'));
            r1.appendChild(name);
            card.appendChild(r1);
            card.appendChild(progressCard(prog));
            list.appendChild(card);
        });

        if (!st.subscriptions.length) {
            if (Object.keys(progressState).length) return;
            list.appendChild(el('div', 'empty',
                'No synced projects. Click Add Project on this machine and choose a project from another computer.'));
            return;
        }
        var peersById = {};
        st.peers.forEach(function (p) { peersById[p.deviceId] = p; });

        st.subscriptions.forEach(function (sub) {
            var key = sub.peerDeviceId + ':' + sub.projectId;
            var prog = progressState[key];
            var online = !!peersById[sub.peerDeviceId];

            var card = el('div', 'card');
            var r1 = el('div', 'row1');
            var nameWrap = el('div', 'name', sub.name + ' ');
            var badge;
            if (prog && prog.phase !== 'done') {
                badge = el('span', 'badge busy', 'Syncing');
            } else if (online) {
                badge = el('span', 'badge ok', 'Up to date');
            } else {
                badge = el('span', 'badge off', 'Source offline');
            }
            nameWrap.appendChild(badge);
            r1.appendChild(nameWrap);

            var acts = el('div', 'card-actions');
            var open = el('button', 'btn small primary', 'Open');
            open.title = 'Open this project in Premiere Pro';
            open.onclick = function () {
                var pf = sub.dest.replace(/[\\/]+$/, '') +
                         (navigator.platform.indexOf('Win') >= 0 ? '\\' : '/') + sub.projectRel;
                evalJsx('WVS_openProject(' + jsxStr(pf) + ')').then(function (r) {
                    if (!r.ok) toast(r.error || 'Could not open project', 'err');
                });
            };
            var resync = el('button', 'btn small', 'Sync now');
            resync.disabled = !online || (prog && prog.phase !== 'done');
            resync.onclick = function () { startSync(sub.peerDeviceId, sub.projectId, sub.name); };
            var rm = el('button', 'btn small danger', '✕');
            rm.title = 'Stop syncing (downloaded files are kept)';
            rm.onclick = function () { WVS.removeSubscription(sub.peerDeviceId, sub.projectId); };
            acts.appendChild(open); acts.appendChild(resync); acts.appendChild(rm);
            r1.appendChild(acts);
            card.appendChild(r1);

            card.appendChild(el('div', 'meta',
                'from ' + (sub.peerName || 'unknown') + '  ·  last sync ' + fmtAgo(sub.lastSync)));

            if (prog && prog.phase !== 'done') {
                card.appendChild(progressCard(prog));
            }
            list.appendChild(card);
        });
    }

    function renderPeers() {
        var st = WVS.getState();
        var list = $('peers-list');
        list.innerHTML = '';
        if (!st.peers.length) {
            list.appendChild(el('div', 'empty',
                'Looking for other computers running willpsdk Premiere Sync… Make sure the panel is open there and both machines are on the same network.'));
            return;
        }
        st.peers.forEach(function (p) {
            var card = el('div', 'card');
            var r1 = el('div', 'row1');
            var name = el('div', 'name', p.name + ' ');
            name.appendChild(el('span', 'badge ok', 'Online'));
            r1.appendChild(name);
            card.appendChild(r1);
            card.appendChild(el('div', 'meta', p.host + ':' + p.port));
            list.appendChild(card);
        });
    }

    function renderAll() {
        renderDeviceLine(); renderShared(); renderSynced(); renderPeers();
    }

    // syncing
    function startSync(peerDeviceId, projectId, name) {
        var key = peerDeviceId + ':' + projectId;
        if (progressState[key]) {
            toast('"' + name + '" is already syncing — progress is shown on its card.');
            return;
        }
        // manual sync means "send my version now" — drop any auto-save hold
        // (the incoming version is still safe in WVS Backups)
        WVS.getState().subscriptions.forEach(function (s) {
            if (s.peerDeviceId === peerDeviceId && s.projectId === projectId &&
                s.dest && s.projectRel) {
                delete pendingDiskUpdate[normPath(localProjectFileOf(s))];
            }
        });
        progressState[key] = { phase: 'starting', name: name, bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 };
        renderSynced();
        WVS.syncProject(peerDeviceId, projectId, function (p) {
            p.name = name;
            progressState[key] = p;
            renderSynced();
        }).then(function (res) {
            delete progressState[key];
            renderSynced();
            var msg = '"' + name + '" synced';
            if (res.downloaded || res.pushed) {
                msg += ' — ' + res.downloaded + ' received, ' + res.pushed + ' sent back.';
            } else {
                msg += ' — already up to date.';
            }
            toast(msg, 'ok');
        }).catch(function (err) {
            delete progressState[key];
            renderSynced();
            if (/already in progress/i.test(err.message)) {
                toast('"' + name + '" is already syncing — progress is shown on its card.');
            } else {
                toast('Sync failed: ' + err.message, 'err');
            }
        });
    }

    // add project modal
    function openModal(id) { $(id).classList.remove('hidden'); }
    function closeModal(id) { $(id).classList.add('hidden'); }

    document.querySelectorAll('[data-close]').forEach(function (b) {
        b.onclick = function () { closeModal(b.getAttribute('data-close')); };
    });
    document.querySelectorAll('.modal-backdrop').forEach(function (bd) {
        bd.addEventListener('mousedown', function (e) {
            if (e.target === bd) bd.classList.add('hidden');
        });
    });

    // tabs
    document.querySelectorAll('.tab').forEach(function (t) {
        t.onclick = function () {
            document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
            t.classList.add('active');
            $('tab-local').classList.toggle('hidden', t.getAttribute('data-tab') !== 'local');
            $('tab-network').classList.toggle('hidden', t.getAttribute('data-tab') !== 'network');
            if (t.getAttribute('data-tab') === 'network') refreshNetworkTab();
        };
    });

    $('btn-add').onclick = function () {
        openModal('modal-add');
        refreshLocalTab();
        refreshNetworkTab();
    };

    function shareAndClose(prprojPath) {
        try {
            var share = WVS.shareProject(prprojPath);
            closeModal('modal-add');
            toast('"' + share.name + '" is now shared on your network.', 'ok');
            renderShared();
        } catch (e) {
            toast(e.message, 'err');
        }
    }

    function refreshLocalTab() {
        var list = $('add-local-list');
        list.innerHTML = '';
        list.appendChild(el('div', 'empty', 'Checking for an open project…'));
        evalJsx('WVS_getActiveProject()').then(function (r) {
            list.innerHTML = '';
            if (r.ok) {
                var card = el('div', 'card clickable');
                var r1 = el('div', 'row1');
                var name = el('div', 'name', r.name.replace(/\.prproj$/i, '') + ' ');
                name.appendChild(el('span', 'badge ok', 'Open now'));
                r1.appendChild(name);
                card.appendChild(r1);
                card.appendChild(el('div', 'meta', r.path));
                card.onclick = function () { shareAndClose(r.path); };
                list.appendChild(card);
            } else {
                list.appendChild(el('div', 'empty',
                    'No project is open in Premiere. Use Browse below to pick a .prproj file.'));
            }
        });
    }

    $('btn-browse').onclick = function () {
        var res = window.cep.fs.showOpenDialogEx(false, false,
            'Choose a Premiere Pro project to share', null, ['prproj']);
        if (res && res.data && res.data.length) shareAndClose(res.data[0]);
    };

    function refreshNetworkTab() {
        var list = $('add-network-list');
        var peers = WVS.getPeers();
        if (!peers.length) {
            list.innerHTML = '';
            list.appendChild(el('div', 'empty',
                'No other computers found yet. Open this panel on your other machine (same network) — it appears here within a few seconds.'));
            return;
        }
        list.innerHTML = '';
        var loading = el('div', 'empty', 'Loading projects…');
        list.appendChild(loading);

        var done = 0, any = false;
        peers.forEach(function (peer) {
            WVS.fetchPeerProjects(peer.deviceId).then(function (resp) {
                done++;
                loading.remove();
                var projects = (resp.projects || []).filter(function (p) { return p.available; });
                if (projects.length) {
                    any = true;
                    list.appendChild(el('div', 'peer-group-label', peer.name));
                    projects.forEach(function (p) {
                        var card = el('div', 'card clickable');
                        var r1 = el('div', 'row1');
                        r1.appendChild(el('div', 'name', p.name));
                        card.appendChild(r1);
                        card.appendChild(el('div', 'meta',
                            p.fileCount + ' files  ·  ' + fmtBytes(p.totalSize)));
                        card.onclick = function () {
                            closeModal('modal-add');
                            startSync(peer.deviceId, p.id, p.name);
                        };
                        list.appendChild(card);
                    });
                }
                if (done === peers.length && !any) {
                    list.appendChild(el('div', 'empty',
                        'Devices found, but nothing is shared yet. On the other computer, click Add Project → This computer.'));
                }
            }).catch(function () {
                done++;
                loading.remove();
                if (done === peers.length && !any) {
                    list.appendChild(el('div', 'empty', 'Could not reach the other computer. Check firewall settings.'));
                }
            });
        });
    }

    // settings
    $('btn-settings').onclick = function () {
        var st = WVS.getState();
        $('set-device-name').value = st.deviceName;
        $('set-sync-folder').value = st.syncFolder;
        $('set-two-way').checked = st.twoWaySync;
        $('settings-net-info').textContent =
            'This device: ' + st.ips.join(', ') + '  ·  file server port ' + st.serverPort +
            '  ·  discovery port 41336 (UDP). Allow these through your firewall on private networks.';
        openModal('modal-settings');
    };

    $('btn-pick-folder').onclick = function () {
        var res = window.cep.fs.showOpenDialogEx(false, true, 'Choose sync folder', $('set-sync-folder').value);
        if (res && res.data && res.data.length) $('set-sync-folder').value = res.data[0];
    };

    $('btn-save-settings').onclick = function () {
        WVS.setSettings({
            deviceName: $('set-device-name').value.trim() || undefined,
            syncFolder: $('set-sync-folder').value.trim() || undefined,
            twoWaySync: $('set-two-way').checked
        });
        closeModal('modal-settings');
        toast('Settings saved.', 'ok');
        renderAll();
    };

    // premiere bridge (hands-free).
    // once a minute, silently save the open project if it's one we sync and
    // has unsaved changes, so the engine can send the edits. when a newer
    // version arrives, reload it in Premiere — but only if there are no
    // unsaved changes, so we never throw away work.

    function normPath(p) {
        return String(p || '').replace(/\//g, '\\').toLowerCase();
    }

    function localProjectFileOf(sub) {
        var sep = sub.dest.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(sub.dest) ? '\\' : '/';
        return sub.dest.replace(/[\\/]+$/, '') + sep + sub.projectRel;
    }

    function trackedProjectFiles() {
        var st = WVS.getState();
        var out = {};
        st.shared.forEach(function (s) { out[normPath(s.projectPath)] = true; });
        st.subscriptions.forEach(function (s) {
            if (s.dest && s.projectRel) out[normPath(localProjectFileOf(s))] = true;
        });
        return out;
    }

    // a newer version landed on disk but Premiere still has the old one open
    // (couldn't reload due to unsaved changes). hold off auto-save until the
    // reload happens, or we'd overwrite the new file with the stale copy.
    var pendingDiskUpdate = {}; // normPath -> {file, source}

    function saveIfDirtyAndTracked(mustMatchFile) {
        return evalJsx('WVS_getProjectStatus()').then(function (s) {
            if (!s.ok || !s.open) return false;
            if (mustMatchFile && normPath(s.path) !== normPath(mustMatchFile)) return false;
            if (!mustMatchFile && !trackedProjectFiles()[normPath(s.path)]) return false;
            // skip only when Premiere says it's clean. if the dirty flag isn't
            // available (null), save anyway — a no-op save is harmless now that
            // the engine compares project contents by hash.
            if (s.dirty === false) return false;
            if (pendingDiskUpdate[normPath(s.path)]) return false; // newer version on disk
            return evalJsx('WVS_saveActiveProject()').then(function (r) {
                return !!r.ok;
            });
        });
    }

    setInterval(function () {
        saveIfDirtyAndTracked(null);
        // retry any reloads Premiere couldn't take yet
        Object.keys(pendingDiskUpdate).forEach(function (k) {
            var p = pendingDiskUpdate[k];
            reloadIfCleanAndOpen(p.file, p.source, true);
        });
    }, 60000);

    function reloadIfCleanAndOpen(file, sourceName, quiet) {
        evalJsx('WVS_getProjectStatus()').then(function (s) {
            if (!s.ok || !s.open || normPath(s.path) !== normPath(file)) return;
            if (s.dirty === true) {
                if (!pendingDiskUpdate[normPath(file)] && !quiet) {
                    toast('"' + (sourceName || 'Another computer') + '" sent a newer version of the open project, but you have unsaved changes here. Save to keep your version, or close the project without saving to take theirs.', 'err');
                }
                pendingDiskUpdate[normPath(file)] = { file: file, source: sourceName };
                return;
            }
            evalJsx('WVS_reloadActiveProject(' + jsxStr(file) + ')').then(function (r) {
                if (r.ok) {
                    delete pendingDiskUpdate[normPath(file)];
                    toast('Project reloaded with the latest changes from ' + (sourceName || 'the network') + '.', 'ok');
                }
            });
        });
    }

    WVS.setHooks({
        beforeSync: function (sub) {
            return saveIfDirtyAndTracked(localProjectFileOf(sub));
        },
        afterProjectPull: function (sub, projectFile) {
            reloadIfCleanAndOpen(projectFile, sub.peerName);
        }
    });

    // engine events
    WVS.on('server-started', renderDeviceLine);
    WVS.on('peers-changed', function () { renderDeviceLine(); renderPeers(); renderSynced(); });
    WVS.on('shared-changed', renderShared);
    WVS.on('subscriptions-changed', renderSynced);
    WVS.on('sync-progress', function (d) {
        progressState[d.sub.peerDeviceId + ':' + d.sub.projectId] = d.progress;
        renderSynced();
    });
    WVS.on('auto-sync-finished', function (d) {
        var sub = d.sub, res = d.result || {};
        delete progressState[sub.peerDeviceId + ':' + sub.projectId];
        renderSynced();
        var bits = [];
        if (res.downloaded) bits.push(res.downloaded + ' received');
        if (res.pushed) bits.push(res.pushed + ' sent to ' + (sub.peerName || 'source'));
        toast('"' + sub.name + '" synced' + (bits.length ? ' — ' + bits.join(', ') + '.' : '.'), 'ok');
    });
    WVS.on('push-received', function (d) {
        toast('"' + d.share.name + '" was updated from another computer.', 'ok');
        reloadIfCleanAndOpen(d.share.projectPath, 'another computer');
        renderShared();
    });
    WVS.on('error', function (msg) { toast(msg, 'err'); });

    // refresh relative timestamps + peer counts
    setInterval(function () { renderDeviceLine(); renderPeers(); }, 5000);

    WVS.start();
    renderAll();
}
