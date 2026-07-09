# willpsdk Premiere Sync

Sync Premiere Pro projects between your computers over your local network, straight from a panel inside Premiere. Project file *and* all the media it uses — no cloud, no accounts, no Dropbox folder to babysit.

I built this because I kept editing on my desktop, then wanting to carry on from my laptop, and every "solution" was either a paid cloud service or manually copying a project + hunting down relinked media for twenty minutes. This just does it. Open the panel on both machines, add the project on one, click it on the other, done.

Works on **Windows and macOS**, Premiere Pro 2019 (v13) and newer.

---

## What it actually does

- Share a project from one machine and it shows up on your other machines automatically — they're discovered over the LAN, no IP addresses to type in.
- When you sync a project, it pulls the `.prproj` **and every media file it references**, then rewrites the media paths so it opens with everything online instead of Premiere throwing "Media Offline" at you.
- After that it keeps both machines in sync **both ways**, on its own. Edit on either one, save, and the changes (cuts, new footage, whatever) show up on the other within a minute or two. No pressing sync.

That's the whole pitch. It's a panel, it lives in Premiere, it stays out of your way.

---

## Installing

Do this on **both** computers:

**Windows** — double-click `install/install-windows.bat`

**macOS** — double-click `install/install-mac.command`

> If macOS says it "could not verify" the installer — that's just Gatekeeper being cautious about an unsigned script, nothing's wrong with it. Easiest fix: open Terminal, type `bash ` (with a space), drag the `.command` file into the window, hit Enter. Or right-click the file → Open → Open.

Then restart Premiere and open **Window → Extensions → willpsdk Premiere Sync**.

First time it runs, your firewall will probably ask about network access — **allow it on private networks**, otherwise the two machines can't see each other.

The installer drops the panel into Adobe's CEP extensions folder and flips on `PlayerDebugMode` (needed because the extension isn't signed with a paid Adobe cert).

---

## Using it

Pretty much everything is behind the **+ Add Project** button.

| You want to... | Do this |
|---|---|
| Share the project you're editing | **+ Add Project → This computer →** click the open project |
| Share a different project | **+ Add Project → This computer → Browse for .prproj** |
| Pull a project from another machine | **+ Add Project → From network →** click it |
| Open a synced project | hit **Open** on its card |
| Force a sync right now | hit **Sync now** |
| Change where downloads go / rename this machine | ⚙ **Settings** |

---

## How it works under the hood

Everything runs inside the panel itself using Node (which CEP panels get access to) — there's no separate app or background service to install.

- **Discovery** is a small UDP broadcast on port `41336`, so machines find each other on their own.
- **Transfer** is a tiny built-in HTTP server on `41337+` that serves the project's files and accepts pushed changes.
- **Relinking** happens by reading the media paths out of the `.prproj` (it's gzipped XML) and rewriting them for wherever the files landed on each machine.
- **Change detection** for the project file compares actual *contents*, not timestamps — Premiere re-saves the file constantly even when nothing changed, and going by timestamps meant harmless re-saves would stomp real edits on the other machine. Media files still use the fast size/mtime check.

Zero npm dependencies — it's all Node built-ins, which is why installing is just copying a folder.

---

## Things worth knowing

- **Save your project** for edits to sync — the panel syncs what's on disk. It'll auto-save an open synced project every minute for you, but a manual Ctrl/Cmd+S never hurts.
- It's **hands-free by design**: when a newer version arrives from the other machine, Premiere reloads it automatically — but *only* if you don't have unsaved changes, so it will never throw away work you're in the middle of. If you do, you get a heads-up instead and it waits.
- Project files can't be merged. If you edit the **same timeline on both machines at the same time**, the last save wins and the other version gets tucked into a `WVS Backups` folder next to the project (last 10 kept, nothing is deleted). Real simultaneous editing of one timeline is a Team Projects thing — the workflow here is edit on one machine, save, move to the other.
- Both machines need to be on the **same network** with the **panel open** — the sync engine lives in the panel, so if it's closed, nothing's listening.
- Media that's offline on the source machine gets skipped (and noted), and deleting a file from the source project doesn't delete your local copy.

---

## Not-yet / maybe-someday

- No sync over the internet — it's local network only, on purpose.
- No file-level history beyond the rolling project backups.
- Only tested against Premiere; the CEP approach could probably work for After Effects with tweaks, haven't tried.

---

Made for my own two-machine setup. If it saves you a media-relink headache too, great.
