# Vingester &mdash; Ingest Web Contents as Video Streams

<img src="https://raw.githubusercontent.com/rse/vingester/master/vingester-icon.png" width="150" align="right" alt=""/>

**Vingester** (Video Ingester) is an [Electron](https://www.electronjs.org/)-based desktop application for Windows, macOS and Linux that runs one or more headless Chromium browser instances and streams their rendered output as [NDI&reg;](https://ndi.video/) video streams (or [FFmpeg](https://ffmpeg.org/)-encoded files/streams). It also accepts still images, videos and slideshows as input, converting them directly to NDI output.

Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only).

---

## Table of Contents

1. [Features](#features)
2. [Installation / Build Guide](#installation--build-guide)
3. [Command-Line Flags](#command-line-flags)
4. [Instance Configuration Reference](#instance-configuration-reference)
5. [Input Types](#input-types)
6. [Auto-Refresh and Auto-Start](#auto-refresh-and-auto-start)
7. [REST API](#rest-api)
8. [Web UI Dashboard](#web-ui-dashboard)
9. [Settings Export and Import (YAML)](#settings-export-and-import-yaml)
10. [Windows Service (Auto-Start on Boot)](#windows-service-auto-start-on-boot)
11. [Linux/macOS Service](#linuxmacos-service)
12. [Stability Notes](#stability-notes)
13. [Sample Configurations](#sample-configurations)
14. [Credits](#credits)

---

## Features

- **NDI Output**: Streams web content as NDI video over LAN for use in OBS Studio, vMix, etc.
- **FFmpeg Output**: Record to file (MKV, MP4) or stream (MPEG-TS/UDP, RTP, RTMP/FLV).
- **Image/Video Input**: Use a still image or looping video file as an NDI source.
- **Slideshow Input**: Cycle through multiple images/videos with fade transitions.
- **Auto-Refresh**: Each instance can reload its content on a configurable timer.
- **Auto-Start per Instance**: Mark individual instances to start automatically on launch.
- **Web UI Dashboard**: Browser-based management interface with media upload and live status.
- **REST API**: HTTP API for remote control via Stream Deck, Companion, etc.
- **CSS/JS Patching**: Inject custom CSS and JavaScript into any web page.
- **Adaptive Frame Rate**: Reduce FPS automatically based on NDI tally state.
- **Settings Export/Import**: Full YAML-based configuration portability.
- **Windows Service**: Install as a Windows service with crash-restart via NSSM.

---

## Installation / Build Guide

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 16 or 18 LTS | JavaScript runtime |
| [npm](https://www.npmjs.com/) | 8+ | Package manager |
| [Git](https://git-scm.com/) | any | Source control |
| NDI SDK (Windows/macOS) | 5+ | NDI runtime for video output |

> **Linux note:** NDI SDK is not officially supported on Linux. The app will still build and run but NDI output will be unavailable.

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/rse/vingester.git
cd vingester

# 2. Install dependencies
npm install

# 3a. Run in development mode (hot-reload)
npm start

# 3b. Run in debug mode (extra logging + DevTools auto-opened)
DEBUG=2 npm start

# 3c. Run production build directly (no hot-reload)
npm run start-prod

# 4. Package a distributable build
npm run package
#    Output: dist/win-unpacked/Vingester.exe   (Windows)
#            dist/mac/Vingester.app            (macOS)
#            dist/Vingester-<ver>.AppImage      (Linux)

# 5. Clean build artifacts
npm run clean       # removes dist/
npm run distclean   # removes dist/ and node_modules/
```

### Platform Notes

**Windows**: NDI SDK must be installed first. Download from [ndi.video](https://ndi.video/tools/ndi-sdk/).

**macOS**: NDI SDK required. App may need to be codesigned for distribution.

**Linux**: NDI output unavailable. FFmpeg output still works.

---

## Command-Line Flags

These flags are passed directly to the Vingester executable (or to `electron .` during development).

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--profile=<name>` | string | (none) | Use a named user-data profile. Can be a simple name (e.g. `production`) which appends to the default userData path, or an absolute directory path. Allows multiple independent Vingester instances on the same machine. |
| `--config=<file>` | string | (none) | Path to a YAML config file. Auto-imported on startup; auto-exported on graceful shutdown. Enables fully stateless/portable operation. |
| `--tag=<text>` | string | (none) | Display a text tag in the control window header to identify this instance. |
| `--minimize` | flag | false | Start the control window minimized to the taskbar. |
| `--autostart` | flag | false | Automatically start all valid browser instances 2 seconds after launch. Equivalent to clicking "START ALL" on launch. |

### Usage Examples

```bash
# Development with profile and config file
electron . --profile=studio --config=/home/user/studio.yaml

# Production binary, minimized, all auto-started
Vingester.exe --minimize --autostart --tag="Studio A"

# Portable operation (config file as single source of truth)
Vingester.exe --config=C:\vingester\config.yaml --autostart

# Multiple instances on the same machine using separate profiles
Vingester.exe --profile=cam1 --config=cam1.yaml --autostart
Vingester.exe --profile=cam2 --config=cam2.yaml --autostart
```

---

## Instance Configuration Reference

Each browser instance has the following configuration fields. Long names are used in YAML export/import files.

### Browser Settings

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `BrowserTitle` | `t` | string | `""` | **Required.** Name of the browser instance and NDI stream. |
| `BrowserInfo` | `i` | string | `""` | User-defined notes. Not used internally. |
| `BrowserWidth` | `w` | number | `1280` | Canvas width in pixels (854=480p, 1280=720p, 1920=1080p). |
| `BrowserHeight` | `h` | number | `720` | Canvas height in pixels (480, 720, 1080). |
| `BrowserColor` | `c` | string | `"transparent"` | Background color: `transparent` or `#RRGGBB`. |
| `BrowserZoom` | `z` | number | `1.0` | Browser zoom level. |
| `BrowserTrust` | `H` | boolean | `false` | Trust unknown SSL/TLS certificates. |
| `BrowserNodeAPI` | `I` | boolean | `false` | Enable Node.js API in browser context (security risk). |
| `BrowserOBSDOM` | `B` | boolean | `false` | Emulate OBS Studio Browser Source DOM events. |
| `BrowserPersist` | `S` | boolean | `false` | Persist browser session (cookies, storage) across restarts. |

### Auto-Refresh and Auto-Start

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `AutoRefreshEnabled` | `ar` | boolean | `false` | Enable automatic periodic page reload. |
| `AutoRefreshInterval` | `ai` | number | `300` | Seconds between reloads (minimum: 5). |
| `InstanceAutoStart` | `as` | boolean | `false` | Start this instance automatically when Vingester launches. |

### Input Settings

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `InputType` | `it` | string | `"url"` | Input type: `url`, `image`, `video`, or `slideshow`. |
| `InputURL` | `u` | string | `""` | URL to load when `InputType` is `url`. |
| `InputFiles` | `if` | string | `""` | File path(s) for image/video/slideshow. Multiple paths separated by newlines for slideshows. |
| `SlideshowInterval` | `si` | number | `5` | Seconds each slide is shown before advancing. |
| `SlideshowFade` | `sf` | number | `1` | Duration of crossfade transition between slides (seconds). |

### Patch Settings

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `PatchDelay` | `k` | number | `0` | Milliseconds to wait after page load before injecting patches. |
| `PatchFrame` | `j` | string | `""` | URL regex to select a sub-frame for patching. Empty = main frame. |
| `PatchStyleType` | `g` | string | `"inline"` | CSS source: `inline` (code in field) or `file` (path in field). |
| `PatchStyleCode` | `q` | string | `""` | CSS code or file path to inject. |
| `PatchScriptType` | `G` | string | `"inline"` | JS source: `inline` or `file`. |
| `PatchScriptCode` | `Q` | string | `""` | JavaScript code or file path to inject. |

### NDI/FFmpeg Output Settings

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `Output2Enabled` | `N` | boolean | `false` | **Required.** Enable NDI/FFmpeg output. |
| `Output2VideoFrameRate` | `f` | number | `30` | Capture FPS (common: 24, 30, 48, 60). Use 0 for audio-only. |
| `Output2VideoAdaptive` | `a` | boolean | `false` | Reduce FPS based on NDI tally (saves CPU when idle). |
| `Output2VideoDelay` | `O` | number | `0` | Video delay in milliseconds. |
| `Output2AudioSampleRate` | `r` | number | `48000` | Sample rate: 8000, 12000, 16000, 24000, or 48000 Hz. |
| `Output2AudioChannels` | `C` | number | `2` | Audio channels (0=video-only, 1=mono, 2=stereo). |
| `Output2AudioDelay` | `o` | number | `0` | Audio delay in milliseconds. |
| `Output2SinkNDIEnabled` | `n` | boolean | `true` | Send output as NDI stream. |
| `Output2SinkNDIAlpha` | `v` | boolean | `true` | Include alpha channel in NDI (for keying). |
| `Output2SinkNDITallyReload` | `l` | boolean | `false` | Reload page when NDI tally enters preview or program. |
| `Output2SinkFFmpegEnabled` | `m` | boolean | `false` | Pass output to FFmpeg. |
| `Output2SinkFFmpegMode` | `R` | string | `"vbr"` | Quality mode: `vbr` (recording), `abr`, or `cbr` (streaming). |
| `Output2SinkFFmpegFormat` | `F` | string | `"matroska"` | Format: `matroska`, `mp4`, `mpegts`, `rtp`, `flv`. |
| `Output2SinkFFmpegOptions` | `M` | string | `""` | FFmpeg CLI arguments (output filename or stream URL). |

### UI Settings

| YAML Name | Short | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `PreviewEnabled` | `P` | boolean | `false` | Show thumbnail preview (160x90) in the control UI. |
| `ConsoleEnabled` | `T` | boolean | `false` | Show browser console messages in the control UI. |
| `DevToolsEnabled` | `E` | boolean | `false` | Open Chrome DevTools for this instance. |
| `Collapsed` | `_` | boolean | `false` | Collapse this entry in the UI. |

---

## Input Types

### URL (default)

Standard web browser mode. Enter any `http://`, `https://`, or `file://` URL.

```yaml
InputType: "url"
InputURL:  "https://example.com/my-overlay"
```

### Image

Display a single still image file. Supports PNG, JPG, GIF, WEBP, BMP, SVG. The image fills the canvas with letterboxing. Transparent PNGs work with `BrowserColor: "transparent"`.

```yaml
InputType:  "image"
InputFiles: "C:\\Media\\logo.png"
```

### Video

Loop a video file. Supports MP4, WebM, OGG, MOV.

```yaml
InputType:  "video"
InputFiles: "C:\\Media\\background.mp4"
```

### Slideshow

Cycle through multiple images and/or videos with CSS fade transitions. Paths are separated by newlines.

```yaml
InputType:         "slideshow"
InputFiles:        "C:\\Media\\slide1.png\nC:\\Media\\slide2.jpg\nC:\\Media\\clip.mp4"
SlideshowInterval: 8
SlideshowFade:     1.5
```

Under the hood, Vingester generates a self-contained HTML/JS page with CSS `opacity` transitions and loads it via a `file://` URL. The existing browser pipeline processes it identically to any other web content — no special code paths needed.

---

## Auto-Refresh and Auto-Start

### Auto-Refresh

When `AutoRefreshEnabled` is `true`, Vingester reloads the page every `AutoRefreshInterval` seconds (minimum 5s). Useful for recovering from disconnections or keeping live data current.

### Auto-Start per Instance

When `InstanceAutoStart` is `true`, that instance starts automatically 2 seconds after the control UI loads. Independent of the `--autostart` CLI flag (which starts all instances). You can combine both.

---

## REST API

The REST API runs on port 7211 by default. Enable it in the control UI (globe icon).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | JSON array of all instance titles |
| `GET/POST` | `/all/start` | Start all instances |
| `GET/POST` | `/all/reload` | Reload all instances |
| `GET/POST` | `/all/stop` | Stop all instances |
| `GET/POST` | `/{title}/start` | Start instance by title |
| `GET/POST` | `/{title}/reload` | Reload instance by title |
| `GET/POST` | `/{title}/stop` | Stop instance by title |
| `GET/POST` | `/{title}/clear` | Clear persistent session for instance |

```bash
curl http://127.0.0.1:7211/
curl http://127.0.0.1:7211/all/start
curl "http://127.0.0.1:7211/My-Camera/stop"
```

---

## Web UI Dashboard

The Web UI runs on port 7212 by default. Enable it in the control UI (monitor icon). Open `http://127.0.0.1:7212/` in any browser.

**Instances panel**: Live status, start/stop/reload per instance, auto-refreshes every 5 seconds.

**Media Manager panel**: Upload images and videos (drag-and-drop). View and delete files. Uploaded files are stored in `{userData}/Media/`.

Allowed upload types: PNG, JPG, GIF, WEBP, BMP, SVG, MP4, WEBM, OGG, MOV (max 500 MB).

---

## Settings Export and Import (YAML)

- Click **EXPORT** to save all instances to a `.yaml` file.
- Click **IMPORT** to load instances from a `.yaml` file (replaces current config).
- Use `--config=<file>` for automatic export/import on startup/shutdown.

**Backward compatibility**: Old YAML files with `Output1*` fields (frameless window, removed in this fork) will have those fields silently ignored. All other settings are preserved. Missing new fields default to safe values.

---

## Windows Service (Auto-Start on Boot)

Use the included installer script with [NSSM](https://nssm.cc/).

### Setup

1. Build Vingester: `npm run package`
2. Download NSSM from [https://nssm.cc/download](https://nssm.cc/download), extract to `C:\nssm\`
3. Open Command Prompt as Administrator:

```cmd
cd C:\path\to\vingester
node installer\install-service.js install --name Vingester --args "--autostart --config C:\vingester\config.yaml"
```

### Commands

```cmd
node installer\install-service.js uninstall --name Vingester
node installer\install-service.js start     --name Vingester
node installer\install-service.js stop      --name Vingester
node installer\install-service.js status    --name Vingester
```

NSSM configures automatic crash recovery (restart after 5 seconds) and logs to `./logs/`.

---

## Linux/macOS Service

### Linux (systemd)

Create `/etc/systemd/system/vingester.service`:

```ini
[Unit]
Description=Vingester NDI Browser Ingest
After=network.target

[Service]
Type=simple
User=youruser
Environment=DISPLAY=:0
ExecStart=/opt/vingester/Vingester.AppImage --no-sandbox --autostart --config=/etc/vingester/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vingester
```

For headless servers, use a virtual display: `Xvfb :99 -screen 0 1280x720x24 &` and `DISPLAY=:99`.

### macOS (launchd)

Create `~/Library/LaunchAgents/com.vingester.plist` with `RunAtLoad` and `KeepAlive` set to true, pointing to the `Vingester.app` binary with `--autostart --config /path/to/config.yaml`.

---

## Stability Notes

Fixes applied in this fork:

1. **IPC listener memory leak**: `browser-worker-stopped` now uses `ipcMain.once()` preventing listener accumulation.
2. **Auto-refresh timer cleanup**: Timer is properly cleared on stop and recreated on reconfigure.
3. **Generated HTML cleanup**: Temporary HTML files for media inputs are deleted when the instance stops.
4. **Backward-compatible settings**: All new fields have safe defaults; unknown fields are pruned; old configs always import cleanly.

---

## Sample Configurations

| File | Description |
|------|-------------|
| `cfg-sample-test.yaml` | Vingester test page |
| `cfg-sample-expert.yaml` | Expert series (4 YouTube videos) |
| `cfg-sample-fps.yaml` | FPS demo |
| `cfg-sample-jitsi.yaml` | Jitsi Meet video conferencing |
| `cfg-sample-vdon.yaml` | VDO.Ninja remote streaming |

Samples are automatically copied to `{userData}/Configurations/` on startup.

---

## Credits

- **Original Author**: Dr. Ralf S. Engelschall &lt;rse@engelschall.com&gt;
- **NDI**: NewTek, Inc. / Vizrt Group
- **FFmpeg**: Fabrice Bellard
- **Electron**: GitHub, Inc.
- **Chromium / V8**: Google LLC
- **Node.js**: OpenJS Foundation
- **Vue.js**: Evan You

License: [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)
