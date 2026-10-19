// Live coaching: turns raw capture signals into one clear instruction plus a row of status chips.
// Rules have hysteresis so messages don't flicker, and the most important problem always wins.

export const LIMITS = {
  relaxed: { rotWarn: 18, rotBad: 34, linWarn: 0.45, linBad: 0.75, flowWarn: 0.18, flowBad: 0.34 },
  standard: { rotWarn: 14, rotBad: 28, linWarn: 0.35, linBad: 0.6, flowWarn: 0.14, flowBad: 0.28 },
  strict: { rotWarn: 10, rotBad: 22, linWarn: 0.28, linBad: 0.5, flowWarn: 0.11, flowBad: 0.22 },
};

const LIGHT = { dark: 60, veryDark: 32, clipWarn: 0.04, clipBad: 0.12 };
const TEXTURE = { warn: 0.06, bad: 0.025 };

/**
 * Rule table, highest priority first.
 * test(s, L) returns false/undefined or a message {title, detail} (optionally overriding level).
 */
const RULES = [
  {
    id: 'orientation', level: 'bad', on: 0, off: 0.3, voice: 'Rotate the phone back',
    test: (s) => s.orientationChanged && {
      title: 'Rotate the phone back',
      detail: 'Keep the same portrait/landscape orientation for the whole capture. Capturing is paused until you rotate back.',
    },
  },
  {
    id: 'lost', level: 'bad', on: 0.4, off: 0.6, voice: 'Tracking lost. Hold still and point at a detailed area',
    test: (s) => s.trackState === 'lost' && {
      title: 'Tracking lost',
      detail: 'Hold still and aim at a detailed, well-lit area (furniture, corners, posters) until the map comes back.',
    },
  },
  {
    id: 'fast', level: 'bad', on: 0.25, off: 0.8, voice: 'Slow down',
    test: (s, L) => {
      if (s.rotSpeed > L.rotBad) return { title: 'Slow down — turning too fast', detail: 'Turn about a quarter as fast. Fast turns smear every frame.' };
      if (s.linSpeed != null && s.linSpeed > L.linBad) return { title: 'Slow down — walking too fast', detail: 'Take slow, small steps. Think "museum walk".' };
      if (s.linSpeed == null && s.flowSpeed > L.flowBad) return { title: 'Slow down', detail: 'The view is sliding past too quickly for sharp, overlapping photos.' };
      return false;
    },
  },
  {
    id: 'verydark', level: 'bad', on: 1.0, off: 1.0, voice: 'Too dark',
    test: (s) => s.mean < LIGHT.veryDark && {
      title: 'Too dark',
      detail: 'Turn on every light you can. Dark frames are noisy and blurry, and they make splats muddy. Never use the flashlight: moving light ruins splats.',
    },
  },
  {
    id: 'blur', level: 'warn', on: 0.8, off: 1.2, voice: 'Frames are blurry',
    test: (s) => s.relSharp < 0.55 && s.blurRisk > 0.3 && {
      title: 'Frames are blurry',
      detail: 'Move slower and pause for a beat at each spot. Brace your elbows against your body.',
    },
  },
  {
    id: 'near', level: 'warn', on: 0.8, off: 0.8, voice: 'Step back',
    test: (s) => s.depthMed > 0 && s.depthMed < 0.45 && {
      title: 'Too close — step back',
      detail: 'Keep about 1 m from surfaces. Up close, a frame covers too little for photos to overlap and match.',
    },
  },
  {
    id: 'highlights', level: 'warn', on: 1.0, off: 1.0, voice: null,
    test: (s) => s.clipHi > LIGHT.clipBad && {
      title: 'Bright window or lamp in view',
      detail: 'Blown-out areas turn into floaters. Close the blinds, or angle so the window is only at the frame edge.',
    },
  },
  {
    id: 'lowtex', level: 'warn', on: 1.2, off: 1.0, voice: 'Include more detail in the frame',
    test: (s) => s.texture < TEXTURE.bad && {
      title: 'Blank surface — nothing to match',
      detail: 'Step back or tilt so edges, corners, trim or furniture are in frame. Plain walls on their own can\'t be matched.',
    },
  },
  {
    id: 'rotinplace', level: 'warn', on: 1.0, off: 1.5, voice: 'Move, don\'t just turn',
    test: (s) => s.rotInPlace && {
      title: 'Move, don\'t just turn',
      detail: 'Turning on the spot gives no depth. Take a step sideways between shots, like a crab walk.',
    },
  },
  {
    id: 'gap', level: 'warn', on: 0, off: 3.0, voice: 'Go back over the last area',
    test: (s) => s.recentGap && {
      title: 'Gap — go back a little',
      detail: 'You moved on before a sharp photo was taken. Sweep slowly back over the last area.',
    },
  },
  {
    id: 'lens', level: 'warn', on: 0, off: 4.0, voice: null,
    test: (s) => s.lensSwitch && {
      title: 'The camera switched lenses',
      detail: 'Pick a single lens (not the automatic multi-camera) in setup. Mixed lenses confuse the reconstruction.',
    },
  },
  {
    id: 'speedwarn', level: 'warn', on: 0.6, off: 0.8, voice: null,
    test: (s, L) => (s.rotSpeed > L.rotWarn || (s.linSpeed != null ? s.linSpeed > L.linWarn : s.flowSpeed > L.flowWarn)) && {
      title: 'A little slower',
      detail: 'Slow and steady gives sharper photos and more overlap.',
    },
  },
  {
    id: 'dark', level: 'warn', on: 1.5, off: 1.0, voice: null,
    test: (s) => s.mean < LIGHT.dark && {
      title: 'Low light',
      detail: 'Add light if you can, and move extra slowly here: low light means slower shutter and more blur.',
    },
  },
  {
    id: 'highlightswarn', level: 'info', on: 3.0, off: 1.0, voice: null,
    test: (s) => s.clipHi > LIGHT.clipWarn && {
      title: 'Some blown highlights',
      detail: 'Fine for now. Avoid aiming straight at windows or bare bulbs.',
    },
  },
  {
    id: 'exposure', level: 'info', on: 0, off: 4.0, voice: null,
    test: (s) => s.exposureJumps >= 2 && {
      title: 'Brightness keeps changing',
      detail: 'Auto exposure is jumping. Keep windows out of frame when you can, and keep the lighting steady.',
    },
  },
  {
    id: 'limited', level: 'info', on: 1.0, off: 1.0, voice: null,
    test: (s) => s.trackState === 'limited' && {
      title: 'Tracking is weak',
      detail: 'Move a little slower and keep textured surfaces in view.',
    },
  },
  {
    id: 'height', level: 'info', on: 1.5, off: 1.0, voice: null,
    test: (s) => s.heightHint && { title: s.heightHint.title, detail: s.heightHint.detail },
  },
];

