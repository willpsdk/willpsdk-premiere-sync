# willpsdk Premiere Sync

Sync Premiere Pro projects — **project file + all media** — between your computers over the local network, straight from a panel inside Premiere. No cloud, no accounts, no extra apps.

Works on **Windows and macOS** (Premiere Pro 2019 / v13 and newer).

## How it works

- On **computer A**: open the panel → **+ Add Project** → *This computer* → click your open project (or browse to a `.prproj`). It's now shared on your LAN.
- On **computer B**: open the panel → **+ Add Project** → *From network* → your project appears under computer A's name → click it. The project file **and every media file it uses** download into your sync folder, with a progress bar.
- Media paths inside the downloaded `.prproj` are **automatically rewritten** to point at the local copies, so the project opens with media online.
- After that it **stays in sync automatically in both directions**: every 30 seconds the panel compares both sides and transfers only what changed.
  - Edit on the source PC → your laptop pulls the changes.
  - Edit on the laptop (cuts, new footage from anywhere on its disk) → after you **save in Premiere**, the changes and any new media are pushed back to the PC. New files land in a `WVS Media` folder next to the source project, and the project file is path-translated for each machine automatically.
  - **Conflicts** (same file saved on both machines between syncs): the newest save wins, and the losing `.prproj` is stored in a `WVS Backups` folder next to it (last 10 kept) — nothing is ever lost.
  - Two-way can be turned off in ⚙ Settings if you want a strict one-way mirror.

Everything runs inside the CEP panel itself (discovery via UDP broadcast on port `41336`, file transfer via a built-in HTTP server on port `41337+`). Zero external dependencies.

## Install (both computers)

**Windows:** double-click `install/install-windows.bat`

**macOS:** double-click `install/install-mac.command`

> **"Apple could not verify … is free of malware":** that's Gatekeeper flagging the unsigned script, not an actual problem. Either:
> - Open Terminal, type `bash ` (with a space), drag `install-mac.command` into the window, press Enter — **or**
> - Right-click the file → **Open** → **Open** — **or**
> - System Settings → Privacy & Security → **Open Anyway**

Then **restart Premiere Pro** and open **Window → Extensions → willpsdk Premiere Sync**.

The installer copies the extension into Adobe's CEP extensions folder and enables `PlayerDebugMode` (required because the extension is unsigned). Updating over an older **WillPS Video Sync** install is safe — the installer removes the old panel and keeps your shared projects, synced files, and settings.

> **Firewall:** the first time the panel runs, allow Premiere Pro through your firewall for **private networks** — otherwise the machines can't see each other.

## Using it

| I want to… | Do this |
|---|---|
| Share the project I'm editing | **+ Add Project** → *This computer* → click the open project |
| Share some other project | **+ Add Project** → *This computer* → **Browse for .prproj…** |
| Get a project from another PC | **+ Add Project** → *From network* → click the project |
| Open a synced project | Click **Open** on its card |
| Force an immediate re-sync | Click **Sync now** |
| Change where downloads go | ⚙ Settings → *Sync folder* |
| Rename how this PC appears to others | ⚙ Settings → *Device name* |

## Notes & limits

- **Fully hands-free:** if a synced project is open in Premiere with unsaved changes, the panel saves it automatically every minute so edits flow out; and when a newer version arrives from the other machine, Premiere reloads it automatically. The auto-reload only happens when you have **no unsaved changes** — it will never discard work in progress (you get a warning toast instead, and can save to keep your version or reopen to take theirs).
- Premiere project files can't be merged: working on the **same timeline on both machines at the same moment** means the last save wins (older version kept in `WVS Backups`). For genuine simultaneous timeline editing you'd need Adobe Team Projects; the intended workflow here is edit on one machine, save, continue on the other.
- Both machines must be on the **same local network** and have the panel **open** (the network engine lives in the panel).
- Media that is offline/missing on the source machine is skipped and noted.
- Files deleted from the source project are not deleted locally.
- Config lives in `~/.willps-video-sync/config.json` (kept under the original name so updates don't lose your setup); downloads default to `Documents/willpsdk Premiere Sync/`.

## Project layout

```
extension/            the CEP panel that gets installed
  CSXS/manifest.xml   extension manifest (Premiere 13+, CEP 9+, Node enabled)
  index.html          panel UI
  css/style.css       dark Premiere-style theme
  js/main.js          UI logic
  js/sync-engine.js   discovery + HTTP server + sync + prproj relinking
  js/CSInterface.js   Adobe CEP bridge (minimal)
  jsx/hostscript.jsx  ExtendScript: read active project, open projects
install/              one-click installers for Windows & macOS
```
