// Capture plans: a sequence of "passes" per type of space. Each pass says what to do, at what
// height, and which view directions it is meant to fill (used for progress and guidance).
//
// height: 'chest' (1.1–1.6 m), 'high' (overhead, >1.75 m), 'low' (waist/knee, <1.0 m) or null.
// bands: direction bands from coverage.js this pass should fill.
// loop: true when the pass is a lap around the space (AR mode measures progress around the room).

export const TEMPLATES = [
  {
    id: 'room',
    name: 'Room',
    icon: '▢',
    desc: 'Classroom, office, lab, lounge: an enclosed space up to about 12 m across.',
    voxel: 0.2,
    maxObsDist: 7,
    viewDist: 1.6,
    framesPerM2: 6,
    minFrames: 150,
    boundsHint: 'Aim the centre cross at the floor in each corner of the room and tap Corner.',
    passes: [
      {
        id: 'mid', name: 'Eye-level lap', height: 'chest', loop: true, bands: ['mid'], guide: { kind: 'loop', inset: 1.0, pitch: -8, yaw: 15 },
        short: 'Follow the path around the room, about 1 m from the walls, aiming across the room.',
        steps: [
          'Follow the dotted path about 1 m from the walls, phone at chest height, aimed across the room.',
          'Keep the blue ring near the centre of the screen and sidestep slowly to your right.',
          'Keep the far wall and the floor–wall line in frame.',
          'Finish a little past where you started so the loop closes.',
        ],
      },
      {
        id: 'high', name: 'Overhead lap', height: 'high', loop: true, bands: ['low'], guide: { kind: 'loop', inset: 0.9, pitch: -35, yaw: 15 },
        short: 'Same lap with the phone above your head, tilted down about 30°.',
        steps: [
          'Raise the phone above your head and tilt it down so you see the floor and the lower walls.',
          'Follow the same loop. This captures tabletops, floor and furniture from above.',
        ],
      },
      {
        id: 'low', name: 'Low lap', height: 'low', loop: true, bands: ['high'], guide: { kind: 'loop', inset: 0.9, pitch: 28, yaw: 15 },
        short: 'Lap at waist height, tilted up about 30°.',
        steps: [
          'Hold the phone at waist or knee height, tilted up toward the ceiling–wall line.',
          'Walk the loop again. This fills in the ceiling, light fixtures and the undersides of tables.',
        ],
      },
      {
        id: 'cross', name: 'Cross the room', height: 'chest', loop: false, bands: ['mid', 'low'], guide: { kind: 'lanes', inset: 1.2, spacing: 1.8, pitch: -15 },
        short: 'Zig-zag through the middle, aiming at the walls and furniture.',
        steps: [
          'Follow the zig-zag lanes through the middle of the room, aimed to the side.',
          'Walk around big furniture where the path is blocked; blocked spots are skipped automatically.',
        ],
      },
      {
        id: 'detail', name: 'Fill the gaps', height: null, loop: false, bands: ['ceil', 'floor', 'high', 'low'], guide: { kind: 'gaps' },
        short: 'The app picks the spots that still need angles: stand on each marker and aim at the ring.',
        steps: [
          'Walk to the ring on the floor, then aim at the red area inside the blue ring. Each one takes a few seconds.',
          'Can\'t get there? Tap "Skip this spot" in this sheet, or mark it with the Skip tool so it no longer counts.',
          'Look straight up at the ceiling and straight down at the floor while moving slowly.',
          'For each doorway, walk through slowly in both directions so rooms can be joined later.',
        ],
      },
    ],
  },
  {
    id: 'hallway',
    name: 'Hallway',
    icon: '═',
    desc: 'Corridors and walkways: long, narrow, often with plain walls.',
    voxel: 0.2,
    maxObsDist: 7,
    viewDist: 1.4,
    framesPerM2: 7,
    minFrames: 120,
    boundsHint: 'Tap the floor at the 4 corners of the stretch you want, e.g. just half the hallway.',
    passes: [
      {
        id: 'crab', name: 'Crab walk, both walls', height: 'chest', loop: true, bands: ['mid'], guide: { kind: 'loop', inset: 0.6, pitch: -5, yaw: 30 },
        short: 'Sidestep along each wall, aimed at the opposite wall and a little ahead.',
        steps: [
          'Follow the path: down one wall and back along the other.',
          'Face the opposite wall, angled about 30° down the hall, and sidestep. Never aim straight down a long hall without moving.',
        ],
      },
      {
        id: 'center-high', name: 'Centre, phone high', height: 'high', loop: true, bands: ['low'], guide: { kind: 'loop', inset: 'center', pitch: -35, yaw: 20 },
        short: 'Down the middle and back with the phone overhead, tilted down.',
        steps: ['Raise the phone above your head, tilt it down at the floor and lower walls, and follow the path.'],
      },
      {
        id: 'center-low', name: 'Centre, phone low', height: 'low', loop: true, bands: ['high'], guide: { kind: 'loop', inset: 'center', pitch: 28, yaw: 20 },
        short: 'Down the middle and back at waist height, tilted up.',
        steps: ['Hold the phone at waist height, tilted up at the ceiling and upper walls, and follow the path.'],
      },
      {
        id: 'detail', name: 'Doors, ends & features', height: null, loop: false, bands: ['ceil', 'floor', 'high', 'low'], guide: { kind: 'gaps' },
        short: 'Fill the remaining gaps: doorways, end walls, signage, display cases.',
        steps: [
          'Capture each end wall from a few steps away, moving side to side.',
          'Step into each doorway and out again so connected rooms can be linked.',
        ],
      },
    ],
  },
  {
    id: 'hall',
    name: 'Large hall',
    icon: '▦',
    desc: 'Lecture hall, atrium, lobby, gym, library floor: bigger than about 12 m.',
    voxel: 0.35,
    maxObsDist: 12,
    viewDist: 2.5,
    framesPerM2: 3,
    minFrames: 300,
    boundsHint: 'Tap the floor at the corners of the space (or of the part you want to capture).',
    passes: [
      {
        id: 'perimeter', name: 'Perimeter lap', height: 'chest', loop: true, bands: ['mid'], guide: { kind: 'loop', inset: 1.5, pitch: -5, yaw: 20 },
        short: 'Lap around the edge, aimed into the space.',
        steps: [
          'Walk the outside edge slowly, aimed across the hall.',
          'In very large rooms, aim diagonally to keep nearby features in frame.',
        ],
      },
      {
        id: 'lanes', name: 'Lanes', height: 'chest', loop: false, bands: ['mid', 'low'], guide: { kind: 'lanes', inset: 2, spacing: 3, pitch: -10 },
        short: 'Walk parallel lanes about 3 m apart (lawnmower pattern).',
        steps: [
          'Cross the hall in straight lanes about 3 m apart, aimed to one side.',
          'Come back down the next lane, aimed to the other side.',
          'In tiered seating, walk each aisle and a few rows sideways.',
        ],
      },
      {
        id: 'up', name: 'Ceiling & upper walls', height: 'low', loop: true, bands: ['high', 'ceil'], guide: { kind: 'loop', inset: 1.5, pitch: 35, yaw: 15 },
        short: 'Lap again, tilted up at balconies, ceiling and upper walls.',
        steps: ['Tilt up about 40° and walk another lap. Move slower: things far away blur more.'],
      },
      {
        id: 'detail', name: 'Features up close', height: null, loop: false, bands: ['low', 'floor', 'mid'], guide: { kind: 'gaps' },
        short: 'Get within about 2 m of important features and orbit them.',
        steps: [
          'Far surfaces get few pixels. Walk up to stages, podiums, plaques and art, then orbit them.',
          'Keep following the red areas on the map.',
        ],
      },
    ],
  },
  {
    id: 'stairs',
    name: 'Stairwell',
    icon: '◢',
    desc: 'Stairs, landings and vertical spaces.',
    voxel: 0.2,
    maxObsDist: 6,
    viewDist: 1.3,
    framesPerM2: 10,
    minFrames: 150,
    boundsHint: 'Stairwells span several floors, so you can skip this step.',
    passes: [
      {
        id: 'up', name: 'Walk up', height: 'chest', loop: false, bands: ['mid', 'high'],
        short: 'Climb slowly, aimed ahead and slightly up, with side-to-side sweeps.',
        steps: [
          'One step at a time. Pause briefly on each step.',
          'At each landing, do a slow half-turn while stepping sideways, not spinning in place.',
        ],
      },
      {
        id: 'down', name: 'Walk down', height: 'chest', loop: false, bands: ['mid', 'low'],
        short: 'Come back down aimed ahead and slightly down.',
        steps: ['Aim at the steps below and the railings. Hold on to the rail; safety first.'],
      },
      {
        id: 'well', name: 'Look up & down the well', height: null, loop: false, bands: ['ceil', 'floor'],
        short: 'From each landing, look up and down the stairwell.',
        steps: ['On each landing, shift your position slightly between shots up and down the well.'],
      },
    ],
  },
  {
    id: 'object',
    name: 'Feature / object',
    icon: '◎',
    desc: 'Statue, display case, fireplace, architectural detail: something you can walk around.',
    voxel: 0.1,
    maxObsDist: 3,
    viewDist: 1.0,
    boundsMargin: 0.5,
    framesPerM2: 0,
    minFrames: 90,
    boundsHint: 'Tap the floor at 3–4 points around the base of the object.',
    passes: [
      {
        id: 'ring-mid', name: 'Orbit — eye level', height: 'chest', loop: true, bands: ['mid'], guide: { kind: 'orbit', radius: 1.2, pitch: -10 },
        short: 'Circle the object at about 1–1.5 m, always aimed at it.',
        steps: ['Keep the object centred and a constant distance away. About one photo per 10°.'],
      },
      {
        id: 'ring-high', name: 'Orbit — from above', height: 'high', loop: true, bands: ['low'], guide: { kind: 'orbit', radius: 1.0, pitch: -40 },
        short: 'Circle again from above, tilted down.',
        steps: ['Raise the phone and look down at the top of the object while circling.'],
      },
      {
        id: 'ring-low', name: 'Orbit — from below', height: 'low', loop: true, bands: ['high'], guide: { kind: 'orbit', radius: 1.0, pitch: 22 },
        short: 'Circle again from low, tilted up.',
        steps: ['Crouch and look up at the underside and the base while circling.'],
      },
      {
        id: 'context', name: 'Context ring', height: 'chest', loop: true, bands: ['mid', 'low'], guide: { kind: 'orbit', radius: 2.2, pitch: -15 },
        short: 'One wider circle (2–3 m) so the object sits in its surroundings.',
        steps: ['Step back and circle once more, including the floor and nearby walls.'],
      },
    ],
  },
  {
    id: 'free',
    name: 'Freestyle',
    icon: '✦',
    desc: 'No plan. Just follow the coverage map and the live tips.',
    voxel: 0.2,
    maxObsDist: 7,
    viewDist: 1.6,
    framesPerM2: 6,
    minFrames: 100,
    boundsHint: 'Tap the floor at the corners of the area you want to capture, or skip.',
    passes: [
      {
        id: 'free', name: 'Free capture', height: null, loop: false, bands: ['floor', 'low', 'mid', 'high', 'ceil'], guide: { kind: 'gaps' },
        short: 'Cover everything. Follow the markers to the spots that still need angles.',
        steps: ['Move slowly, keep about 1 m from surfaces, and step sideways often.'],
      },
    ],
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
}

export const HEIGHTS = {
  chest: { min: 1.05, max: 1.65, label: 'chest height' },
  high: { min: 1.75, max: 3.0, label: 'above your head' },
  low: { min: 0.2, max: 1.0, label: 'waist height or lower' },
};

/** A hint when the phone is clearly not at the pass's intended height (AR mode only). */
export function heightHint(pass, heightM) {
  if (!pass || !pass.height || heightM == null) return null;
  const h = HEIGHTS[pass.height];
  if (heightM < h.min - 0.1) {
    return {
      title: pass.height === 'high' ? 'Raise the phone above your head' : 'Raise the phone a bit',
      detail: `This pass is at ${h.label}. You're at about ${heightM.toFixed(1)} m.`,
    };
  }
  if (heightM > h.max + 0.1) {
    return {
      title: pass.height === 'low' ? 'Lower the phone to waist height' : 'Lower the phone a bit',
      detail: `This pass is at ${h.label}. You're at about ${heightM.toFixed(1)} m.`,
    };
  }
  return null;
}

/** Pre-flight checklist shown before every capture. */
export const PREFLIGHT = [
  { id: 'lights', text: 'All lights on, and they stay the same for the whole capture.' },
  { id: 'blinds', text: 'Blinds: decide open or closed, then leave them. Avoid direct sun patches.' },
  { id: 'lens', text: 'Wipe the camera lens. Smudges cause haze and glow.' },
  { id: 'people', text: 'No people or moving things in the space. Ask others to step out.' },
  { id: 'doors', text: 'Doors and chairs set how you want them archived. Don\'t move anything mid-capture.' },
  { id: 'battery', text: 'Battery over 40% and at least 2 GB free.' },
  { id: 'orientation', text: 'Hold the phone sideways (landscape) and keep it that way. It sees twice as wide, so the scan finishes much faster.' },
];
