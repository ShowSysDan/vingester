/*
**  WebRetriever ~ Ingest Web Contents as Video Streams
**  Based on Vingester (c) 2021-2025 Dr. Ralf S. Engelschall
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  require internal modules  */
const path        = require("path")
const fs          = require("fs")
const process     = require("process")

/*  require external modules  */
const electron    = require("electron")
const contextMenu = require("electron-context-menu")
const grandiose   = require("grandiose")
const Store       = require("electron-store")
const debounce    = require("throttle-debounce").debounce
const throttle    = require("throttle-debounce").throttle
const jsYAML      = require("js-yaml")
const UUID        = require("pure-uuid")
const express     = require("express")
const http        = require("http")
const multer      = require("multer")
const moment      = require("moment")
const mkdirp      = require("mkdirp")
const FFmpeg      = require("@rse/ffmpeg")

/*  require own modules  */
const Browser     = require("./vingester-browser.js")
const Update      = require("./vingester-update.js")
const util        = require("./vingester-util.js")
const log         = require("./vingester-log.js").scope("main")
const pkg         = require("./package.json")
const syslog      = require("./vingester-syslog.js")

/*  get rid of unnecessary security warnings when debugging  */
if (typeof process.env.DEBUG !== "undefined") {
    delete process.env.ELECTRON_ENABLE_SECURITY_WARNINGS
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = true
}

/*  redirect exception error boxes to the console  */
electron.dialog.showErrorBox = (title, content) => {
    log.info(`UI: exception: ${title}: ${content}`)
}

/*  determine versions and supported features  */
const version = {
    vingester: pkg.version,
    electron:  process.versions.electron,
    chromium:  process.versions.chrome,
    v8:        process.versions.v8.replace(/-electron.*$/, ""),
    node:      process.versions.node,
    ndi:       grandiose.version().replace(/^.+\s+/, ""),
    ffmpeg:    FFmpeg.info.version,
    vuejs:     pkg.dependencies.vue
}
const support = {
    ndi:       grandiose.isSupportedCPU(),
    srt:       FFmpeg.info.protocols?.srt?.input === true
}
electron.ipcMain.handle("version", (ev) => { return version })
electron.ipcMain.handle("support", (ev) => { return support })
log.info(`starting WebRetriever: ${version.vingester}`)
syslog.info("app", `starting WebRetriever v${version.vingester}`)
log.info(`using Electron: ${version.electron}`)
log.info(`using Chromium: ${version.chromium}`)
log.info(`using V8: ${version.v8}`)
log.info(`using Node.js: ${version.node}`)
log.info(`using NDI: ${version.ndi} (supported by CPU: ${support.ndi ? "yes" : "no"})`)
log.info(`using FFmpeg: ${version.ffmpeg}`)
log.info(`using Vue: ${version.vuejs}`)

/*  support particular profiles  */
if (electron.app.commandLine.hasSwitch("profile")) {
    const profile = electron.app.commandLine.getSwitchValue("profile")
    let userData = electron.app.getPath("userData")
    if (profile.match(/^[a-zA-Z][a-zA-Z0-9-]+$/))
        userData += `-${profile}`
    else
        userData = path.resolve(process.cwd(), profile)
    electron.app.setPath("userData", userData)
    log.info(`using profile: "${userData}" [custom]`)
}
else {
    const userData = electron.app.getPath("userData")
    log.info(`using profile: "${userData}" [default]`)
}

/*  support configuration auto-import/export  */
let configFile = null
if (electron.app.commandLine.hasSwitch("config")) {
    configFile = electron.app.commandLine.getSwitchValue("config")
    log.info(`using auto-import/export configuration: "${configFile}"`)
}

/*  support user interface tagging  */
let tag = null
if (electron.app.commandLine.hasSwitch("tag")) {
    tag = electron.app.commandLine.getSwitchValue("tag")
    log.info(`using user interface tag: "${tag}"`)
}

/*  support initial user interface minimization  */
let initiallyMinimized = false
if (electron.app.commandLine.hasSwitch("minimize"))
    initiallyMinimized = true

/*  support browser instances global auto-start (all instances)  */
let autostart = false
if (electron.app.commandLine.hasSwitch("autostart"))
    autostart = true

/*  headless mode: keep control window permanently hidden; manage via WebUI  */
let headless = false
if (electron.app.commandLine.hasSwitch("headless"))
    headless = true

/*  force Chromium of browsers (not control UI) to ignore device scaling  */
electron.app.commandLine.appendSwitch("high-dpi-support", "true")
electron.app.commandLine.appendSwitch("force-device-scale-factor", "1")

/*  optionally initialize NDI library  */
if (grandiose.isSupportedCPU())
    grandiose.initialize()

/*  initialize store  */
const store = new Store()

/*  initialize syslog from stored settings  */
syslog.configure({
    enabled: store.get("syslog.enabled", false),
    ip:      store.get("syslog.ip",      ""),
    port:    store.get("syslog.port",    514)
})

/*  optionally and early disable GPU hardware acceleration  */
if (!store.get("gpu")) {
    log.info("disabling GPU hardware acceleration (explicitly configured)")
    electron.app.disableHardwareAcceleration()
}

