/*
**  WebRetriever ~ Ingest Web Contents as Video Streams
**  Based on Vingester (c) 2021-2025 Dr. Ralf S. Engelschall
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

const dgram  = require("dgram")
const os     = require("os")

/*  RFC 3164 / BSD syslog severity levels  */
const SEVERITY = { emerg: 0, alert: 1, crit: 2, error: 3, warn: 4, notice: 5, info: 6, debug: 7 }
const FACILITY_LOCAL0 = 16

/*  Short month names used in RFC 3164 timestamps  */
const MONTHS = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ]

function rfc3164Timestamp (d) {
    const mo  = MONTHS[d.getMonth()]
    const day = String(d.getDate()).padStart(2, " ")
    const hh  = String(d.getHours()).padStart(2, "0")
    const mm  = String(d.getMinutes()).padStart(2, "0")
    const ss  = String(d.getSeconds()).padStart(2, "0")
    return `${mo} ${day} ${hh}:${mm}:${ss}`
}

class SyslogSender {
    constructor () {
        this.enabled  = false
        this.ip       = ""
        this.port     = 514
        this.hostname = os.hostname().split(".")[0].slice(0, 15)  /* RFC 3164: max 15 chars */
    }

    configure ({ enabled, ip, port }) {
        this.enabled = !!(enabled && ip && ip.trim())
        this.ip      = (ip  || "").trim()
        this.port    = parseInt(port, 10) || 514
    }

    /*  Send a syslog UDP datagram (fire-and-forget)  */
    send (level, tag, message) {
        if (!this.enabled || !this.ip) return
        const severity = SEVERITY[level] ?? SEVERITY.info
        const pri      = FACILITY_LOCAL0 * 8 + severity
        const ts       = rfc3164Timestamp(new Date())

        /*  RFC 3164 format: <PRI>TIMESTAMP HOSTNAME TAG: MESSAGE  */
        const raw = `<${pri}>${ts} ${this.hostname} WebRetriever[${tag}]: ${message}`
        try {
            const sock = dgram.createSocket("udp4")
            const buf  = Buffer.from(raw)
            sock.send(buf, 0, buf.length, this.port, this.ip, () => {
                sock.close()
            })
        }
        catch (_) { /* silently ignore syslog send errors */ }
    }

    info   (tag, msg) { this.send("info",   tag, msg) }
    notice (tag, msg) { this.send("notice", tag, msg) }
    warn   (tag, msg) { this.send("warn",   tag, msg) }
    error  (tag, msg) { this.send("error",  tag, msg) }
}

/*  Export a singleton — require() caches it so all callers share the same instance  */
module.exports = new SyslogSender()
