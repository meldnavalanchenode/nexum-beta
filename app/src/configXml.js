// FTC active-configuration parser. The config is machine-generated XML at
// /sdcard/FIRST/*.xml on the Control Hub. Parsed tolerantly but honestly:
// XML comments are dead (QA: commented-out devices masked real failures),
// single-quoted attributes are legal XML (QA: they silently vanished),
// entities are decoded, duplicate attributes are surfaced, and anything
// unrecognized lands in model.unparsed — never dropped.

const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

import { sanitizeLine } from './text.js'

const decodeEntities = (s) => s
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// REV hub physical port ranges — hand-edited configs (a workflow PHYSYNC
// itself recommends during swap recovery) can declare impossible ports.
export const PORT_RANGES = {
  motor: [0, 3], servo: [0, 5], digital: [0, 7], analog: [0, 3], i2c: [0, 3],
}

/** Port space for collision checking. Servo-port PWM devices that don't say
 *  "Servo" (Blinkin, SPARKmini) are checked FIRST — QA caught /Led/ routing
 *  the Blinkin into digital space, causing both wrong PASSes and wrong FAILs. */
export function portSpace(tag, attrs) {
  if (/Blinkin|SPARKMini/i.test(tag)) return 'servo'
  if (attrs.bus != null) return `i2c-bus${attrs.bus}`
  if (/Motor/i.test(tag)) return 'motor'
  if (/Servo/i.test(tag)) return 'servo'
  if (/Touch|Digital|\bLed\b|Limit/i.test(tag)) return 'digital'
  if (/Analog|Potentiometer/i.test(tag)) return 'analog'
  if (/Imu|Gyro|ColorSensor|DistanceSensor|2m|HuskyLens|OTOS|Navx/i.test(tag)) return `i2c-bus${attrs.bus ?? 0}`
  return null
}

export function parseConfigXml(xml) {
  if (xml.length > 2_000_000) throw new Error('file is far too large to be a robot configuration')
  // Blank out comments preserving newlines so line numbers stay true.
  const live = xml.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const model = {
    isFtcConfig: /<Robot\b/.test(live),
    portals: [], webcams: [], devices: [], unparsed: [],
  }
  let portal = null
  let hub = null
  // Incremental line counter — matches arrive in ascending index order
  // (QA: per-tag slice().split() made a big config quadratic).
  let cursor = 0
  let line = 1
  const lineOf = (idx) => {
    for (; cursor < idx; cursor++) if (live.charCodeAt(cursor) === 10) line++
    return line
  }

  for (const m of live.matchAll(TAG)) {
    const [, closing, tag, rawAttrs] = m
    if (closing) {
      if (tag === 'LynxModule') hub = null
      if (tag === 'LynxUsbDevice') portal = null
      continue
    }
    const attrs = {}
    const duplicated = []
    for (const a of rawAttrs.matchAll(ATTR)) {
      const key = a[1]
      // sanitizeLine = XML attribute-value normalization (newlines→spaces)
      // plus control-byte neutralization: the injection hunt proved a device
      // name can otherwise carry ANSI escapes that repaint the operator's
      // verdict banner, or embedded newlines that forge whole output lines.
      const value = sanitizeLine(decodeEntities(a[2] ?? a[3] ?? ''))
      if (key in attrs) duplicated.push(key)
      attrs[key] = value
    }
    const at = lineOf(m.index)
    if (duplicated.length) {
      model.unparsed.push({ line: at, text: `<${tag}> has duplicate attribute(s) ${duplicated.join(', ')} — not well-formed XML; last value used` })
    }

    if (tag === 'Robot') continue
    if (tag === 'LynxUsbDevice') {
      portal = {
        name: attrs.name ?? '(unnamed portal)',
        serialNumber: attrs.serialNumber ?? null,
        parentModuleAddress: attrs.parentModuleAddress != null ? Number(attrs.parentModuleAddress) : null,
        hubs: [],
        line: at,
      }
      model.portals.push(portal)
      continue
    }
    if (tag === 'LynxModule') {
      // NaN never equals itself — a non-numeric address would haunt every
      // future snapshot diff as phantom drift (fuzz invariant I6).
      const address = Number(attrs.port)
      hub = { name: attrs.name ?? '(unnamed hub)', address: Number.isNaN(address) ? null : address, devices: [], line: at }
      if (Number.isNaN(address)) model.unparsed.push({ line: at, text: `LynxModule "${attrs.name}" has non-numeric address "${attrs.port}"` })
      if (portal) portal.hubs.push(hub)
      else model.unparsed.push({ line: at, text: `LynxModule "${attrs.name}" outside any LynxUsbDevice` })
      continue
    }
    if (tag === 'Webcam') {
      model.webcams.push({ name: attrs.name, serialNumber: attrs.serialNumber ?? null, line: at })
      continue
    }
    if (attrs.name != null && attrs.port != null) {
      const portNum = Number(attrs.port)
      const busNum = attrs.bus != null ? Number(attrs.bus) : null
      const device = {
        type: tag,
        name: attrs.name,
        port: Number.isNaN(portNum) ? null : portNum,
        portRaw: Number.isNaN(portNum) ? attrs.port : null,
        bus: busNum != null && Number.isNaN(busNum) ? null : busNum,
        space: portSpace(tag, attrs),
        hub: hub ? hub.name : null,
        hubAddress: hub ? hub.address : null,
        portal: portal ? portal.name : null,
        line: at,
      }
      if (hub) hub.devices.push(device)
      model.devices.push(device)
      continue
    }
    model.unparsed.push({ line: at, text: `<${tag}${rawAttrs}>` })
  }
  return model
}

/** Stable snapshot form for drift detection — includes type (QA: a motor
 *  model swap changes ticks-per-rev and must not report NO DRIFT). */
export function toSnapshot(model) {
  return {
    portals: model.portals.map((p) => ({
      name: p.name, serialNumber: p.serialNumber, parentModuleAddress: p.parentModuleAddress,
      hubs: p.hubs.map((h) => ({ name: h.name, address: h.address })),
    })),
    devices: model.devices.map((d) => ({
      type: d.type, name: d.name, port: d.port, bus: d.bus, hub: d.hub,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}
