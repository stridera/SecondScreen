// Alert sounds, synthesised with Web Audio (no audio files to ship or cache).
//
// Browsers only let a page make sound after a user gesture, so the AudioContext is created and resumed from the first
// tap / click / key press (the same kind of gesture screen.js waits for before it starts Keep awake). Until then
// isUnlocked() is false and the UI shows "Tap to enable sound". If the browser later suspends the context (iOS does when
// the page is backgrounded), the gesture listeners are armed again.

let ctx = null, master = null;
let volume = 0.8;
let armed = false;
const watchers = new Set();
const loops = new Map();

const AC = window.AudioContext || window.webkitAudioContext;

export const isSupported = () => !!AC;
export const isUnlocked = () => !!ctx && ctx.state === "running";
export function onChange(fn) { watchers.add(fn); return () => watchers.delete(fn); }
let wasRunning = false;
const fire = () => {
  const running = isUnlocked();
  // A repeating chime that started while locked should sound the moment the browser lets it, not a full period later.
  if (running && !wasRunning) for (const l of loops.values()) l.tick();
  wasRunning = running;
  for (const fn of watchers) { try { fn(running); } catch { /* ignore */ } }
};

export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  if (master && ctx) master.gain.setTargetAtTime(volume * volume, ctx.currentTime, 0.02); // squared: closer to perceived loudness
}

function ensure() {
  if (ctx || !AC) return ctx;
  ctx = new AC({ latencyHint: "interactive" });
  const comp = ctx.createDynamicsCompressor(); // keeps layered tones from clipping when turned up
  master = ctx.createGain();
  master.gain.value = volume * volume;
  master.connect(comp);
  comp.connect(ctx.destination);
  ctx.addEventListener("statechange", () => { if (ctx.state !== "running") arm(); fire(); });
  return ctx;
}

/** Call from (or right after) a user gesture. Resolves to true when sound is allowed. */
export async function unlock() {
  if (!AC) return false;
  const c = ensure();
  try {
    if (c.state !== "running") await c.resume();
    // A one-sample silent buffer finishes the unlock on iOS Safari.
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch { /* still locked */ }
  fire();
  if (isUnlocked()) disarm();
  return isUnlocked();
}

const GESTURES = ["pointerdown", "touchend", "click", "keydown"];
const onGesture = () => { unlock(); };
function arm() {
  if (armed || !AC) return;
  armed = true;
  for (const t of GESTURES) document.addEventListener(t, onGesture, true);
}
function disarm() {
  if (!armed) return;
  armed = false;
  for (const t of GESTURES) document.removeEventListener(t, onGesture, true);
}
/** Start listening for the first gesture. */
export function init() {
  arm();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx && ctx.state !== "running") { arm(); ctx.resume?.().then(fire, () => {}); }
  });
}

// [offset s, frequency Hz, duration s, waveform, gain]
const SOUNDS = {
  ding:    [[0, 880, .14, "sine", .5], [.12, 1318.5, .32, "sine", .5], [.12, 2637, .2, "sine", .12]],
  message: [[0, 1568, .1, "sine", .5], [.11, 2093, .22, "sine", .5]],
  high:    [[0, 784, .13, "triangle", .6], [.14, 988, .13, "triangle", .6], [.28, 1175, .3, "triangle", .6], [.28, 2350, .2, "sine", .15]],
  ready:   [[0, 1000, .12, "square", .22], [.2, 1000, .12, "square", .22], [.4, 1400, .25, "square", .22]],
  alarm:   [[0, 660, .22, "sawtooth", .3], [.26, 440, .4, "sawtooth", .3], [.8, 660, .22, "sawtooth", .3], [1.06, 440, .4, "sawtooth", .3]],
  // The duty pop chime: bright rising arpeggio with a held top note. Loud on purpose; it repeats until dismissed.
  duty:    [[0, 523.25, .14, "square", .3], [.15, 659.25, .14, "square", .3], [.3, 783.99, .14, "square", .3], [.45, 1046.5, .6, "square", .3],
            [0, 523.25, .14, "triangle", .7], [.15, 659.25, .14, "triangle", .7], [.3, 783.99, .14, "triangle", .7], [.45, 1046.5, .6, "triangle", .7],
            [.45, 2093, .5, "sine", .2]],
};
export const DUTY_LOOP_MS = 2200;

/** Plays a named sound once (does nothing while locked). Returns true if it was scheduled. */
export function play(name) {
  if (!isUnlocked()) return false;
  const notes = SOUNDS[name] || SOUNDS.ding;
  const t0 = ctx.currentTime + 0.02;
  for (const [off, freq, dur, type, gain] of notes) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0 + off);
    g.gain.setValueAtTime(0.0001, t0 + off);
    g.gain.exponentialRampToValueAtTime(gain, t0 + off + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + dur + 0.12);
    o.connect(g); g.connect(master);
    o.start(t0 + off);
    o.stop(t0 + off + dur + 0.16);
  }
  return true;
}

/** Repeats a sound every periodMs until stopLoop(key). `each` runs on every repeat (used for vibration). */
export function startLoop(key, name, periodMs = DUTY_LOOP_MS, each) {
  if (loops.has(key)) return;
  const tick = () => { play(name); try { each?.(); } catch { /* ignore */ } };
  loops.set(key, { id: setInterval(tick, periodMs), tick });
  tick();
}
export function stopLoop(key) {
  const l = loops.get(key);
  if (!l) return;
  clearInterval(l.id);
  loops.delete(key);
}
export const isLooping = (key) => loops.has(key);
