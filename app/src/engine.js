// The reconciliation engine — pure, no I/O (the boundary rule carried from
// Margin): models in, findings out. Every finding carries its check id,
// version, severity, evidence (file:line or config line), and a fix.

import { checkMeta } from './registry.js'
import { PORT_RANGES, portSpace } from './configXml.js'

const finding = (id, message, evidence, fix) => {
  const meta = checkMeta(id)
  return { checkId: id, checkVersion: meta.version, severity: meta.severity, message, evidence, fix }
}

/** Damerau-lite edit distance for did-you-mean suggestions. */
export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1)
      }
    }
  }
  return dp[a.length][b.length]
}

const suggest = (name, candidates) => {
  let best = null
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase())
    // Suggestions require the names to be mostly the same — "a"→"b" is not a typo hint.
    if (d > 0 && d <= 2 && Math.max(name.length, c.length) > d + 2 && (best == null || d < best.d)) best = { c, d }
  }
  return best?.c ?? null
}

/** config model (parseConfigXml) + code scan (scanCodeDir) → findings. */
export function reconcile(config, code) {
  const findings = []
  // Webcams are named, lookup-able devices too (QA: duplicate/unused checks skipped them).
  const named = [
    ...config.devices,
    ...config.webcams.map((w) => ({ type: 'Webcam', name: w.name, port: null, space: 'webcam', hub: null, line: w.line })),
  ]
  const configNames = named.map((d) => d.name)
  const configNameSet = new Set(configNames)
  const dynamic = code.dynamic ?? []

  // 1. code-name-missing — the "Unable to find a hardware device" class.
  const seenMissing = new Set()
  for (const ref of code.refs) {
    if (configNameSet.has(ref.name) || seenMissing.has(ref.name)) continue
    seenMissing.add(ref.name)
    const near = suggest(ref.name, configNames)
    findings.push(finding(
      'code-name-missing',
      `Code expects "${ref.name}" — not in the active configuration${near ? ` (did you mean "${near}"?)` : ''}`,
      code.refs.filter((r) => r.name === ref.name).map((r) => `${r.file}:${r.line}`),
      near
        ? `Rename one side so they match — config has "${near}".`
        : `Add "${ref.name}" to the configuration, or remove/rename the code reference.`,
    ))
  }

  // 2. config-name-unused
  const referenced = new Set(code.refs.map((r) => r.name))
  for (const d of named) {
    if (!referenced.has(d.name)) {
      findings.push(finding(
        'config-name-unused',
        `Configured device "${d.name}" (${d.type}${d.hub ? `, ${d.hub} port ${d.port}` : ''}) is never referenced by scanned code`,
        [`config line ${d.line}`],
        dynamic.length
          ? 'Confirm it is intentional — it may be reached by one of the dynamic lookups listed below, or by Blocks.'
          : 'Confirm it is intentional (used by Blocks/dashboard?) or remove the stale entry.',
      ))
    }
  }

  // 3. duplicate-name (devices AND webcams share one namespace)
  const byName = new Map()
  for (const d of named) byName.set(d.name, [...(byName.get(d.name) ?? []), d])
  for (const [name, ds] of byName) {
    if (ds.length > 1) {
      findings.push(finding(
        'duplicate-name',
        `"${name}" is configured ${ds.length} times`,
        ds.map((d) => `config line ${d.line} (${d.type}${d.port != null ? `, port ${d.port}` : ''})`),
        'Rename so every device has a unique name.',
      ))
    }
  }

  // 4. port-range — impossible ports from hand-edited XML.
  for (const d of config.devices) {
    if (d.port == null) {
      findings.push(finding(
        'port-range',
        `"${d.name}" has a non-numeric port${d.portRaw ? ` ("${d.portRaw}")` : ''}`,
        [`config line ${d.line}`],
        'Fix the port attribute — no hub can resolve this.',
      ))
      continue
    }
    if (d.space == null) continue
    const rangeKey = d.space.startsWith('i2c') ? 'i2c' : d.space
    const range = PORT_RANGES[rangeKey]
    if (range && (d.port < range[0] || d.port > range[1])) {
      findings.push(finding(
        'port-range',
        `"${d.name}" declared on ${d.space} port ${d.port} — ${rangeKey} ports are ${range[0]}-${range[1]}`,
        [`config line ${d.line}`],
        'No physical hub can satisfy this; fix the port number.',
      ))
    }
    if (d.bus != null && (d.bus < PORT_RANGES.i2c[0] || d.bus > PORT_RANGES.i2c[1])) {
      findings.push(finding(
        'port-range',
        `"${d.name}" declared on I2C bus ${d.bus} — buses are ${PORT_RANGES.i2c[0]}-${PORT_RANGES.i2c[1]}`,
        [`config line ${d.line}`],
        'No physical hub can satisfy this; fix the bus number.',
      ))
    }
  }

  // 5. unknown-device-type — surfaced, never silently exempted.
  for (const d of config.devices) {
    if (d.space == null) {
      findings.push(finding(
        'unknown-device-type',
        `"${d.name}" (${d.type}) — unrecognized device type, excluded from port-collision checks`,
        [`config line ${d.line}`],
        'Verify its port by hand this once; report the tag so the next PHYSYNC release can classify it.',
      ))
    }
  }

  // 6. port-collision — within one hub (name, not just address — QA: two
  //    same-address hubs merged into one misattributed finding) + port space.
  const bySlot = new Map()
  for (const d of config.devices) {
    if (d.space == null || d.port == null) continue
    const key = `${d.portal}|${d.hub}|${d.space}|${d.port}`
    bySlot.set(key, [...(bySlot.get(key) ?? []), d])
  }
  for (const ds of bySlot.values()) {
    if (ds.length > 1) {
      findings.push(finding(
        'port-collision',
        `${ds.map((d) => `"${d.name}"`).join(' and ')} both declared on ${ds[0].hub} ${ds[0].space} port ${ds[0].port}`,
        ds.map((d) => `config line ${d.line}`),
        'At least one declaration is wrong — check the physical wiring and fix the port numbers.',
      ))
    }
  }

  // 7. i2c-address-conflict — two identical sensor models on one bus.
  const byBusType = new Map()
  for (const d of config.devices) {
    if (!d.space?.startsWith('i2c-bus')) continue
    const key = `${d.portal}|${d.hub}|${d.space}|${d.type}`
    byBusType.set(key, [...(byBusType.get(key) ?? []), d])
  }
  for (const ds of byBusType.values()) {
    if (ds.length > 1) {
      findings.push(finding(
        'i2c-address-conflict',
        `${ds.length}× ${ds[0].type} on ${ds[0].hub} ${ds[0].space} (${ds.map((d) => `"${d.name}"`).join(', ')}) — identical sensors share a fixed I2C address and cannot coexist on one bus`,
        ds.map((d) => `config line ${d.line}`),
        'Move one to a different I2C bus.',
      ))
    }
  }

  // 8. digital-pair-overlap — touch sensors own their whole connector pair.
  const digitals = config.devices.filter((d) => d.space === 'digital')
  for (const t of digitals.filter((d) => /Touch/i.test(d.type))) {
    const partner = t.port % 2 === 0 ? t.port + 1 : t.port - 1
    for (const other of digitals) {
      if (other !== t && other.hub === t.hub && other.port === partner) {
        findings.push(finding(
          'digital-pair-overlap',
          `"${t.name}" (${t.type}, digital ${t.port}) and "${other.name}" (digital ${other.port}) share one physical connector pair (${Math.min(t.port, partner)}-${Math.max(t.port, partner)})`,
          [`config lines ${t.line}, ${other.line}`],
          'A REV Touch Sensor occupies both channels of its pair — move one device to another connector.',
        ))
      }
    }
  }

  // 9. hub-address-conflict + parent-address-mismatch.
  for (const portal of config.portals) {
    const byAddr = new Map()
    for (const h of portal.hubs) byAddr.set(h.address, [...(byAddr.get(h.address) ?? []), h])
    for (const [addr, hs] of byAddr) {
      if (hs.length > 1) {
        findings.push(finding(
          'hub-address-conflict',
          `${hs.length} hubs share module address ${addr} on "${portal.name}"${addr === 2 ? ' — the factory default; two out-of-box Expansion Hubs always conflict' : ''}`,
          hs.map((h) => `config line ${h.line} ("${h.name}")`),
          'Change one hub\'s address in the REV Hardware Client, then update this configuration to match.',
        ))
      }
    }
    if (portal.parentModuleAddress != null && portal.hubs.length > 0 && !byAddr.has(portal.parentModuleAddress)) {
      findings.push(finding(
        'parent-address-mismatch',
        `Portal "${portal.name}" expects its parent hub at address ${portal.parentModuleAddress}, but declared hubs are at ${[...byAddr.keys()].join(', ')}`,
        [`config line ${portal.line}`],
        'A hub was re-addressed without updating the config — fix parentModuleAddress (or the hub address) to match.',
      ))
    }
  }

  // 10. name-hygiene — names differing only by case/whitespace.
  const canon = new Map()
  for (const name of configNameSet) {
    const key = name.toLowerCase().replace(/\s+/g, '')
    canon.set(key, [...(canon.get(key) ?? []), name])
  }
  for (const names of canon.values()) {
    if (names.length > 1) {
      findings.push(finding(
        'name-hygiene',
        `Names differ only by case/whitespace: ${names.map((n) => `"${n}"`).join(', ')}`,
        [],
        'Pick one spelling — near-twins are typo bait across the config/code boundary.',
      ))
    }
  }

  // 10b. Servo command checks. PHYSYNC cannot know a mechanism's PHYSICAL safe
  //      range — that is mechanical reality it can't see. What it can catch is
  //      values that are illegal on their face, arguments that would throw, and
  //      a code/config class contradiction.
  const typeByName = new Map(config.devices.map((d) => [d.name, d.type]))
  const isCR = (t) => /ContinuousRotation|CRServo/i.test(t ?? '')
  const isPositional = (t) => /Servo/i.test(t ?? '') && !isCR(t)
  const seenServo = new Set()
  for (const c of code.servoCalls ?? []) {
    const configuredType = typeByName.get(c.device)
    if (c.method === 'setPosition') {
      for (const [i, v] of c.args.entries()) {
        if (v == null) continue // unresolvable argument — never guessed
        if (v < 0 || v > 1) {
          findings.push(finding(
            'servo-position-out-of-range',
            `"${c.device}" is commanded to position ${v} — servo positions are 0.0 to 1.0`,
            [`${c.file}:${c.line}`],
            'The SDK silently clamps this, so the servo stops somewhere you did not intend and the code reads as if it worked. Fix the constant, or use scaleRange() if you meant to remap the travel.',
          ))
        }
        void i
      }
      // Commanding a positional method on a continuous-rotation servo throws
      // at runtime — the config and the code disagree about what this device is.
      if (isCR(configuredType) && !seenServo.has(`cr:${c.device}`)) {
        seenServo.add(`cr:${c.device}`)
        findings.push(finding(
          'servo-class-mismatch',
          `"${c.device}" is configured as ${configuredType} (continuous rotation) but the code calls setPosition()`,
          [`${c.file}:${c.line}`],
          'A continuous-rotation servo has no positions — it takes setPower(-1..1). Either change the configuration to a plain Servo, or change the code to setPower().',
        ))
      }
    }
    if (c.method === 'scaleRange') {
      const [min, max] = c.args
      if (min != null && max != null && (min < 0 || max > 1 || min >= max)) {
        findings.push(finding(
          'servo-scale-range-invalid',
          `"${c.device}" calls scaleRange(${min}, ${max}) — requires 0.0 ≤ min < max ≤ 1.0`,
          [`${c.file}:${c.line}`],
          'The SDK throws on these arguments, so the OpMode dies at init — before the match, if you are lucky.',
        ))
      }
    }
  }
  // Class contradictions from the binding itself, independent of any command.
  for (const b of code.servoBindings ?? []) {
    const configuredType = typeByName.get(b.device)
    if (!configuredType) continue
    const key = `bind:${b.device}:${b.requestedClass}`
    if (seenServo.has(key)) continue
    seenServo.add(key)
    if (b.requestedClass === 'CRServo' && isPositional(configuredType)) {
      findings.push(finding(
        'servo-class-mismatch',
        `Code requests CRServo for "${b.device}", but the configuration declares ${configuredType}`,
        [b.file],
        'hardwareMap.get(CRServo.class, …) throws on a positional servo entry. Make the configuration and the code agree.',
      ))
    }
    if (b.requestedClass === 'Servo' && isCR(configuredType)) {
      findings.push(finding(
        'servo-class-mismatch',
        `Code requests Servo for "${b.device}", but the configuration declares ${configuredType}`,
        [b.file],
        'hardwareMap.get(Servo.class, …) throws on a continuous-rotation entry. Make the configuration and the code agree.',
      ))
    }
    // Only the servo-vs-CR contradiction was checked, so asking for a servo
    // class on a MOTOR — or on an LED driver that merely occupies a servo port
    // — sailed through, even though it throws at init exactly like the pair
    // above. Restricted to recognized device types: an unknown custom driver
    // may legitimately extend Servo, and guessing there would false-FAIL.
    const wantsServo = b.requestedClass === 'Servo' || b.requestedClass === 'CRServo'
    if (wantsServo && !isPositional(configuredType) && !isCR(configuredType) && portSpace(configuredType, {}) != null) {
      findings.push(finding(
        'servo-class-mismatch',
        `Code requests ${b.requestedClass} for "${b.device}", but the configuration declares ${configuredType} — that is not a servo`,
        [b.file],
        `hardwareMap.get(${b.requestedClass}.class, "${b.device}") throws at init because the configured device cannot be cast to it. Either the name is wrong, or the configuration entry is.`,
      ))
    }
  }

  // 11. dynamic-name — what static analysis cannot verify, said out loud.
  for (const d of dynamic) {
    findings.push(finding('dynamic-name', `Runtime-built device name: ${d.expr}`, [`${d.file}:${d.line}`], 'Verify this lookup on the robot — PHYSYNC cannot check it statically.'))
  }

  // 11b. blocks-name-unknown — stale Blocks identifiers (WARN by design; the
  // identifier convention is real-file-verified but not SDK-source-verified, so Blocks
  // evidence never blocks a match).
  for (const b of code.blocksUnknown ?? []) {
    if (b.kind === 'type-mismatch') {
      findings.push(finding(
        'blocks-name-unknown',
        `Blocks identifier "${b.identifier}" implies a ${b.identifier.match(/As(\w+)$/)?.[1] ?? 'different type'}, but "${b.base}" is configured on the ${b.configured} side`,
        [b.file],
        'The device type likely changed after this OpMode was written — re-pick the device from the dropdown in the Blocks editor.',
      ))
    } else {
      findings.push(finding(
        'blocks-name-unknown',
        `Blocks identifier "${b.identifier}" suggests a device named "${b.base}" — not in the active configuration`,
        [b.file],
        'Open the OpMode in the Blocks editor: stale identifiers usually mean the config changed after this program was written.',
      ))
    }
  }

  // 12. unparsed — surfaced, never dropped.
  for (const u of config.unparsed) {
    findings.push(finding('unparsed', `Could not confidently parse: ${u.text}`, [`config line ${u.line}`], 'Review by hand.'))
  }

  return findings
}