export class Coach {
  constructor({ strictness = 'standard', speak = null } = {}) {
    this.L = LIMITS[strictness] || LIMITS.standard;
    this.speak = speak;
    this.state = new Map(); // id -> {since, lastTrue, active}
    this.lastSpoken = new Map();
    this.lastSpeakT = 0;
    this.counts = {}; // how often each issue became active (for the report)
  }

  update(s) {
    const t = s.t;
    const active = [];
    for (const rule of RULES) {
      let st = this.state.get(rule.id);
      if (!st) this.state.set(rule.id, (st = { since: -1, lastTrue: -1, active: false, msg: null }));
      const msg = rule.test(s, this.L);
      if (msg) {
        if (st.since < 0) st.since = t;
        st.lastTrue = t;
        st.msg = msg;
        if (!st.active && t - st.since >= rule.on) {
          st.active = true;
          this.counts[rule.id] = (this.counts[rule.id] || 0) + 1;
        }
      } else {
        st.since = -1;
        if (st.active && t - st.lastTrue >= rule.off) st.active = false;
      }
      if (st.active) active.push({ id: rule.id, level: msg?.level || rule.level, voice: rule.voice, ...st.msg });
    }

    // Problems first, then "where to go next", then minor tips, then praise.
    let primary = active.find((a) => a.level === 'bad' || a.level === 'warn') || null;
    if (!primary && s.guidance) primary = { id: 'guide', level: 'info', ...s.guidance };
    if (!primary) primary = active[0] || null;
    if (!primary) {
      primary = { id: 'good', level: 'good', title: s.goodTitle || 'Looking good — keep going', detail: s.goodDetail || '' };
    }

    if (primary.voice && this.speak && (primary.level === 'bad' || primary.level === 'warn')) {
      const last = this.lastSpoken.get(primary.id) || -1e9;
      if (t - last > 8 && t - this.lastSpeakT > 3) {
        this.lastSpoken.set(primary.id, t);
        this.lastSpeakT = t;
        this.speak(primary.voice);
      }
    }

    return { primary, active, chips: this.chips(s) };
  }

  chips(s) {
    const L = this.L;
    const chips = {};
    // Speed
    let speedLevel = 'good', speedText;
    if (s.linSpeed != null) {
      const rotBad = s.rotSpeed > L.rotBad, linBad = s.linSpeed > L.linBad;
      const rotWarn = s.rotSpeed > L.rotWarn, linWarn = s.linSpeed > L.linWarn;
      speedLevel = rotBad || linBad ? 'bad' : rotWarn || linWarn ? 'warn' : 'good';
      speedText = `${Math.round(s.rotSpeed)}°/s · ${s.linSpeed.toFixed(2)} m/s`;
    } else {
      speedLevel = s.rotSpeed > L.rotBad || s.flowSpeed > L.flowBad ? 'bad' : s.rotSpeed > L.rotWarn || s.flowSpeed > L.flowWarn ? 'warn' : 'good';
      speedText = `${Math.round(s.rotSpeed)}°/s`;
    }
    chips.speed = { label: 'Speed', level: speedLevel, value: speedText };
    chips.sharp = {
      label: 'Sharp',
      level: s.relSharp >= 0.75 ? 'good' : s.relSharp >= 0.55 ? 'warn' : 'bad',
      value: `${Math.round(Math.min(1, s.relSharp) * 100)}%`,
    };
    chips.light = {
      label: 'Light',
      level: s.mean < LIGHT.veryDark || s.clipHi > LIGHT.clipBad ? 'bad' : s.mean < LIGHT.dark || s.clipHi > LIGHT.clipWarn ? 'warn' : 'good',
      value: s.clipHi > LIGHT.clipWarn ? 'glare' : s.mean < LIGHT.dark ? 'dim' : 'ok',
    };
    chips.detail = {
      label: 'Detail',
      level: s.texture < TEXTURE.bad ? 'bad' : s.texture < TEXTURE.warn ? 'warn' : 'good',
      value: s.texture < TEXTURE.bad ? 'blank' : s.texture < TEXTURE.warn ? 'low' : 'ok',
    };
    chips.parallax = {
      label: 'Depth',
      level: s.rotInPlace ? 'warn' : 'good',
      value: s.rotInPlace ? 'move!' : 'ok',
    };
    if (s.trackState !== 'n/a') {
      chips.track = {
        label: 'Track',
        level: s.trackState === 'lost' ? 'bad' : s.trackState === 'limited' ? 'warn' : 'good',
        value: s.trackState,
      };
    }
    return chips;
  }
}
