// A hand-declared device inventory — the declared layer for robots PHYSYNC
// cannot read a configuration file from.
//
// WHY THIS EXISTS. PHYSYNC's declared layer was built on one thing: an FTC
// Robot Controller configuration XML, parsed byte-for-byte off the hub. That
// file is the reason `physync check` can reconcile config against code. VEX V5
// has no such artifact to parse — VEXcode stores device configuration inside
// the project and compiles it with the program, so a name mismatch is a build
// error the toolchain already catches. There is nothing there for PHYSYNC to
// reconcile, and pretending otherwise would be inventing work.
//
// What VEX does NOT catch — what no toolchain catches — is the declaration
// drifting from the physical robot: the port label says 1 and the wire is in
// 11, the motor is declared reversed and is not, the mount moved and the
// calibration behind it is now worthless. That half is PHYSYNC's whole subject,
// and it needs exactly one thing from the platform: a list of what the team
// says is on the robot.
//
// So a person writes that list down. That is the entire adapter.
//
// THE LABELLING RULE this module enforces: an inventory is a HUMAN DECLARATION.
// It is evidence that somebody wrote a list, and nothing more. It is never
// labelled `declared/xml-parse` (which means "read off a real file on a real
// hub"), it never produces `config-code-reconciled` evidence (nothing was
// reconciled), and the state it builds records the absence as coverage rather
// than passing over it in silence.

/** What the file must say it is. Bumping this is a migration, not an edit. */
export const INVENTORY_FORMAT = 'physync-inventory-v1'

/**
 * Port shapes we know how to sanity-check. These are the ONLY hard-coded
 * platform facts in PHYSYNC, they are advisory (they produce warnings, never
 * refusals), and they are listed here so a wrong one is a one-line fix rather
 * than a hunt. `null` means "this platform's ports are not range-checked".
 */
export const PLATFORMS = {
  'vex-v5': {
    label: 'VEX V5',
    buses: {
      smart: { label: 'V5 smart port', test: (p) => /^\d+$/.test(p) && +p >= 1 && +p <= 21, hint: 'V5 smart ports are numbered 1–21' },
      'three-wire': { label: 'V5 three-wire port', test: (p) => /^[A-H]$/i.test(p), hint: 'V5 three-wire ports are lettered A–H' },
    },
    defaultBus: 'smart',
  },
  // A deliberate escape hatch: any robot, no port rules. Used by teams on
  // platforms nobody has taught PHYSYNC about, and by tests.
  generic: {
    label: 'unspecified platform',
    buses: { generic: { label: 'port', test: () => true, hint: '' } },
    defaultBus: 'generic',
  },
}

const NAME_RE = /^[A-Za-z_][\w]*$/

/**
 * Parse and validate an inventory file.
 *
 * Refusals are structural only — things that would make the record ambiguous
 * or make a later lookup wrong. Anything that is merely UNFAMILIAR (a device
 * type nobody taught us, a port outside the documented range) comes back as a
 * warning, because refusing a team's real robot over PHYSYNC's incomplete
 * knowledge of VEX would be the tool asserting more than it knows.
 *
 * @returns {{format, platform, platformLabel, robotId, declaredBy, note, devices, warnings}}
 */
export function parseInventory(text, { filename = 'inventory' } = {}) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`${filename} is not valid JSON: ${e.message}`)
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${filename} must be a JSON object`)
  }
  if (raw.format !== INVENTORY_FORMAT) {
    throw new Error(`${filename} must declare "format": "${INVENTORY_FORMAT}" (got ${JSON.stringify(raw.format ?? null)})`)
  }

  const platformId = raw.platform ?? 'generic'
  const platform = PLATFORMS[platformId]
  if (!platform) {
    throw new Error(`unknown platform "${platformId}" — known: ${Object.keys(PLATFORMS).join(', ')}`)
  }

  // An inventory is somebody's word, so the record says whose. Same rule the
  // graph applies to approved edges and `physync change` applies to reports.
  if (typeof raw.declaredBy !== 'string' || !raw.declaredBy.trim()) {
    throw new Error(`${filename} needs "declaredBy": "<yourName>" — a hand-written inventory is a person's claim about a robot, so the record says whose`)
  }
  if (!Array.isArray(raw.devices) || raw.devices.length === 0) {
    throw new Error(`${filename} needs a non-empty "devices" array`)
  }

  const warnings = []
  const devices = []
  const byName = new Map()
  const byPort = new Map()

  raw.devices.forEach((d, i) => {
    const where = `devices[${i}]`
    if (d == null || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${where} must be an object`)

    const name = typeof d.name === 'string' ? d.name.trim() : ''
    if (!name) throw new Error(`${where} needs a "name" — the identifier the program uses for this device`)
    if (!NAME_RE.test(name)) {
      throw new Error(`${where} name "${name}" is not a legal program identifier (letters, digits, underscore; not starting with a digit)`)
    }
    if (byName.has(name)) {
      throw new Error(`two devices are both named "${name}" (${where} and devices[${byName.get(name)}]) — a duplicate name makes every later reference ambiguous`)
    }
    byName.set(name, i)

    const type = typeof d.type === 'string' ? d.type.trim() : ''
    if (!type) throw new Error(`${where} ("${name}") needs a "type" — for example motor, inertial, rotation, distance, optical`)

    const bus = (typeof d.bus === 'string' && d.bus.trim()) ? d.bus.trim() : platform.defaultBus
    const busSpec = platform.buses[bus]
    if (!busSpec) {
      throw new Error(`${where} ("${name}") is on bus "${bus}", which ${platform.label} does not have — known: ${Object.keys(platform.buses).join(', ')}`)
    }

    const port = d.port == null ? '' : String(d.port).trim()
    if (!port) throw new Error(`${where} ("${name}") needs a "port"`)

    const portKey = `${bus}:${port.toUpperCase()}`
    if (byPort.has(portKey)) {
      throw new Error(`"${name}" and "${byPort.get(portKey)}" are both declared on ${busSpec.label} ${port} — two devices cannot share one port, so one of these is wrong`)
    }
    byPort.set(portKey, name)

    // Advisory, never fatal: our port map may simply be out of date.
    if (!busSpec.test(port)) {
      warnings.push(`"${name}" is on ${busSpec.label} ${port}${busSpec.hint ? ` — ${busSpec.hint}` : ''}. Check it, or ignore this if PHYSYNC's port map is wrong for your brain.`)
    }

    devices.push({
      name,
      type,
      port,
      bus,
      ...(typeof d.note === 'string' && d.note.trim() ? { note: d.note.trim() } : {}),
    })
  })

  return {
    format: raw.format,
    platform: platformId,
    platformLabel: platform.label,
    robotId: (typeof raw.robotId === 'string' && raw.robotId.trim()) ? raw.robotId.trim() : 'robot',
    declaredBy: raw.declaredBy.trim(),
    note: (typeof raw.note === 'string' && raw.note.trim()) ? raw.note.trim() : '',
    devices,
    warnings,
  }
}

/** The device shape the state layer and change detector already speak. */
export const toStateDevices = (inventory) =>
  inventory.devices.map((d) => ({ name: d.name, type: d.type, port: d.port, bus: d.bus }))