/*  once electron is ready...  */
electron.app.on("ready", async () => {
    log.info("Electron is now ready")

    /*  establish update process  */
    const update = new Update()

    /*  ensure that the configuration export/import area exists
        and that the sample configurations are provided  */
    const pathExists = (p) =>
        fs.promises.access(p, fs.constants.F_OK).then(() => true).catch(() => false)
    const userData = electron.app.getPath("userData")
    const appPath  = electron.app.getAppPath()
    const cfgDir = path.join(userData, "Configurations")
    if (!(await pathExists(cfgDir)))
        await mkdirp(cfgDir, { mode: 0o755 })
    let autosaveFile = store.get("autosave.file", path.join(cfgDir, "autosave.yaml"))
    let autosaveTimer = null
    const sampleConfigs = [
        { iname: "cfg-sample-test.yaml",   ename: "Sample-Test.yaml" },
        { iname: "cfg-sample-expert.yaml", ename: "Sample-Expert.yaml" },
        { iname: "cfg-sample-fps.yaml",    ename: "Sample-FPS.yaml" },
        { iname: "cfg-sample-vdon.yaml",   ename: "Sample-VDON.yaml" },
        { iname: "cfg-sample-jitsi.yaml",  ename: "Sample-Jitsi.yaml" }
    ]
    for (const sampleConfig of sampleConfigs) {
        const iname = path.join(appPath, sampleConfig.iname)
        const ename = path.join(cfgDir,  sampleConfig.ename)
        await fs.promises.copyFile(iname, ename)
    }
    await fs.promises.unlink(path.join(cfgDir, "Sample-OBSN.yaml")).catch(() => true)

    /*  ensure media library directory exists  */
    const mediaDir = path.join(userData, "Media")
    if (!(await pathExists(mediaDir)))
        await mkdirp(mediaDir, { mode: 0o755 })

    /*  determine main window position and size  */
    log.info("loading persistant settings")
    const x = store.get("control.x", null)
    const y = store.get("control.y", null)
    const w = store.get("control.w", 840)
    const h = store.get("control.h", 575)
    const pos = (x !== null && y !== null ? { x, y } : {})

    /*  determine target display of browser window  */
    let display = electron.screen.getPrimaryDisplay()
    if (x !== null && y !== null)
        display = electron.screen.getDisplayNearestPoint({ x, y })

    /*  create main window  */
    log.info("creating control user interface")
    const control = new electron.BrowserWindow({
        ...pos,
        show:            false,
        width:           w * display.scaleFactor,
        height:          h * display.scaleFactor,
        minWidth:        840,
        minHeight:       575,
        frame:           false,
        title:           "WebRetriever",
        backgroundColor: "#0d1117",
        useContentSize:  false,
        webPreferences: {
            zoomFactor:                 display.scaleFactor,
            devTools:                   (process.env.DEBUG === "2"),
            nodeIntegration:            true,
            nodeIntegrationInWorker:    true,
            contextIsolation:           false,
            enableRemoteModule:         false,
            disableDialogs:             true,
            autoplayPolicy:             "no-user-gesture-required",
            spellcheck:                 false
        }
    })
    control.webContents.setZoomFactor(display.scaleFactor)
    control.removeMenu()
    contextMenu({
        window: control,
        showLookUpSelection:  false,
        showSearchWithGoogle: false,
        showCopyImage:        false,
        showCopyImageAddress: true,
        showSaveImage:        false,
        showSaveImageAs:      false,
        showSaveLinkAs:       false,
        showInspectElement:   (process.env.DEBUG === "2"),
        showServices:         false,
        labels: {
            inspect:          "Inspect in DevTools"
        }
    })
    if (process.env.DEBUG === "2") {
        setTimeout(() => {
            control.webContents.openDevTools()
        }, 1000)
    }

    /*  persist main window position and size  */
    const updateBounds = () => {
        const bounds = control.getBounds()
        store.set("control.x", bounds.x)
        store.set("control.y", bounds.y)
        store.set("control.w", bounds.width)
        store.set("control.h", bounds.height)
    }
    control.on("resize", debounce(1000, () => {
        updateBounds()
    }))
    control.on("move", debounce(1000, () => {
        updateBounds()
    }))

    /*  window control  */
    let minimized  = false
    let maximized  = false
    let fullscreen = false
    control.on("minimize",          () => { minimized  = true  })
    control.on("restore",           () => { minimized  = false })
    control.on("maximize",          () => { maximized  = true  })
    control.on("unmaximize",        () => { maximized  = false })
    control.on("enter-full-screen", () => { fullscreen = true  })
    control.on("leave-full-screen", () => { fullscreen = false })
    electron.ipcMain.handle("window-control", async (ev, action) => {
        if (action === "minimize") {
            if (minimized) {
                control.restore()
                control.focus()
            }
            else
                control.minimize()
        }
        else if (action === "maximize") {
            if (fullscreen)
                control.setFullScreen(false)
            if (maximized)
                control.unmaximize()
            else
                control.maximize()
        }
        else if (action === "fullscreen") {
            if (maximized)
                control.unmaximize()
            if (fullscreen)
                control.setFullScreen(false)
            else
                control.setFullScreen(true)
        }
        else if (action === "standard") {
            if (fullscreen)
                control.setFullScreen(false)
            else if (maximized)
                control.unmaximize()
            control.setSize(820, 420)
        }
        else if (action === "close") {
            if (fullscreen)
                control.setFullScreen(false)
            else if (maximized)
                control.unmaximize()
            setTimeout(() => {
                control.close()
            }, 100)
        }
    })

    /*  configure application menu  */
    const openURL = (url) =>
        async () => { await electron.shell.openExternal(url) }
    const menuTemplate = [
        {
            label: electron.app.name,
            submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideothers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" }
            ]
        }, {
            label: "Edit",
            submenu: [
                { role: "cut" },
                { role: "copy" },
                { role: "paste" }
            ]
        }, {
            role: "window",
            submenu: [
                { role: "minimize" },
                { role: "zoom" },
                { role: "togglefullscreen" },
                { role: "front" }
            ]
        }, {
            role: "help",
            submenu: [
                { label: "More about WebRetriever", click: openURL("https://vingester.app") }
            ]
        }
    ]
    const menu = electron.Menu.buildFromTemplate(menuTemplate)
    electron.Menu.setApplicationMenu(menu)

    /*  provide IPC hooks for store access  */
    log.info("provide IPC hooks for control user interface")
    /*
     *  Field definitions - each field has:
     *    iname: internal short name (single char or two chars) used in storage
     *    itype: internal type used in storage
     *    def:   default value
     *    etype: exported type (for YAML)
     *    ename: external long name used in YAML export/import
     *
     *  NOTE: Output1 (frameless window) fields (D, x, y, d, p, A) have been removed.
     *  Old YAML configs with those fields will have them silently ignored on import
     *  for full backward compatibility.
     */
    const fields = [
        { iname: "t",  itype: "string",  def: "",            etype: "string",  ename: "BrowserTitle" },
        { iname: "i",  itype: "string",  def: "",            etype: "string",  ename: "BrowserInfo" },
        { iname: "w",  itype: "string",  def: "1280",        etype: "number",  ename: "BrowserWidth" },
        { iname: "h",  itype: "string",  def: "720",         etype: "number",  ename: "BrowserHeight" },
        { iname: "c",  itype: "string",  def: "transparent", etype: "string",  ename: "BrowserColor" },
        { iname: "z",  itype: "string",  def: "1.0",         etype: "number",  ename: "BrowserZoom" },
        { iname: "H",  itype: "boolean", def: false,         etype: "boolean", ename: "BrowserTrust" },
        { iname: "I",  itype: "boolean", def: false,         etype: "boolean", ename: "BrowserNodeAPI" },
        { iname: "B",  itype: "boolean", def: false,         etype: "boolean", ename: "BrowserOBSDOM" },
        { iname: "S",  itype: "boolean", def: false,         etype: "boolean", ename: "BrowserPersist" },
        { iname: "ar", itype: "boolean", def: false,         etype: "boolean", ename: "AutoRefreshEnabled" },
        { iname: "ai", itype: "string",  def: "300",         etype: "number",  ename: "AutoRefreshInterval" },
        { iname: "as", itype: "boolean", def: false,         etype: "boolean", ename: "InstanceAutoStart" },
        { iname: "it", itype: "string",  def: "url",         etype: "string",  ename: "InputType" },
        { iname: "u",  itype: "string",  def: "",            etype: "string",  ename: "InputURL" },
        { iname: "if", itype: "string",  def: "",            etype: "string",  ename: "InputFiles" },
        { iname: "si", itype: "string",  def: "5",           etype: "number",  ename: "SlideshowInterval" },
        { iname: "sf", itype: "string",  def: "1",           etype: "number",  ename: "SlideshowFade" },
        { iname: "k",  itype: "string",  def: "0",           etype: "number",  ename: "PatchDelay" },
        { iname: "j",  itype: "string",  def: "",            etype: "string",  ename: "PatchFrame" },
        { iname: "g",  itype: "string",  def: "inline",      etype: "string",  ename: "PatchStyleType" },
        { iname: "q",  itype: "string",  def: "",            etype: "string",  ename: "PatchStyleCode" },
        { iname: "G",  itype: "string",  def: "inline",      etype: "string",  ename: "PatchScriptType" },
        { iname: "Q",  itype: "string",  def: "",            etype: "string",  ename: "PatchScriptCode" },
        { iname: "N",  itype: "boolean", def: false,         etype: "boolean", ename: "Output2Enabled" },
        { iname: "f",  itype: "string",  def: "30",          etype: "number",  ename: "Output2VideoFrameRate" },
        { iname: "a",  itype: "boolean", def: false,         etype: "boolean", ename: "Output2VideoAdaptive" },
        { iname: "O",  itype: "string",  def: "0",           etype: "number",  ename: "Output2VideoDelay" },
        { iname: "r",  itype: "number",  def: 48000,         etype: "number",  ename: "Output2AudioSampleRate" },
        { iname: "C",  itype: "string",  def: "2",           etype: "number",  ename: "Output2AudioChannels" },
        { iname: "o",  itype: "string",  def: "0",           etype: "number",  ename: "Output2AudioDelay" },
        { iname: "n",  itype: "boolean", def: true,          etype: "boolean", ename: "Output2SinkNDIEnabled" },
        { iname: "v",  itype: "boolean", def: true,          etype: "boolean", ename: "Output2SinkNDIAlpha" },
        { iname: "l",  itype: "boolean", def: false,         etype: "boolean", ename: "Output2SinkNDITallyReload" },
        { iname: "m",  itype: "boolean", def: false,         etype: "boolean", ename: "Output2SinkFFmpegEnabled" },
        { iname: "R",  itype: "string",  def: "vbr",         etype: "string",  ename: "Output2SinkFFmpegMode" },
        { iname: "F",  itype: "string",  def: "matroska",    etype: "string",  ename: "Output2SinkFFmpegFormat" },
        { iname: "M",  itype: "string",  def: "",            etype: "string",  ename: "Output2SinkFFmpegOptions" },
        { iname: "P",  itype: "boolean", def: false,         etype: "boolean", ename: "PreviewEnabled" },
        { iname: "T",  itype: "boolean", def: false,         etype: "boolean", ename: "ConsoleEnabled" },
        { iname: "E",  itype: "boolean", def: false,         etype: "boolean", ename: "DevToolsEnabled" },
        { iname: "_",  itype: "boolean", def: false,         etype: "boolean", ename: "Collapsed" }
    ]
    const sanitizeConfig = (browser) => {
        let changed = 0
        /*  migrate removed "video" input type to "url" for backward compatibility  */
        if (browser.it === "video") {
            browser.it = "url"
            changed++
        }
        for (const field of fields) {
            if (browser[field.iname] === undefined) {
                browser[field.iname] = field.def
                changed++
            }
        }
        for (const attr of Object.keys(browser)) {
            if (attr === "id")
                continue
            if (!fields.find((field) => field.iname === attr)) {
                delete browser[attr]
                changed++
            }
        }
        return changed
    }
    let configVersion = 0
    const saveConfigs = (browsers) => {
        browsers = JSON.stringify(browsers)
        store.set("browsers", browsers)
        configVersion++
    }
    const loadConfigs = () => {
        let changed = 0
        let browsers = store.get("browsers")
        if (browsers !== undefined)
            browsers = JSON.parse(browsers)
        else {
            browsers = []
            changed++
        }
        for (const browser of browsers)
            changed += sanitizeConfig(browser)
        if (changed > 0)
            saveConfigs(browsers)
        return browsers
    }
    electron.ipcMain.handle("browsers-load", async (ev) => {
        return loadConfigs()
    })
    electron.ipcMain.handle("configs-version", () => configVersion)
    electron.ipcMain.handle("browsers-save", async (ev, browsers) => {
        saveConfigs(browsers)
    })
    electron.ipcMain.handle("browser-sanitize", async (ev, browser) => {
        sanitizeConfig(browser)
        return browser
    })
    const exportConfig = async (file) => {
        let browsers = loadConfigs()
        browsers = browsers.map((browser) => {
            delete browser.id
            return browser
        })
        let yaml =
           "%YAML 1.2\n" +
           "##\n" +
           "##  WebRetriever Configuration\n" +
           `##  Version: WebRetriever ${version.vingester}\n` +
           `##  Date:    ${moment().format("YYYY-MM-DD HH:mm")}\n` +
           "##\n" +
           "\n" +
           "---\n" +
           "\n"
        for (const browser of browsers) {
            let line = 1
            for (const field of fields) {
                yaml += (line++ === 1 ? "-   " : "    ")
                let value = browser[field.iname]
                if (field.etype === "boolean" && typeof value !== "boolean")
                    value = Boolean(value)
                else if (field.etype === "number" && typeof value !== "number")
                    value = Number(value)
                else if (field.etype === "string" && typeof value !== "string")
                    value = String(value)
                value = jsYAML.dump(value, {
                    forceQuotes: true,
                    quotingType: "\"",
                    condenseFlow: true,
                    lineWidth: -1,
                    indent: 0
                })
                value = value.replace(/\r?\n$/, "")
                yaml += `${(field.ename + ":").padEnd(30, " ")} ${value}\n`
            }
            yaml += "\n"
        }
        await fs.promises.writeFile(file, yaml, { encoding: "utf8" })
        log.info(`exported browsers configuration (${browsers.length} browser entries)`)
    }
    const importConfig = async (file) => {
        const yaml = await fs.promises.readFile(file, { encoding: "utf8" })
        let browsers = null
        try {
            browsers = jsYAML.load(yaml)
        }
        catch (ex) {
            log.info(`importing browsers configuration failed: ${ex}`)
            return false
        }
        if (browsers === null)
            browsers = []
        for (const browser of browsers) {
            if (browser.id === undefined)
                browser.id = new UUID(1).fold(2).map((num) =>
                    num.toString(16).toUpperCase().padStart(2, "0")).join("")
            for (const field of fields) {
                let value = browser[field.ename]
                if (value === undefined)
                    continue
                if (field.itype === "boolean" && typeof value !== "boolean")
                    value = Boolean(value)
                else if (field.itype === "number" && typeof value !== "number")
                    value = Number(value)
                else if (field.itype === "string" && typeof value !== "string")
                    value = String(value)
                delete browser[field.ename]
                browser[field.iname] = value
            }
            /*  silently discard legacy Output1 fields from old config files
                (Output1Enabled/D, Output1VideoPositionX/x, Output1VideoPositionY/y,
                 Output1VideoDisplay/d, Output1VideoPinTop/p, Output1AudioDevice/A)  */
            const legacyFields = [
                "Output1Enabled", "Output1VideoPositionX", "Output1VideoPositionY",
                "Output1VideoDisplay", "Output1VideoPinTop", "Output1AudioDevice",
                "D", "x", "y", "d", "p", "A"
            ]
            for (const lf of legacyFields)
                delete browser[lf]
            sanitizeConfig(browser)
        }
        saveConfigs(browsers)
        log.info(`imported browsers configuration (${browsers.length} browser entries)`)
    }
    const autosaveConfig = async (file) => {
        let browsers = loadConfigs()
        browsers = browsers.map((browser) => {
            delete browser.id
            return browser
        })
        const webuiEnabled = store.get("webui.enabled") ?? false
        const webuiAddr    = store.get("webui.addr")    ?? "127.0.0.1"
        const webuiPort    = store.get("webui.port")    ?? "7212"
        const apiEnabled   = store.get("api.enabled")   ?? false
        const apiAddr      = store.get("api.addr")      ?? "127.0.0.1"
        const apiPort      = store.get("api.port")      ?? "7211"
        let yaml =
           "%YAML 1.2\n" +
           "##\n" +
           "##  WebRetriever Autosave Configuration\n" +
           `##  Version: WebRetriever ${version.vingester}\n` +
           `##  Date:    ${moment().format("YYYY-MM-DD HH:mm")}\n` +
           "##\n" +
           `##  WebUI:  enabled=${webuiEnabled}  addr=${webuiAddr}  port=${webuiPort}\n` +
           `##  API:    enabled=${apiEnabled}    addr=${apiAddr}    port=${apiPort}\n` +
           "##\n" +
           "\n" +
           "---\n" +
           "\n"
        for (const browser of browsers) {
            let line = 1
            for (const field of fields) {
                yaml += (line++ === 1 ? "-   " : "    ")
                let value = browser[field.iname]
                if (field.etype === "boolean" && typeof value !== "boolean")
                    value = Boolean(value)
                else if (field.etype === "number" && typeof value !== "number")
                    value = Number(value)
                else if (field.etype === "string" && typeof value !== "string")
                    value = String(value)
                value = jsYAML.dump(value, {
                    forceQuotes: true,
                    quotingType: "\"",
                    condenseFlow: true,
                    lineWidth: -1,
                    indent: 0
                })
                value = value.replace(/\r?\n$/, "")
                yaml += `${(field.ename + ":").padEnd(30, " ")} ${value}\n`
            }
            yaml += "\n"
        }
        await fs.promises.writeFile(file, yaml, { encoding: "utf8" })
        log.info(`autosaved configuration (${browsers.length} browser entries) to: ${file}`)
    }
    const performAutosave = async () => {
        if (!autosaveFile) return
        try {
            await autosaveConfig(autosaveFile)
            if (control && !control.isDestroyed())
                control.webContents.send("autosave-done", { file: autosaveFile, time: moment().format("HH:mm") })
        }
        catch (err) {
            log.error(`autosave failed: ${err.message}`)
        }
    }

    electron.ipcMain.handle("browsers-export", async (ev) => {
        electron.dialog.showSaveDialog({
            title:       "Choose Export File (YAML)",
            properties:  [ "openFile" ],
            filters:     [ { name: "YAML", extensions: [ "yaml" ] } ],
            defaultPath: cfgDir
        }).then(async (result) => {
            if (result.canceled)
                return
            if (result.filePath) {
                await exportConfig(result.filePath)
                return true
            }
            return false
        }).catch(() => {
            return false
        })
    })
    electron.ipcMain.handle("browsers-import", async (ev) => {
        return electron.dialog.showOpenDialog({
            title:       "Choose Import File (YAML)",
            properties:  [ "openFile" ],
            filters:     [ { name: "YAML", extensions: [ "yaml" ] } ],
            defaultPath: cfgDir
        }).then(async (result) => {
            if (result.canceled)
                return
            if (result.filePaths && result.filePaths.length === 1) {
                await importConfig(result.filePaths[0])
                return true
            }
            return false
        }).catch(() => {
            return false
        })
    })

    /*  autosave IPC handlers  */
    electron.ipcMain.handle("autosave-get-file", () => autosaveFile)
    electron.ipcMain.handle("autosave-set-file", async () => {
        const result = await electron.dialog.showSaveDialog(control, {
            title:       "Choose Autosave File Location (YAML)",
            filters:     [ { name: "YAML", extensions: [ "yaml" ] } ],
            defaultPath: autosaveFile || path.join(cfgDir, "autosave.yaml")
        })
        if (!result.canceled && result.filePath) {
            autosaveFile = result.filePath
            store.set("autosave.file", autosaveFile)
            control.webContents.send("autosave-file", autosaveFile)
            return autosaveFile
        }
        return null
    })
    electron.ipcMain.handle("autosave-now", async () => {
        await performAutosave()
    })

    /*  handle file selection  */
    electron.ipcMain.handle("select-file", async (ev) => {
        return electron.dialog.showOpenDialog({
            title:       "Choose File",
            properties:  [ "openFile" ]
        }).then(async (result) => {
            if (result.canceled)
                return null
            if (result.filePaths && result.filePaths.length === 1)
                return result.filePaths[0]
            return null
        }).catch(() => {
            return null
        })
    })

    /*  handle media file selection (images/videos, multi-select)  */
    electron.ipcMain.handle("select-media-files", async (ev, multiSelect) => {
        const imageExts = [ "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg" ]
        const videoExts = [ "mp4", "webm", "ogg", "mov", "mkv", "avi" ]
        return electron.dialog.showOpenDialog({
            title:       "Choose Media File(s)",
            properties:  multiSelect ? [ "openFile", "multiSelections" ] : [ "openFile" ],
            filters:     [
                { name: "Image Files",  extensions: imageExts },
                { name: "Video Files",  extensions: videoExts },
                { name: "All Media",    extensions: [ ...imageExts, ...videoExts ] }
            ]
        }).then(async (result) => {
            if (result.canceled)
                return null
            if (result.filePaths && result.filePaths.length > 0)
                return result.filePaths
            return null
        }).catch(() => {
            return null
        })
    })

    /*  handle display information determination  */
    let displays = []
    const displaysDetermine = () => {
        displays = util.AvailableDisplays.determine(electron)
        control.webContents.send("display-update", displays)
    }
    displaysDetermine()
    electron.screen.on("display-added",           () => { displaysDetermine() })
    electron.screen.on("display-removed",         () => { displaysDetermine() })
    electron.screen.on("display-metrics-changed", () => { displaysDetermine() })
    electron.ipcMain.handle("display-list", async (ev) => {
        return displays
    })

    /*  handle update check request from UI  */
    electron.ipcMain.handle("update-check", async () => {
        /*  check whether we are updateable at all  */
        const updateable = await update.updateable()
        control.webContents.send("update-updateable", updateable)

        /*  check for update versions  */
        const versions = await update.check(throttle(1000 / 60, (task, completed) => {
            control.webContents.send("update-progress", { task, completed })
        }))
        setTimeout(() => {
            control.webContents.send("update-progress", null)
        }, 2 * (1000 / 60))
        control.webContents.send("update-versions", versions)
    })

    /*  handle update request from UI  */
    electron.ipcMain.handle("update-to-version", (event, version) => {
        update.update(version, throttle(1000 / 60, (task, completed) => {
            control.webContents.send("update-progress", { task, completed })
        })).catch((err) => {
            control.webContents.send("update-error", err)
            log.error(`update: ERROR: ${err}`)
        })
    })

    /*  cleanup from old update  */
    await update.cleanup()

    /*  at least once prepare the browser abstraction  */
    Browser.prepare()

    /*  provide IPC hooks for browsers control  */
    log.info("provide IPC hooks for browser control")
    const browsers = {}
    const controlBrowser = async (action, id, cfg) => {
        if (action === "prune") {
            for (const id of Object.keys(browsers)) {
                if (browsers[id].running())
                    browsers[id].stop()
                delete browsers[id]
            }
        }
        else if (action === "add") {
            /*  add browser configuration  */
            browsers[id] = new Browser(log, id, cfg, control, FFmpeg.binary, mediaDir)
            syslog.info("instance", `added: "${cfg.t}" (id=${id})`)
        }
        else if (action === "mod") {
            /*  modify browser configuration  */
            browsers[id].reconfigure(cfg)
            syslog.info("instance", `modified: "${cfg.t}" (id=${id})`)
        }
        else if (action === "del") {
            /*  delete browser configuration  */
            const title = browsers[id]?.cfg?.t || id
            if (browsers[id] !== undefined && browsers[id].running())
                await controlBrowser("stop", id)
            delete browsers[id]
            syslog.info("instance", `deleted: "${title}" (id=${id})`)
        }
        else if (action === "start-all") {
            /*  start all browsers  */
            const p = []
            for (const id of Object.keys(browsers))
                if (!browsers[id].running() && browsers[id].valid())
                    p.push(controlBrowser("start", id))
            await Promise.all(p)
        }
        else if (action === "reload-all") {
            /*  reload all browsers  */
            const p = []
            for (const id of Object.keys(browsers))
                if (browsers[id].running())
                    p.push(controlBrowser("reload", id))
            await Promise.all(p)
        }
        else if (action === "stop-all") {
            /*  stop all browsers  */
            const p = []
            for (const id of Object.keys(browsers))
                if (browsers[id].running())
                    p.push(controlBrowser("stop", id))
            await Promise.all(p)
        }
        else if (action === "start") {
            /*  start a particular browser  */
            const browser = browsers[id]
            if (browser === undefined)
                throw new Error("invalid browser id")
            if (browser.running())
                throw new Error("browser already running")
            if (!browser.valid())
                throw new Error("browser configuration not valid")
            control.webContents.send("browser-start", id)
            const success = await browser.start()
            if (success) {
                control.webContents.send("browser-started", id)
                syslog.info("instance", `started: "${browser.cfg.t}" (id=${id})`)
            }
            else {
                control.webContents.send("browser-failed", id)
                syslog.error("instance", `start failed: "${browser.cfg.t}" (id=${id})`)
                browser.stop()
            }
        }
        else if (action === "reload") {
            /*  reload a particular browser  */
            const browser = browsers[id]
            if (browser === undefined)
                throw new Error("invalid browser id")
            if (!browser.running())
                throw new Error("browser still not running")
            control.webContents.send("browser-reload", id)
            browser.reload()
            control.webContents.send("browser-reloaded", id)
            syslog.info("instance", `reloaded: "${browser.cfg.t}" (id=${id})`)
        }
        else if (action === "stop") {
            /*  stop a particular browser  */
            const browser = browsers[id]
            if (browser === undefined)
                throw new Error("invalid browser id")
            if (!browser.running())
                throw new Error("browser still not running")
            control.webContents.send("browser-stop", id)
            await browser.stop()
            control.webContents.send("browser-stopped", id)
            syslog.info("instance", `stopped: "${browser.cfg.t}" (id=${id})`)
        }
        else if (action === "clear") {
            /*  clear a particular browser  */
            const browser = browsers[id]
            if (browser === undefined)
                throw new Error("invalid browser id")
            if (browser.running())
                throw new Error("browser still running")
            control.webContents.send("browser-clear", id)
            await browser.clear()
            control.webContents.send("browser-cleared", id)
        }
    }
    electron.ipcMain.handle("control", (ev, action, id, browser) => {
        return controlBrowser(action, id, browser)
    })

    /*  show the window once the DOM was mounted  */
    electron.ipcMain.handle("control-mounted", (ev) => {
        /*  bring user interface into final state   */
        if (headless) {
            log.info("headless mode: control window remains hidden; manage via WebUI")
        }
        else if (initiallyMinimized) {
            log.info("bring user interface into final state (minimized)")
            control.minimize()
        }
        else {
            log.info("bring user interface into final state (shown and focused)")
            control.show()
            control.focus()
        }

        /*  auto-start browser instances:
            1. --autostart flag starts all instances
            2. InstanceAutoStart (as) per-instance flag starts specific instances  */
        if (autostart) {
            setTimeout(() => {
                log.info("auto-start all browser instances (--autostart flag)")
                controlBrowser("start-all")
            }, 2000)
        }
        else {
            /*  per-instance auto-start  */
            setTimeout(() => {
                for (const id of Object.keys(browsers)) {
                    if (browsers[id].cfg.as && !browsers[id].running() && browsers[id].valid()) {
                        log.info(`auto-start browser instance (InstanceAutoStart): ${browsers[id].cfg.t}`)
                        controlBrowser("start", id).catch((err) => {
                            log.warn(`auto-start failed for ${id}: ${err.message}`)
                        })
                    }
                }
            }, 2000)
        }
    })

    /*  load web content  */
    log.info("loading control user interface")
    control.loadURL(`file://${path.join(__dirname, "vingester-control.html")}`)
    control.webContents.on("did-fail-load", (ev) => {
        electron.app.quit()
    })

    /*  wait until control UI is created  */
    log.info("awaiting control user interface to become ready")
    let controlReady = false
    electron.ipcMain.handle("control-created", (ev) => {
        controlReady = true
    })
    await new Promise((resolve) => {
        const check = () => {
            if (controlReady)
                resolve()
            else
                setTimeout(check, 100)
        }
        setTimeout(check, 100)
    })

    /*  send parameters  */
    if (tag !== null)
        control.webContents.send("tag", tag)
    control.webContents.send("autosave-file", autosaveFile)

    /*  toggle GPU hardware acceleration  */
    log.info("send GPU status and provide IPC hook for GPU status change")
    control.webContents.send("gpu", !!store.get("gpu"))
    electron.ipcMain.handle("gpu", async (ev, gpu) => {
        const choice = electron.dialog.showMessageBoxSync(control, {
            message: `${gpu ? "Enabling" : "Disabling"} GPU hardware acceleration ` +
                "requires an application restart.",
            type: "question",
            buttons: [ "Restart", "Cancel" ],
            cancelId: 1
        })
        if (choice === 1)
            return
        store.set("gpu", gpu)
        control.webContents.send("gpu", gpu)
        electron.app.relaunch()
        electron.app.exit()
    })

    /*  toggle REST API  */
    const API = class {
        constructor () {
            this.app     = null
            this.server  = null
            this.enabled = false
            this.addr    = "127.0.0.1"
            this.port    = "7211"
        }
        async configure (cfg) {
            this.enabled = cfg.enabled ?? false
            this.addr    = cfg.addr    ?? "127.0.0.1"
            this.port    = cfg.port    ?? "7211"
            if (this.enabled && !this.server)
                this.start()
            else if (!this.enabled && this.server)
                this.stop()
        }
        async start () {
            log.info("start API")
            this.app = express()
            this.app.use(express.json())

            /*  common middleware: server header, CORS, request logging  */
            this.app.use((req, res, next) => {
                res.set("Server", `${pkg.name}/${pkg.version}`)
                res.set("Access-Control-Allow-Origin", "*")
                res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                res.set("Access-Control-Allow-Headers", "Content-Type")
                if (req.method === "OPTIONS") return res.sendStatus(204)
                res.on("finish", () => {
                    log.info(`API: request: remote=${req.ip}, method=${req.method}, url=${req.path}, response=${res.statusCode}`)
                })
                next()
            })

            /*  GET / — list all browser titles  */
            this.app.get("/", (req, res) => {
                const response = []
                for (const id of Object.keys(browsers))
                    response.push(browsers[id].cfg.t)
                res.status(200).json(response)
            })

            /*  GET|POST /:browser/:command — control by title or "all"  */
            this.app.all("/:browser/:command", async (req, res) => {
                const { browser, command } = req.params
                try {
                    if (browser === "all") {
                        if (command === "start")
                            await controlBrowser("start-all")
                        else if (command === "reload")
                            await controlBrowser("reload-all")
                        else if (command === "stop")
                            await controlBrowser("stop-all")
                        else
                            return res.status(400).json({ error: "invalid command" })
                    }
                    else {
                        const id = Object.keys(browsers).find((id) => browsers[id].cfg.t === browser)
                        if (id === undefined)
                            return res.status(404).json({ error: "invalid browser title/name" })
                        if (command === "start")
                            await controlBrowser("start", id)
                        else if (command === "reload")
                            await controlBrowser("reload", id)
                        else if (command === "stop")
                            await controlBrowser("stop", id)
                        else if (command === "clear")
                            await controlBrowser("clear", id)
                        else
                            return res.status(400).json({ error: "invalid command" })
                    }
                    res.status(200).send("OK")
                }
                catch (err) {
                    res.status(417).json({ error: err.message })
                }
            })

            /*  404 catch-all  */
            this.app.use((req, res) => res.status(404).json({ error: "resource not found" }))

            this.server = http.createServer(this.app)
            await new Promise((resolve, reject) => {
                this.server.once("error", reject)
                this.server.listen(parseInt(this.port), this.addr, resolve)
            })
        }
        async stop () {
            log.info("stop API")
            await new Promise((resolve) => this.server.close(resolve)).catch(() => {})
            this.server = null
            this.app    = null
        }
    }
    log.info("create API")
    const api = new API()
    api.configure({
        enabled: store.get("api.enabled"),
        addr:    store.get("api.addr"),
        port:    store.get("api.port")
    })
    log.info("send API status and provide IPC hook for API status change")
    control.webContents.send("api", {
        enabled: api.enabled,
        addr:    api.addr,
        port:    api.port
    })
    electron.ipcMain.handle("api", async (ev, cfg) => {
        store.set("api.enabled", cfg.enabled)
        store.set("api.addr",    cfg.addr)
        store.set("api.port",    cfg.port)
        api.configure({
            enabled: cfg.enabled,
            addr:    cfg.addr,
            port:    cfg.port
        })
    })

    /*  Web UI server - serves the web dashboard and media files  */
    const WebUI = class {
        constructor () {
            this.app     = null
            this.server  = null
            this.enabled = false
            this.addr    = "127.0.0.1"
            this.port    = "7212"
        }
        async configure (cfg) {
            this.enabled = cfg.enabled ?? false
            this.addr    = cfg.addr    ?? "127.0.0.1"
            this.port    = cfg.port    ?? "7212"
            if (this.enabled && !this.server)
                await this.start()
            else if (!this.enabled && this.server)
                await this.stop()
        }
        async start () {
            log.info("start Web UI")
            this.app = express()
            this.app.use(express.json())

            /*  common middleware: server header, CORS  */
            this.app.use((req, res, next) => {
                res.set("Server", `${pkg.name}/${pkg.version}`)
                res.set("Access-Control-Allow-Origin", "*")
                res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
                res.set("Access-Control-Allow-Headers", "Content-Type")
                if (req.method === "OPTIONS") return res.sendStatus(204)
                next()
            })

            /*  helper: persist in-memory browsers to store and notify Control UI  */
            const debouncedAutosave = debounce(10 * 1000, performAutosave)
            const saveBrowsersToStore = () => {
                const cfgArray = Object.keys(browsers).map((bid) => ({ id: bid, ...browsers[bid].cfg }))
                saveConfigs(cfgArray)
                if (control && !control.isDestroyed())
                    control.webContents.send("browsers-refresh")
                debouncedAutosave()
            }

            /*  async route wrapper for error propagation  */
            const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

            /*  serve the web UI dashboard  */
            this.app.get("/", wrap(async (req, res) => {
                const htmlPath = path.join(__dirname, "vingester-webui.html")
                const html = await fs.promises.readFile(htmlPath, { encoding: "utf8" })
                res.set("Cache-Control", "no-store")
                res.status(200).type("text/html; charset=utf-8").send(html)
            }))

            /*  REST API: version info  */
            this.app.get("/api/version", (req, res) => {
                res.status(200).json({ version: version.vingester, app: pkg.name })
            })

            /*  REST API: list all instances  */
            this.app.get("/api/instances", (req, res) => {
                const result = []
                for (const id of Object.keys(browsers)) {
                    const b = browsers[id]
                    result.push({
                        id,
                        running: b.running(),
                        title:   b.cfg.t,
                        info:    b.cfg.i,
                        url:     b.cfg.u,
                        inputType: b.cfg.it,
                        width:   b.cfg.w,
                        height:  b.cfg.h,
                        fps:     b.cfg.f,
                        ndi:     b.cfg.N,
                        autoRefresh: b.cfg.ar,
                        autoRefreshInterval: b.cfg.ai,
                        autoStart: b.cfg.as,
                        cfg:     { ...b.cfg }
                    })
                }
                res.status(200).json(result)
            })

            /*  REST API: add new instance  */
            this.app.post("/api/instances", wrap(async (req, res) => {
                const body = req.body || {}
                const id = new UUID(1).fold(2).map((n) =>
                    n.toString(16).toUpperCase().padStart(2, "0")).join("")
                const cfg = { id, ...body }
                sanitizeConfig(cfg)
                await controlBrowser("add", id, cfg)
                saveBrowsersToStore()
                log.info(`WebUI: added browser instance: ${cfg.t}`)
                res.status(201).json({ ok: true, id })
            }))

            /*  REST API: update instance config — auto-restart if running  */
            this.app.patch("/api/instances/:id", wrap(async (req, res) => {
                const { id } = req.params
                if (!browsers[id])
                    return res.status(404).json({ error: "instance not found" })
                const cfg = { ...browsers[id].cfg, ...(req.body || {}) }
                sanitizeConfig(cfg)
                const wasRunning = browsers[id].running()
                if (wasRunning)
                    await controlBrowser("stop", id)
                await controlBrowser("mod", id, cfg)
                if (wasRunning)
                    await controlBrowser("start", id)
                saveBrowsersToStore()
                log.info(`WebUI: modified browser instance: ${cfg.t}${wasRunning ? " (auto-restarted)" : ""}`)
                if (wasRunning)
                    syslog.info("webui", `auto-restarted after edit: "${cfg.t}" (id=${id})`)
                res.status(200).json({ ok: true, restarted: wasRunning })
            }))

            /*  REST API: delete instance  */
            this.app.delete("/api/instances/:id", wrap(async (req, res) => {
                const { id } = req.params
                if (!browsers[id])
                    return res.status(404).json({ error: "instance not found" })
                const title = browsers[id].cfg.t
                await controlBrowser("del", id)
                saveBrowsersToStore()
                log.info(`WebUI: deleted browser instance: ${title}`)
                res.status(200).json({ ok: true })
            }))

            /*  REST API: instance control  */
            this.app.all("/api/instances/:id/:command", wrap(async (req, res) => {
                const { id, command } = req.params
                const validCommands = [ "start", "stop", "reload", "clear" ]
                if (!validCommands.includes(command))
                    return res.status(400).json({ error: "invalid command" })
                if (!browsers[id])
                    return res.status(404).json({ error: "instance not found" })
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("operation timed out after 12 seconds")), 12000))
                await Promise.race([ controlBrowser(command, id), timeout ])
                res.status(200).json({ ok: true })
            }))

            /*  REST API: start/stop/reload all  */
            this.app.all("/api/all/:command", wrap(async (req, res) => {
                const { command } = req.params
                const map = { start: "start-all", stop: "stop-all", reload: "reload-all" }
                if (!map[command])
                    return res.status(400).json({ error: "invalid command" })
                await controlBrowser(map[command])
                res.status(200).json({ ok: true })
            }))

            /*  serve media files from the media directory  */
            this.app.get("/media/:filename", wrap(async (req, res) => {
                const safeName = path.basename(req.params.filename)
                const filePath = path.join(mediaDir, safeName)
                try {
                    const data = await fs.promises.readFile(filePath)
                    const ext = path.extname(safeName).toLowerCase().slice(1)
                    const mimeMap = {
                        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
                        svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
                        ogg: "video/ogg", mov: "video/quicktime"
                    }
                    const mime = mimeMap[ext] || "application/octet-stream"
                    res.status(200).type(mime).send(data)
                }
                catch (err) {
                    res.status(404).json({ error: "media file not found" })
                }
            }))

            /*  list media library  */
            this.app.get("/api/media", wrap(async (req, res) => {
                const imageExts = new Set([ ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg" ])
                const videoExts = new Set([ ".mp4", ".webm", ".ogg", ".mov", ".mkv", ".avi" ])
                let files = []
                try {
                    const entries = await fs.promises.readdir(mediaDir)
                    for (const entry of entries) {
                        const ext = path.extname(entry).toLowerCase()
                        if (imageExts.has(ext) || videoExts.has(ext)) {
                            const stat = await fs.promises.stat(path.join(mediaDir, entry))
                            files.push({
                                name: entry,
                                type: imageExts.has(ext) ? "image" : "video",
                                size: stat.size,
                                url:  `/media/${entry}`,
                                fullPath: path.join(mediaDir, entry)
                            })
                        }
                    }
                }
                catch (err) {
                    log.warn(`WebUI: could not read media dir: ${err.message}`)
                }
                res.status(200).json(files)
            }))

            /*  upload media files  */
            const upload = multer({
                dest:   mediaDir,
                limits: { fileSize: 500 * 1024 * 1024 }  /*  500 MB limit  */
            })
            this.app.post("/api/media/upload", upload.single("file"), wrap(async (req, res) => {
                const allowedExts = new Set([
                    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
                    ".mp4", ".webm", ".ogg", ".mov"
                ])
                if (!req.file)
                    return res.status(400).json({ error: "no file in upload" })

                const ext = path.extname(req.file.originalname).toLowerCase()
                if (!allowedExts.has(ext)) {
                    await fs.promises.unlink(req.file.path).catch(() => {})
                    return res.status(415).json({
                        error: `File type '${ext}' not allowed. Allowed: images and videos only.`
                    })
                }

                /*  build timestamped name: AppName_YYYYMMDD_HHmmss[_N].ext  */
                const now   = new Date()
                const pad   = (n) => String(n).padStart(2, "0")
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
                              `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const base  = `${pkg.name}_${stamp}`
                let safeName = base + ext
                let destPath = path.join(mediaDir, safeName)
                let counter  = 0
                while (true) {
                    try {
                        await fs.promises.access(destPath, fs.constants.F_OK)
                        /*  file exists — try next counter  */
                        counter++
                        safeName = `${base}_${counter}${ext}`
                        destPath = path.join(mediaDir, safeName)
                    }
                    catch { break }  /*  access throws when file absent — slot is free  */
                }
                await fs.promises.rename(req.file.path, destPath)

                const sizeKB = Math.round(req.file.size / 1024)
                log.info(`WebUI: uploaded media file: ${safeName} (original: ${req.file.originalname})`)
                syslog.info("media", `uploaded: "${safeName}" (${sizeKB} KB, original: ${req.file.originalname})`)
                res.status(200).json({ ok: true, name: safeName, url: `/media/${safeName}` })
            }))

            /*  delete media file  */
            this.app.delete("/api/media/:filename", wrap(async (req, res) => {
                const safeName = path.basename(req.params.filename)
                const filePath = path.join(mediaDir, safeName)
                try {
                    await fs.promises.unlink(filePath)
                    log.info(`WebUI: deleted media file: ${safeName}`)
                    res.status(200).json({ ok: true })
                }
                catch (err) {
                    res.status(404).json({ error: "media file not found" })
                }
            }))

            /*  global error handler  */
            this.app.use((err, req, res, next) => {
                log.error(`WebUI: unhandled error: ${err.message}`)
                res.status(500).json({ error: err.message })
            })

            /*  404 catch-all  */
            this.app.use((req, res) => res.status(404).json({ error: "resource not found" }))

            this.server = http.createServer(this.app)
            await new Promise((resolve, reject) => {
                this.server.once("error", reject)
                this.server.listen(parseInt(this.port), this.addr, resolve)
            })
            log.info(`Web UI available at http://${this.addr}:${this.port}/`)
        }
        async stop () {
            log.info("stop Web UI")
            await new Promise((resolve) => this.server.close(resolve)).catch(() => {})
            this.server = null
            this.app    = null
        }
    }
    log.info("create Web UI")
    const webui = new WebUI()
    await webui.configure({
        enabled: store.get("webui.enabled"),
        addr:    store.get("webui.addr"),
        port:    store.get("webui.port")
    }).catch((err) => {
        log.error(`WebUI: failed to start: ${err.message}`)
    })
    log.info("send Web UI status and provide IPC hook for Web UI status change")
    control.webContents.send("webui", {
        enabled: webui.enabled,
        addr:    webui.addr,
        port:    webui.port
    })
    electron.ipcMain.handle("webui", async (ev, cfg) => {
        store.set("webui.enabled", cfg.enabled)
        store.set("webui.addr",    cfg.addr)
        store.set("webui.port",    cfg.port)
        try {
            await webui.configure({
                enabled: cfg.enabled,
                addr:    cfg.addr,
                port:    cfg.port
            })
        }
        catch (err) {
            log.error(`WebUI: configure failed: ${err.message}`)
            control.webContents.send("webui-error", err.message)
        }
    })

    /*  syslog IPC handlers  */
    electron.ipcMain.handle("syslog-get", () => ({
        enabled: store.get("syslog.enabled", false),
        ip:      store.get("syslog.ip",      ""),
        port:    store.get("syslog.port",    514)
    }))
    electron.ipcMain.handle("syslog-set", async (ev, cfg) => {
        store.set("syslog.enabled", cfg.enabled)
        store.set("syslog.ip",      cfg.ip)
        store.set("syslog.port",    cfg.port)
        syslog.configure({ enabled: cfg.enabled, ip: cfg.ip, port: cfg.port })
        syslog.info("app", `syslog configured: ${cfg.enabled ? `${cfg.ip}:${cfg.port}` : "disabled"}`)
        control.webContents.send("syslog", { enabled: cfg.enabled, ip: cfg.ip, port: cfg.port })
    })
    /*  send initial syslog state to control UI  */
    control.webContents.send("syslog", {
        enabled: store.get("syslog.enabled", false),
        ip:      store.get("syslog.ip",      ""),
        port:    store.get("syslog.port",    514)
    })

    /*  collect metrics  */
    log.info("start usage gathering timer")
    const usages = new util.WeightedAverage(20, 5)
    let cpuHighCount = 0
    let timer = setInterval(() => {
        if (timer === null)
            return
        const metrics = electron.app.getAppMetrics()
        let usage = 0
        for (const metric of metrics)
            usage += metric.cpu.percentCPUUsage
        usages.record(usage, (stat) => {
            control.webContents.send("usage", stat.avg)
            /*  alert via syslog if CPU exceeds 80% for 3 consecutive readings (~30s)  */
            if (stat.avg >= 80) {
                cpuHighCount++
                if (cpuHighCount === 3)
                    syslog.warn("system", `high CPU usage: ${Math.round(stat.avg)}%`)
            }
            else {
                cpuHighCount = 0
            }
        })
    }, 100)

    /*  start 5-minute autosave timer  */
    log.info("start autosave timer (5-minute interval)")
    autosaveTimer = setInterval(performAutosave, 5 * 60 * 1000)

    /*  register some global shortcuts  */
    electron.globalShortcut.register("Control+Alt+Shift+Escape", () => {
        log.info("catched global hotkey for stopping all browsers")
        controlBrowser("stop-all")
    })

    /*  optionally auto-import configuration  */
    if (configFile !== null) {
        if (await pathExists(configFile)) {
            log.info(`loading auto-import/export configuration: "${configFile}"`)
            await importConfig(configFile)
            control.webContents.send("load")
        }
        else
            log.warn(`auto-import/export configuration not found: "${configFile}"`)
    }

    /*  gracefully shutdown application  */
    log.info("hook into control user interface window states")
    control.on("close", async (ev) => {
        log.info("shutting down")
        ev.preventDefault()

        /*  stop usage timer  */
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }

        /*  stop autosave timer and perform a final save  */
        if (autosaveTimer !== null) {
            clearInterval(autosaveTimer)
            autosaveTimer = null
        }
        await performAutosave()

        /*  stop all browsers  */
        await controlBrowser("stop-all", null)

        /*  stop API  */
        if (api.hapi)
            await api.stop()

        /*  stop Web UI  */
        if (webui.hapi)
            await webui.stop()

        /*  optionally auto-export configuration  */
        if (configFile !== null) {
            control.webContents.send("save")
            await new Promise((resolve) => setTimeout(resolve, 500))
            await exportConfig(configFile)
        }

        /*  save window bounds  */
        updateBounds()

        /*  destroy control user interface  */
        control.destroy()
    })
    electron.app.on("window-all-closed", () => {
        /*  optionally destroy NDI library  */
        if (grandiose.isSupportedCPU())
            grandiose.destroy()

        /*  finally destroy electron  */
        electron.app.quit()
    })
    for (const signal of [ "SIGINT", "SIGTERM" ]) {
        process.on(signal, () => {
            /*  optionally destroy NDI library  */
            if (grandiose.isSupportedCPU())
                grandiose.destroy()

            /*  finally destroy electron  */
            electron.app.quit()
        })
    }
    electron.app.on("will-quit", () => {
        log.info("terminating")
    })

    log.info("up and running")
})