/** Snapshot drift: previous toSnapshot() vs current → findings with
 *  swap-recovery guidance (the alternative to the SCAN wipe). */
export function diffSnapshot(prev, cur) {
  const findings = []
  const drift = (message, fix) => findings.push(finding('drift', message, [], fix))

  const prevPortals = new Map(prev.portals.map((p) => [p.name, p]))
  for (const p of cur.portals) {
    const old = prevPortals.get(p.name)
    if (!old) { drift(`New hub portal "${p.name}"`, 'Expected after adding hardware; snapshot again once verified.'); continue }
    if (old.serialNumber !== p.serialNumber) {
      drift(
        `Hub portal "${p.name}" serial changed (${old.serialNumber} → ${p.serialNumber}) — a hub was swapped`,
        'Swap recovery: update this portal in the existing config instead of SCANning (SCAN wipes everything). Verify addresses below, then re-snapshot.',
      )
    }
    const oldAddrs = new Set(old.hubs.map((h) => h.address))
    for (const h of p.hubs) {
      if (!oldAddrs.has(h.address)) drift(`Hub "${h.name}" now at address ${h.address} (not in last PASS)`, 'Confirm the address change was intentional; official docs warn old configs will not find a re-addressed hub.')
    }
  }

  // Devices are grouped BY NAME with a canonical serialization per group, so
  // a config is always a fixed point of its own snapshot — even a degenerate
  // config with duplicate device names (fuzz-caught: name-keyed Map lookups
  // made self-diff report phantom "moved" drift under duplicates).
  const group = (list) => {
    const m = new Map()
    for (const d of list) {
      if (!m.has(d.name)) m.set(d.name, [])
      m.get(d.name).push(d)
    }
    for (const a of m.values()) a.sort((x, y) => JSON.stringify([x.hub, x.port, x.bus, x.type]).localeCompare(JSON.stringify([y.hub, y.port, y.bus, y.type])))
    return m
  }
  const canon = (ds) => JSON.stringify(ds.map((d) => [d.hub, d.port, d.bus, d.type]))
  const prevG = group(prev.devices)
  const curG = group(cur.devices)
  for (const [name, curDs] of curG) {
    const oldDs = prevG.get(name)
    if (!oldDs) {
      drift(`Device added since last PASS: "${name}" (${curDs[0].type}, port ${curDs[0].port})`, 'Expected after new hardware; re-snapshot once verified.')
      continue
    }
    if (canon(oldDs) === canon(curDs)) continue
    if (oldDs.length === 1 && curDs.length === 1) {
      const [old, d] = [oldDs[0], curDs[0]]
      if (old.port !== d.port || old.bus !== d.bus || old.hub !== d.hub) {
        drift(
          `"${d.name}" moved: ${old.hub} port ${old.port}${old.bus != null ? ` bus ${old.bus}` : ''} → ${d.hub} port ${d.port}${d.bus != null ? ` bus ${d.bus}` : ''}`,
          'If this was a rewire around a bad port, make sure EVERY OpMode/program was updated, then re-snapshot.',
        )
      }
      if (old.type !== d.type) {
        drift(
          `"${d.name}" changed type: ${old.type} → ${d.type}`,
          'A motor/sensor model swap changes encoder ticks and behavior constants — update the code side, then re-snapshot.',
        )
      }
      continue
    }
    drift(`"${name}" is configured ${curDs.length}× and its entries changed since last PASS`, 'Duplicate-named devices changed — fix the duplicate names first, then re-snapshot.')
  }
  for (const name of prevG.keys()) {
    if (!curG.has(name)) drift(`Device removed since last PASS: "${name}"`, 'If unintentional, a hub swap or SCAN may have eaten it — restore from the snapshot values.')
  }
  return findings
}

export const verdict = (findings) => (findings.some((f) => f.severity === 'FAIL') ? 'FAIL' : 'PASS')
