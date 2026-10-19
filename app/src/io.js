// Durable writes. CORE module, no platform knowledge.
//
// WHY THIS EXISTS. `writeFileSync` truncates the target and then writes. If
// the process dies in between — a laptop lid closing mid-command, a battery
// dying, Ctrl-C at the wrong instant, a full disk — the file is left torn.
//
// For most programs that is an annoyance. Here it was unrecoverable: a torn
// verified state failed JSON.parse before any of Nexum's careful integrity
// messaging ran, so a team saw a raw parser exception, and `state` ALSO
// failed, which meant they could not save a new baseline to recover. The
// project's whole history, bricked by a sleeping laptop.
//
// experiment.js and reported.js already wrote via a temp file and a rename —
// the pattern was known and applied to the two least consequential files,
// while the verified state, the dependency graph, and the check definitions
// were written directly. This makes one helper and uses it everywhere.
//
// rename(2) is atomic within a filesystem on POSIX, and ReplaceFile/MoveFileEx
// gives the same guarantee on Windows. The temp file is created in the SAME
// directory as the target so the rename never crosses a filesystem boundary,
// which is the one condition that would silently turn it back into a copy.

import { writeFileSync, renameSync, unlinkSync } from 'node:fs'

/** Write `data` to `path` so that a reader sees either the complete old file
 *  or the complete new one, never a fragment. */
export function writeAtomic(path, data) {
  // The pid suffix keeps two concurrent processes — five teams on one shared
  // machine, or a CLI and the web UI at once — from clobbering each other's
  // temp file and renaming a half-written one into place.
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (e) {
    // Never leave the scratch file behind to be mistaken for real data.
    try { unlinkSync(tmp) } catch { /* already gone, or never created */ }
    throw e
  }
  return path
}
