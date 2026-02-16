#!/usr/bin/env node
/*
**  Vingester Windows Service Installer
**  Copyright (c) 2021-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
**
**  Usage:
**    node install-service.js install   [--name <svcName>] [--args "<extra args>"]
**    node install-service.js uninstall [--name <svcName>]
**    node install-service.js start     [--name <svcName>]
**    node install-service.js stop      [--name <svcName>]
**    node install-service.js status    [--name <svcName>]
**
**  Requirements:
**    - Windows OS
**    - NSSM (Non-Sucking Service Manager) in PATH, OR
**      installed via: https://nssm.cc/download
**    - Run as Administrator
**
**  Example (from repo root, run as Administrator):
**    node installer\install-service.js install --name VingesterNDI --args "--autostart --config C:\vingester\config.yaml"
*/

const os      = require("os")
const fs      = require("fs")
const path    = require("path")
const { execSync, spawnSync } = require("child_process")

/*  parse simple CLI args  */
const args    = process.argv.slice(2)
const action  = args[0]
let svcName   = "Vingester"
let extraArgs = "--autostart"

for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1])  { svcName   = args[++i]; continue }
    if (args[i] === "--args" && args[i + 1])  { extraArgs = args[++i]; continue }
}

/*  check platform  */
if (os.platform() !== "win32") {
    console.error("ERROR: This script is Windows-only.")
    console.error("For Linux/macOS, use systemd or launchd instead.")
    console.error("See the README.md for instructions.")
    process.exit(1)
}

/*  find the Vingester executable  */
const appRoot = path.resolve(__dirname, "..")
const possibleExes = [
    path.join(appRoot, "dist", "win-unpacked", "Vingester.exe"),
    path.join(appRoot, "dist", "Vingester.exe"),
    path.join(appRoot, "Vingester.exe")
]
let exePath = null
for (const p of possibleExes) {
    if (fs.existsSync(p)) {
        exePath = p
        break
    }
}
if (!exePath && action === "install") {
    console.error("ERROR: Could not find Vingester.exe.")
    console.error("Please build the application first: npm run package")
    console.error("Or specify the path in install-service.js.")
    process.exit(1)
}

/*  find NSSM  */
function findNSSM () {
    try {
        execSync("nssm version", { stdio: "pipe" })
        return "nssm"
    }
    catch (e) {}
    /*  check common install locations  */
    const candidates = [
        "C:\\nssm\\nssm.exe",
        "C:\\nssm\\win64\\nssm.exe",
        "C:\\Program Files\\nssm\\nssm.exe",
        "C:\\tools\\nssm\\nssm.exe"
    ]
    for (const c of candidates) {
        if (fs.existsSync(c)) return `"${c}"`
    }
    return null
}

function run (cmd, ignoreError) {
    console.log(`  > ${cmd}`)
    const result = spawnSync(cmd, { shell: true, stdio: "inherit" })
    if (result.status !== 0 && !ignoreError) {
        console.error(`ERROR: command failed with exit code ${result.status}`)
        process.exit(result.status)
    }
}

/*  print usage  */
if (!action || action === "--help" || action === "-h") {
    console.log("Vingester Windows Service Installer")
    console.log("")
    console.log("Usage:")
    console.log("  node install-service.js install   [--name <name>] [--args \"<args>\"]")
    console.log("  node install-service.js uninstall [--name <name>]")
    console.log("  node install-service.js start     [--name <name>]")
    console.log("  node install-service.js stop      [--name <name>]")
    console.log("  node install-service.js status    [--name <name>]")
    console.log("")
    console.log("Options:")
    console.log("  --name <name>   Service name (default: Vingester)")
    console.log("  --args <args>   Extra arguments passed to Vingester.exe")
    console.log("                  (default: --autostart)")
    console.log("")
    console.log("Recommended extra args:")
    console.log("  --autostart                     Auto-start all NDI instances")
    console.log("  --config C:\\path\\config.yaml    Load+save a YAML config file")
    console.log("  --minimize                       Start minimized")
    console.log("  --profile myprofile             Use a named profile")
    console.log("")
    console.log("Example:")
    console.log('  node install-service.js install --name VingesterNDI --args "--autostart --config C:\\vingester\\config.yaml"')
    process.exit(0)
}

const nssm = findNSSM()

if (action === "install") {
    if (!nssm) {
        console.error("ERROR: NSSM not found in PATH or common locations.")
        console.error("")
        console.error("Please install NSSM:")
        console.error("  1. Download from https://nssm.cc/download")
        console.error("  2. Extract and place nssm.exe in C:\\nssm\\ or add to PATH")
        console.error("  3. Re-run this installer as Administrator")
        process.exit(1)
    }
    console.log(`Installing Windows service: "${svcName}"`)
    console.log(`  Executable: ${exePath}`)
    console.log(`  Arguments:  ${extraArgs}`)
    console.log("")

    /*  install the service  */
    run(`${nssm} install "${svcName}" "${exePath}"`)
    run(`${nssm} set "${svcName}" AppParameters "${extraArgs}"`)

    /*  configure crash recovery: restart on failure  */
    run(`${nssm} set "${svcName}" AppExit Default Restart`)
    run(`${nssm} set "${svcName}" AppRestartDelay 5000`)

    /*  configure startup type: automatic  */
    run(`${nssm} set "${svcName}" Start SERVICE_AUTO_START`)

    /*  configure display name and description  */
    run(`${nssm} set "${svcName}" DisplayName "Vingester NDI Browser Ingest"`)
    run(`${nssm} set "${svcName}" Description "Ingests web content as NDI video streams."`)

    /*  configure log files  */
    const logDir = path.join(appRoot, "logs")
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    run(`${nssm} set "${svcName}" AppStdout "${path.join(logDir, "service-stdout.log")}"`)
    run(`${nssm} set "${svcName}" AppStderr "${path.join(logDir, "service-stderr.log")}"`)
    run(`${nssm} set "${svcName}" AppRotateFiles 1`)
    run(`${nssm} set "${svcName}" AppRotateBytes 10485760`)  /*  10 MB  */

    /*  start the service  */
    run(`${nssm} start "${svcName}"`)

    console.log("")
    console.log(`SUCCESS: Service "${svcName}" installed and started.`)
    console.log(`Use "sc query ${svcName}" to check status.`)
    console.log(`Use "node install-service.js uninstall" to remove.`)
}
else if (action === "uninstall") {
    if (!nssm) {
        console.error("ERROR: NSSM not found.")
        process.exit(1)
    }
    console.log(`Uninstalling Windows service: "${svcName}"`)
    run(`${nssm} stop "${svcName}"`, true)
    run(`${nssm} remove "${svcName}" confirm`)
    console.log(`SUCCESS: Service "${svcName}" removed.`)
}
else if (action === "start") {
    if (!nssm) {
        run(`sc start "${svcName}"`)
    }
    else {
        run(`${nssm} start "${svcName}"`)
    }
}
else if (action === "stop") {
    if (!nssm) {
        run(`sc stop "${svcName}"`)
    }
    else {
        run(`${nssm} stop "${svcName}"`)
    }
}
else if (action === "status") {
    run(`sc query "${svcName}"`)
}
else {
    console.error(`Unknown action: "${action}". Use --help for usage.`)
    process.exit(1)
}
