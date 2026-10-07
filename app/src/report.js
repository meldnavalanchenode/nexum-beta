// Reporting — the terminal PASS/FAIL card and the markdown report. Pure
// formatting; all judgment lives in the engine.

import { ENGINE_VERSION } from './registry.js'
import { verdict } from './engine.js'

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', reset: '' }

const badge = { FAIL: `${C.red}✗ FAIL${C.reset}`, WARN: `${C.yellow}⚠ WARN${C.reset}`, INFO: `${C.dim}ℹ INFO${C.reset}` }

export function renderTerminal(findings, context) {
  const lines = []
  const v = context.mode === 'gate'
    ? (verdict(findings) === 'FAIL' ? 'GATE FAIL' : 'GATE PASS')
    : context.mode === 'diff'
    ? (findings.length ? 'DRIFT' : 'NO DRIFT')
    : context.mode === 'sensors'
      ? (verdict(findings) === 'FAIL' ? 'SENSORS FAIL'
        : findings.some((f) => f.checkId === 'sensor-nothing-verified') ? 'SENSORS NONE' : 'SENSORS PASS')
      : context.mode === 'stimulus'
      ? (verdict(findings) === 'FAIL' ? 'STIMULUS FAIL' : 'STIMULUS PASS')
      : verdict(findings)
  lines.push('')
  const banner = {
    PASS: `${C.green}${C.bold}  ██ NEXUM PREFLIGHT: PASS ██${C.reset}`,
    FAIL: `${C.red}${C.bold}  ██ NEXUM PREFLIGHT: FAIL ██${C.reset}`,
    DRIFT: `${C.yellow}${C.bold}  ██ NEXUM: CONFIG DRIFTED SINCE LAST PASS ██${C.reset}`,
    'NO DRIFT': `${C.green}${C.bold}  ██ NEXUM: NO DRIFT SINCE LAST PASS ██${C.reset}`,
    'SENSORS PASS': `${C.green}${C.bold}  ██ NEXUM SENSORS: ALL ANSWERING ██${C.reset}`,
    'SENSORS NONE': `${C.yellow}${C.bold}  ██ NEXUM SENSORS: NOTHING VERIFIABLE HERE ██${C.reset}`,
    'SENSORS FAIL': `${C.red}${C.bold}  ██ NEXUM SENSORS: A SENSOR IS NOT ANSWERING ██${C.reset}`,
    'STIMULUS PASS': `${C.green}${C.bold}  ██ NEXUM STIMULUS: PASS ██${C.reset}`,
    'STIMULUS FAIL': `${C.red}${C.bold}  ██ NEXUM STIMULUS: FAIL — do not queue this robot ██${C.reset}`,
    'GATE PASS': `${C.green}${C.bold}  ██ NEXUM GATE: STILL THE ROBOT YOU APPROVED ██${C.reset}`,
    'GATE FAIL': `${C.red}${C.bold}  ██ NEXUM GATE: NOT THE ROBOT YOU APPROVED ██${C.reset}`,
  }
  lines.push(banner[v])
  if (context.mode === 'gate') {
    lines.push(`${C.dim}  approved ${context.approvedAt}${context.hubsVerified ? '' : ' · declaration layer only (no robot report at approval)'} · engine v${ENGINE_VERSION}${C.reset}`)
  } else if (context.mode === 'sensors') {
    lines.push(`${C.dim}  ${context.deviceCount} sensor(s) read · engine v${ENGINE_VERSION}${C.reset}`)
  } else if (context.mode === 'stimulus') {
    lines.push(`${C.dim}  ${context.deviceCount} device(s) exercised · engine v${ENGINE_VERSION}${C.reset}`)
  } else {
    const webcams = context.webcamCount ? ` + ${context.webcamCount} webcam(s)` : ''
    const blks = context.blkCount ? ` + ${context.blkCount} Blocks file(s)` : ''
    lines.push(`${C.dim}  ${context.deviceCount} configured devices${webcams} · ${context.refCount} code references across ${context.filesScanned} files${blks} · engine v${ENGINE_VERSION}${C.reset}`)
  }
  lines.push('')
  const order = { FAIL: 0, WARN: 1, INFO: 2 }
  for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    lines.push(`  ${badge[f.severity]}  ${f.message}`)
    for (const e of f.evidence) lines.push(`${C.dim}          ${e}${C.reset}`)
    lines.push(`${C.dim}          fix: ${f.fix}${C.reset}`)
  }
  // The clean-run line must state only what was actually established. Earlier
  // versions claimed a baseline comparison that had not happened, and printed
  // the `check` command's sentence in sensors and diff modes.
  if (findings.length === 0) {
    const clean = {
      stimulus: context.comparedToBaseline
        ? 'Every device exercised responded, and nothing moved differently than the verified baseline.'
        : 'Every device exercised responded. No baseline on record, so nothing was compared — record one with --baseline.',
      sensors: context.comparedToBaseline
        ? 'Every sensor whose liveness can be determined answered, and none changed since the verified baseline.'
        : 'Every sensor whose liveness can be determined answered. No baseline on record, so nothing was compared.',
      diff: 'Nothing changed since the recorded snapshot.',
      gate: context.hubsVerified
        ? 'Configuration and hub census both match the approved state, as of the robot report you supplied.'
        : 'Configuration matches the approved state. Hubs were not part of this approval, so nothing physical was compared.',
    }[context.mode] ?? 'Every code reference resolves; no collisions, no conflicts. Go drive.'
    lines.push(`  ${C.green}${clean}${C.reset}`)
  }
  lines.push('')
  return lines.join('\n')
}

// Device names come from statement-of-the-world inputs (config XML, code) —
// markdown renderers pass raw HTML through, so everything user-sourced is
// escaped before it reaches the report. Markdown STRUCTURE is escaped too:
// the injection hunt proved a device name can otherwise smuggle a forged
// "# PASS" heading, a javascript: link, or a remote-image beacon into the
// downloaded report.
const safe = (s) => String(s).replace(/[&<>|[\]`*_#!]/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '\\|', '[': '\\[', ']': '\\]', '`': '\\`', '*': '\\*', '_': '\\_', '#': '\\#', '!': '\\!' }[ch]
))

export function renderMarkdown(findings, context) {
  const v = verdict(findings)
  const out = []
  out.push(`# NEXUM preflight — ${v}`)
  out.push(`${context.deviceCount} configured devices · ${context.refCount} code references across ${context.filesScanned} files · engine v${ENGINE_VERSION}`)
  out.push('')
  if (findings.length === 0) out.push('Every code reference resolves; no collisions, no conflicts.')
  for (const sev of ['FAIL', 'WARN', 'INFO']) {
    const group = findings.filter((f) => f.severity === sev)
    if (!group.length) continue
    out.push(`## ${sev}`)
    for (const f of group) {
      out.push(`- **${safe(f.message)}** _(${f.checkId} v${f.checkVersion})_`)
      for (const e of f.evidence) out.push(`  - ${safe(e)}`)
      out.push(`  - fix: ${safe(f.fix)}`)
    }
    out.push('')
  }
  out.push(`_NEXUM — the robot you built is the robot your software thinks you built._`)
  return out.join('\n')
}
