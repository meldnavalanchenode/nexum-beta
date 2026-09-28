// Rule packs — starting points for a team's dependency graph.
//
// READ THIS BEFORE ADDING ONE. A pack is NOT a set of facts PHYSYNC asserts.
// Every edge in every pack loads with status 'proposed', which the graph layer
// refuses to traverse. Loading a pack changes no verdict, invalidates no
// evidence, and demands no recheck. It puts a list of *candidate* dependencies
// in front of a mentor, each of which does nothing until that mentor approves
// it by name.
//
// The reason packs exist is narrow and practical: a team standing in a pit is
// not going to hand-type fourteen `graph --propose` commands, and a team that
// types none of them gets a tool that reports "no dependency mapping" forever.
// The reason packs are PROPOSED is the whole design: PHYSYNC does not know
// whether a camera move invalidates YOUR localization test. It knows that it
// might, and that a human can answer it.
//
// So an edge belongs in a pack when a reasonable mentor would recognise it as
// a real question about their robot. It does NOT belong here because it sounds
// plausible, and it never belongs in BUILTIN_EDGES (which are traversed without
// asking) unless it is true by construction — a declaration containing its own
// contents, a census recording its own firmware string. Nothing about physics,
// wear, or a particular robot's design is ever true by construction.

export const RULE_PACKS = {
  'vex-v5': {
    label: 'VEX V5 — physical-change starting points',
    note:
      'VEXcode stores device configuration inside the project and compiles it with the program, ' +
      'so a name or port mismatch between config and code is a BUILD error the toolchain already ' +
      'catches. PHYSYNC adds nothing there. What no toolchain catches is the declaration drifting ' +
      'from the physical robot, and the calibrations and tests that quietly depended on the old ' +
      'arrangement. That is what these edges are about.',
    edges: [
      // ── drivetrain geometry
      { from: 'wheel-size', to: 'calibration:drive-distance', note: 'distance driving converts encoder revolutions to inches using the wheel circumference — a different wheel makes every recorded distance wrong' },
      { from: 'wheel-size', to: 'calibration:turn-angle', note: 'if turning is computed from wheel travel rather than an inertial heading, wheel size enters the turn as well' },
      { from: 'track-width', to: 'calibration:turn-angle', note: 'the distance between the drive wheels sets how far they travel for a given rotation' },
      { from: 'gear-ratio', to: 'calibration:drive-distance', note: 'a changed cartridge or external ratio changes motor revolutions per wheel revolution' },
      { from: 'gear-ratio', to: 'calibration:turn-angle', note: 'same rationale as distance' },
      { from: 'drive-motor-reversed', to: 'test:drive-straight', note: 'a reversed motor flag that no longer matches the gearbox turns a straight drive into a spin' },

      // ── inertial sensor
      { from: 'inertial-mount', to: 'calibration:inertial-heading', note: 'the inertial sensor measures rotation about its own axes; re-mounting it in a different orientation reinterprets every heading' },
      { from: 'inertial-mount', to: 'test:turn-accuracy', note: 'a heading-based turn is only as good as the mounting the heading assumed' },

      // ── vision
      { from: 'camera-position', to: 'calibration:vision-signature', note: 'a re-aimed camera sees different lighting and a different object size, and colour signatures are tuned against both' },
      { from: 'camera-position', to: 'test:object-detection', note: 'detection was measured through the old field of view' },

      // ── mechanism
      { from: 'intake-height', to: 'test:intake-pickup', note: 'a raised or lowered intake meets the game object differently' },
      { from: 'belt-tension', to: 'test:intake-pickup', note: 'a re-tensioned belt changes how much torque reaches the rollers' },
      { from: 'arm-hard-stop', to: 'calibration:arm-zero', note: 'arm positions are counted from a zero that the hard stop defines' },
      { from: 'arm-hard-stop', to: 'test:scoring-position', note: 'every taught scoring position is measured from that zero' },

      // ── the things everyone forgets
      { from: 'battery-swap', to: 'test:autonomous-run', note: 'an autonomous routine tuned on a full battery can behave differently on a different one — PROPOSED because how much this matters depends entirely on whether your routine is time-based or sensor-based, and only your team knows that' },
      { from: 'robot-weight', to: 'calibration:drive-distance', note: 'added weight changes how far the robot coasts after the motors stop' },
    ],
  },

  'camera-pose': {
    label: 'Camera pose — a re-aimed mount and what it may have cost',
    note:
      'A re-aimed camera changes no file: the config is byte-identical, the sensor still answers, ' +
      'and every scan comes back clean. What may no longer hold is the pose calibration performed ' +
      'through the old mount angle, and any localization or perception result validated through ' +
      'that calibration. PHYSYNC cannot know whether YOUR localization depends on YOUR camera ' +
      'mount — these edges are the question, proposed and inert until a mentor answers it by name.',
    edges: [
      { from: 'camera-position', to: 'calibration:camera-pose', note: 'a pose calibration maps camera pixels to field positions through the exact mount angle it was performed at — re-aim the mount and the mapping was measured on a camera that no longer exists' },
      { from: 'calibration:camera-pose', to: 'test:localization', note: 'localization was validated through that calibration; when the calibration needs review, the validation that consumed it needs review too' },
      { from: 'fingerprint:camera-pose:$n', to: 'calibration:camera-pose', note: 'a MEASURED camera-pose drift (AprilTag reference, beyond the tolerance a human authored) is the same physical event as a reported re-aim — the calibration performed through the old pose needs review' },
    ],
  },

  'imu-mount': {
    label: 'IMU mounting — a drifted gravity vector and what it may have cost',
    note:
      'The gravity-vector fingerprint measures the IMU\'s orientation with the robot at rest. Drift ' +
      'beyond an authored tolerance means the hub was re-mounted, the chassis bent, or the robot no ' +
      'longer sits flat — PHYSYNC cannot know which, and cannot know whether YOUR heading calibration ' +
      'or localization consumed that orientation. These edges are the question, inert until a mentor ' +
      'answers it by name.',
    edges: [
      { from: 'fingerprint:imu-gravity', to: 'calibration:imu-heading', note: 'heading is integrated in the IMU\'s own frame; a re-oriented IMU reinterprets every heading the calibration established' },
      { from: 'calibration:imu-heading', to: 'test:localization', note: 'localization validated through that heading calibration inherits its doubt' },
    ],
  },
}

/**
 * Expand a pack into storable custom edges. Every one comes back PROPOSED.
 * There is deliberately no option to load a pack pre-approved: a pack that
 * could approve itself would be PHYSYNC asserting engineering dependencies on
 * a robot it has never seen, which is the one thing this design forbids.
 */
export function packEdges(packName) {
  const pack = RULE_PACKS[packName]
  if (!pack) throw new Error(`unknown rule pack "${packName}" — known: ${Object.keys(RULE_PACKS).join(', ')}`)
  return pack.edges.map((e, i) => ({
    id: `${packName}:${String(i + 1).padStart(2, '0')}`,
    from: e.from,
    to: e.to,
    note: e.note,
    status: 'proposed',
    pack: packName,
  }))
}
