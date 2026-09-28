// Untrusted-text boundary — a BOUNDARY module, deliberately tiny (see
// firmware.js for the pattern). Everything Nexum scans off a robot — device
// names, code literals, firmware strings, sensor values — is a stranger's
// bytes, and those bytes get rendered into the operator's TERMINAL, a
// markdown REPORT, the web UI, and (opt-in) an LLM PROMPT. The injection
// hunt (2026-09-27) demonstrated all four channels: ANSI escapes forging a
// green PASS over a FAIL banner, embedded newlines fabricating whole
// engine-formatted lines, markdown structure smuggling remote-image beacons
// into reports, and engine-impersonating instructions steering the AI
// advisory.
//
// The rule: sanitize AT THE PARSE BOUNDARY, once, so every downstream
// renderer receives strings that cannot speak control characters. A name is
// data; data does not get to move the cursor.

// Built via RegExp-from-string so this source file itself contains no raw
// control bytes: C0 (minus tab/CR/LF, handled separately as whitespace),
// DEL, C1, and the Unicode line separators.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029]', 'g')

/** One line of untrusted text: newlines/tabs become spaces (XML
 *  attribute-value normalization does the same), every other C0/C1 control
 *  character — including ESC, the ANSI introducer — and the Unicode line
 *  separators become U+FFFD so tampering stays VISIBLE instead of silently
 *  vanishing. */
export const sanitizeLine = (s) => String(s).replace(/[\r\n\t]/g, ' ').replace(CONTROL, '�')

/** Multi-line untrusted text (e.g. LLM output printed to a terminal): each
 *  line sanitized, real newlines preserved. */
export const sanitizeBlock = (s) => String(s).split('\n').map(sanitizeLine).join('\n')

/** Cap a string with an honest marker — silent truncation reads as "that was
 *  everything" when it wasn't. */
export const clip = (s, n = 400) => {
  const str = String(s)
  return str.length > n ? `${str.slice(0, n)}… [+${str.length - n} more chars]` : str
}
