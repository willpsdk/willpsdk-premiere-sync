// willpsdk Premiere Sync — ExtendScript bridge for Premiere Pro.
// ExtendScript has no JSON, so every function hand-builds a JSON string
// (WVS_q does the escaping).

function WVS_q(s) {
    s = String(s);
    return '"' + s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') + '"';
}

/* Returns the currently open project (name + absolute path). */
function WVS_getActiveProject() {
    try {
        if (app && app.project && app.project.path) {
            return '{"ok":true,"name":' + WVS_q(app.project.name) +
                   ',"path":' + WVS_q(app.project.path) + '}';
        }
        return '{"ok":false,"error":"No project is currently open"}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}

/* Recursively collects media file paths from the active project. */
function WVS_collectMedia(item, out) {
    if (!item) return;
    try {
        // ProjectItemType.BIN === 2
        if (item.type === 2 && item.children) {
            for (var i = 0; i < item.children.numItems; i++) {
                WVS_collectMedia(item.children[i], out);
            }
        } else if (item.getMediaPath) {
            var p = item.getMediaPath();
            if (p && p.length) out[p] = true;
        }
    } catch (e) { /* skip unreadable items */ }
}

function WVS_getActiveProjectMedia() {
    try {
        if (!(app && app.project && app.project.rootItem)) {
            return '{"ok":false,"error":"No project is currently open"}';
        }
        var seen = {};
        WVS_collectMedia(app.project.rootItem, seen);
        var parts = [];
        for (var k in seen) {
            if (seen.hasOwnProperty(k)) parts.push(WVS_q(k));
        }
        return '{"ok":true,"projectPath":' + WVS_q(app.project.path) +
               ',"files":[' + parts.join(',') + ']}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}

/* open project + unsaved-changes flag (dirty is null when unsupported) */
function WVS_getProjectStatus() {
    try {
        if (app && app.project && app.project.path) {
            var dirty = 'null';
            try {
                if (typeof app.project.dirty === 'boolean') {
                    dirty = app.project.dirty ? 'true' : 'false';
                }
            } catch (e) { /* older Premiere without the flag */ }
            return '{"ok":true,"open":true,"path":' + WVS_q(app.project.path) +
                   ',"dirty":' + dirty + '}';
        }
        return '{"ok":true,"open":false}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}

/* save the open project (flushes edits to disk) */
function WVS_saveActiveProject() {
    try {
        if (!(app && app.project && app.project.path)) {
            return '{"ok":false,"error":"No project open"}';
        }
        app.project.save();
        return '{"ok":true}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}

/* close without saving and reopen from disk, to show a freshly synced
 * version. caller must confirm there are no unsaved changes first. */
function WVS_reloadActiveProject(path) {
    try {
        var f = new File(path);
        if (!f.exists) {
            return '{"ok":false,"error":' + WVS_q('File not found: ' + path) + '}';
        }
        try {
            // closeDocument(saveFirst, promptIfDirty) — both off on purpose
            app.project.closeDocument(0, 0);
        } catch (e1) {
            try { app.project.closeDocument(); } catch (e2) { /* older API */ }
        }
        app.openDocument(path);
        return '{"ok":true}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}

/* open a .prproj in Premiere */
function WVS_openProject(path) {
    try {
        var f = new File(path);
        if (!f.exists) {
            return '{"ok":false,"error":' + WVS_q('File not found: ' + path) + '}';
        }
        app.openDocument(path);
        return '{"ok":true}';
    } catch (e) {
        return '{"ok":false,"error":' + WVS_q('' + e) + '}';
    }
}
