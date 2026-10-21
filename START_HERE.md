# START HERE — Nexum beta

Hi Faraday. This is the whole thing, start to finish. **Six commands total.**
If anything here doesn't work, that's a bug in Nexum and I want to hear about
it — ashrith.kora@gmail.com.

---

## What Nexum does

When your robot changes — you swap a motor, move a port, re-flash a hub,
re-aim a camera, refactor code — **some of your previous testing stops
counting.** Usually nobody tracks which. Nexum does.

It tells you two things:

1. **Which of your earlier test results no longer apply** to the robot you
   have right now
2. **The minimum set of checks you must redo** before you should trust it again

It does *not* tell you your robot is "safe" or "works." The strongest thing it
will ever say is **VERIFIED FOR DEFINED CHECKS**. Anything unmeasured stays
**UNKNOWN** — it never quietly becomes a pass.

**It never touches your robot.** It reads two things off your laptop: your
config XML and your TeamCode folder. Nothing is uploaded, there's no account,
and no network is used.

---

## What this beta asks of you

One setup (~10 min), then **two robot changes.** Each change costs about four
minutes: write down what *you* would re-check, run Nexum, do the checks, tell
Nexum what happened. Then we're done and I leave you alone.

**"It was useless" is the most valuable answer you can give me.** I'm testing
whether this helps a real team, not collecting compliments. If Nexum tells you
to re-check things you know don't matter, that's the finding.

---

## Before you start: this beta runs for 30 days

