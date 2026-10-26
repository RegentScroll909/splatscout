// Audio feedback: a soft shutter tick per photo, voice coaching, haptics, and a screen wake lock.

let ctx = null;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
}

export function tick(kind = 'shot') {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(kind === 'shot' ? 1250 : 520, t);
  if (kind !== 'shot') o.frequency.exponentialRampToValueAtTime(380, t + 0.18);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(kind === 'shot' ? 0.05 : 0.08, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'shot' ? 0.06 : 0.2));
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.25);
}

/** Two rising notes: a pass or the scan area is complete. */
export function chime() {
  if (!ctx) return;
  const t = ctx.currentTime;
  [660, 990].forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t + i * 0.12);
    g.gain.setValueAtTime(0.0001, t + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.07, t + i * 0.12 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start(t + i * 0.12);
    o.stop(t + i * 0.12 + 0.35);
  });
}

export function buzz(ms = 15) {
  try {
    const active = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (active && navigator.vibrate) navigator.vibrate(ms);
  } catch {}
}

export function speak(text) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1;
    u.volume = 0.9;
    window.speechSynthesis.speak(u);
  } catch {}
}

let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (wakeLock && document.visibilityState === 'visible') keepAwake(true);
});