From the first time you run `init`, Nexum works for **30 days**. After that
every command stops and asks you to email me. Every command you run prints how
many days are left, from day one, so it should never surprise you. (The one
exception: `--json` runs stay silent, so the notice can't break a script.)

**Your records are never held hostage.** Everything Nexum writes lives in a
`.physync/` folder in your project as plain JSON — verified states, results,
rules, the lot. You can open any of it in a text editor, before or after the
window, forever. The deadline stops Nexum from running; it does not touch your
data.

The clock is kept in two plain-text files: `.physync/trial.json` in your
project, and `~/.nexum/trial.json` in your home folder. **That second file is
the only thing Nexum ever writes outside your project** — it holds one
timestamp and nothing else, no machine name, no user name, no project path. It
lives there so the window is one 30-day run per download rather than one per
folder: deleting `.physync/` or unzipping a fresh copy won't restart it. You
can read it, and if you delete it the project copy still governs.

If you hit the end and still want it, email **ashrith.kora@gmail.com** and say
you're a beta team. I'll extend it.

## 1 · Get it running (60 seconds)

You need [Node.js](https://nodejs.org) **20 or newer**. Check with:

```bash
node --version
```

If that prints 20 or higher, you're set. Now download Nexum —
**[nexum-beta.zip](https://github.com/meldnavalanchenode/nexum-beta/archive/refs/heads/main.zip)**
(308 KB) — and unzip it. No git, no install, no account. Then open a terminal
in that folder and run:

```bash
node app/bin/physync.js demo
```

That runs a preflight on a **deliberately broken sample robot** that ships
inside Nexum. You should see:

```
  ██ NEXUM PREFLIGHT: FAIL ██
  ✗ FAIL  Code expects "wrsit" — not in the active configuration (did you mean "wrist"?)
  ✗ FAIL  Code expects "hang_motor" — not in the active configuration
```

**That FAIL is correct.** The sample robot is broken on purpose. Seeing those
two lines means Nexum works on your machine.

## 2 · Set up for your robot (one time, ~5 min)

Open a terminal in a folder that has:

- your **config XML** — copy it off the Robot Controller phone/hub, it's in
  `/sdcard/FIRST/` and ends in `.xml`
- your **TeamCode folder**

Then:

```bash
node app/bin/physync.js init --config yourconfig.xml --code YourTeamCode --by yourName
```

This defines three starter checks and loads some candidate dependency rules —
then **stops and asks you one question it refuses to answer for you.**

A dependency rule says *"if X changes, re-check Y."* Nexum has no idea whether
that's true of *your* robot. So every rule sits inert until someone on your
team approves it by name. It prints the exact commands; approve the ones you
agree with:

```bash
node app/bin/physync.js graph --approve camera-pose:01 --by yourName
```

Rules you don't approve stay proposed, and Nexum will say **UNKNOWN** instead
of guessing. That's deliberate — I'd rather it admit ignorance than invent a
dependency your robot doesn't have.

**Optional but makes the beta much better:** record test results you already
trust, so your baseline has real evidence in it.

```bash
node app/bin/physync.js result --test localization --pass --by yourName
```

## 3 · Freeze today's robot as V1

**Do this while the robot works.** This is your baseline.

```bash
node app/bin/physync.js state --config yourconfig.xml --code YourTeamCode
```

You'll see `Verified state V1 saved`. That record is permanent, hash-protected,
and never edited — later runs create V2, V3, and so on. V1 stays byte-for-byte
what it was.

## 4 · Next time the robot really changes

**Before you run Nexum — write your own answer down first.** This order is the
entire experiment; if you look at Nexum's answer first, that change's data is
gone and can't be recovered.

```bash
node app/bin/physync.js predict --checks "drive-straight, localization" --by yourName
```

Now make your change. If it's something no file can see — re-aimed camera,
swapped wheels, re-tensioned a belt — tell Nexum, with your name on it:

```bash
node app/bin/physync.js change --component camera-position --note "re-aimed the mount" --by yourName
```

Then ask it:

```bash
node app/bin/physync.js status
```

No flags — it remembers your paths. You get what changed, which previous
evidence it put in question, and the minimum re-checks owed, each with a reason:

```
  1 change(s) · 1 evidence item(s) put in question · 2 recheck(s) owed
    ! REVALIDATE  test:localization (PASS @V1) — yourName reported a physical
      change to camera-position ("re-aimed") [PHYSICAL_CHANGE_REPORTED]
```

## 5 · Do the checks, record what happened

```bash
node app/bin/physync.js result --test localization --pass --by yourName
node app/bin/physync.js debrief --checked "localization, camera-pose" --by yourName
```

Use `--pass`, `--fail`, or `--unknown` — your judgment, recorded under your
name. `debrief` prints the comparison: what you both named, what Nexum added,
what you did that it never mentioned. **It does not grade itself.** Whether it
helped is your call, not its.

**Logging a number instead of pass/fail?** A number alone stays UNKNOWN,
because nobody has said what bar it has to clear. Set the bar once and the
numbers start being judged:

```bash
node app/bin/physync.js tests --threshold --id localization --min 0.9 --by yourName
```

Results you already recorded keep the verdict they were given — moving a bar
never re-grades your history.

## 6 · Save the new state as V2

```bash
node app/bin/physync.js state --config yourconfig.xml --code YourTeamCode
```

Done. That's one full loop. One more and the beta is complete.

---

## What the symbols mean

Your historical results **never change** — a PASS from last week is a PASS
forever, recorded against the robot it belonged to. What changes is whether it
still *applies*:

| | meaning |
|---|---|
| ✓ **APPLICABLE** | no known dependency connects it to anything that changed |
| ! **REVALIDATE** | a change reached it through a rule you approved |
| ? **UNKNOWN** | a *proposed* rule links it, but nobody has ruled on it |
| ↻ **RE-DERIVED** | this run's inputs re-established it |

---

## Troubleshooting

**`node` isn't recognized / the command does nothing.**
Run `node --version`. If it errors, Node isn't installed — get it from
[nodejs.org](https://nodejs.org) and reopen your terminal afterwards (the
terminal only picks up new installs on restart). If it prints a number below
20, update it; Nexum needs 20 or newer and says so rather than misbehaving.

**"Cannot find module" or "no such file".**
You're almost certainly in the wrong folder. Every command here starts with
`node app/bin/physync.js`, which only works from the **unzipped Nexum folder**
— the one that contains `app/`. Run `ls` (or `dir` on Windows); if you don't
see `app`, `cd` into the right place. Your robot files can live wherever you
like; just pass their paths to `--config` and `--code`.

**The download or unzip fails.**
Grab it again here:
[nexum-beta.zip](https://github.com/meldnavalanchenode/nexum-beta/archive/refs/heads/main.zip).
It's 308 KB and needs no network after that — everything runs offline. If your
school network blocks GitHub, tell me and I'll email you the folder directly.

**I can't find my config XML.**
It's on the Robot Controller device at `/sdcard/FIRST/`, named after whatever
you called your configuration. If you can't pull files off the hub, send me the
config name and I'll tell you where to look for your setup. You can also just
send me the XML and your TeamCode and **I'll do the whole setup and send the
folder back ready to go** — then you'd only run `status`.

**The robot is offline / not connected.**
Doesn't matter. Nexum never talks to your robot. It only reads the two files on
your laptop. You can run every command in this document with the robot
unplugged, powered off, or in a different building.

**It says UNKNOWN / "no dependency mapping."**
Working as designed. It means no rule you approved connects your change to that
check, so Nexum won't claim either way. Either approve a rule that reflects how
your robot actually works (`graph --approve`), or leave it UNKNOWN — which is an
honest answer, and often the right one.

**Nexum crashed.**
Send me the command you ran and everything it printed. **That's a finding, not
your fault**, and it's exactly what I need. Nothing is damaged — Nexum writes
inside the `.physync/` folder, plus the one timestamp file at
`~/.nexum/trial.json` described above. Nothing else on your machine.

**My robot state is incomplete — I don't have all the test results.**
Fine, and expected. Nexum reports what's missing as UNKNOWN rather than
pretending. You don't need full coverage for this beta; you need one real change
run honestly.

**I want to start over.**
Delete the `.physync/` folder. Your config and code are never modified. The only
thing left behind is `~/.nexum/trial.json`, which keeps the beta clock honest —
starting over gives you a clean slate, not a new 30 days.

---

## Privacy — what leaves your machine

**Nothing.** The whole loop is offline: no account, no telemetry, no upload.
Everything Nexum records lives in a `.physync/` folder in your project. The one
file outside it, `~/.nexum/trial.json`, is a single timestamp for the beta
clock — nothing is sent anywhere, because there is nowhere for it to be sent.

If you choose to send me anything, send the `.physync` folder — it holds states,
results, and rules, **not your source code**. Open it first if you want; it's
plain JSON and you can read every byte.

*(There's one optional command, `explain`, that calls an AI API. It only runs if
you set your own API key, it can never change a verdict, and you shouldn't use
it for this beta.)*

## Known limitations — so nothing surprises you

- **Nexum has never run on a real Control Hub.** It reads files you give it.
- Java and Blocks TeamCode; the Blocks support is less tested than Java.
- Out of the box it knows very little about your robot, on purpose — the rules
  are yours to approve.
- VEX support exists in the code but is not part of this beta.

Anything broken, confusing, or useless: **ashrith.kora@gmail.com.** I would
rather hear that it wasted your time than not hear it.
