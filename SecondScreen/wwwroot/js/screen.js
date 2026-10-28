// Display controls for the top bar: Fullscreen toggle and "Keep screen awake" toggle.
//
// Fullscreen: Fullscreen API on <html>, with webkit-prefixed fallbacks. Hidden when unsupported (iPhone Safari)
// or when the app already runs standalone (home screen app).
//
// Keep awake: the plugin is normally served over plain http, which is not a secure context, so
// navigator.wakeLock does not exist there. In that case we use the NoSleep technique: a tiny muted, looping,
// inline video that is started from the user's click. Over https/localhost the Screen Wake Lock API is used.

import { icon } from "./icons.js";
import { toast } from "./ui.js";

const AWAKE_KEY = "ss.awake";

export function isStandalone() {
  return !!(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone);
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const fsRoot = () => document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = () => {
  const r = fsRoot();
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  return enabled !== false && !!(r.requestFullscreen || r.webkitRequestFullscreen);
};

/** True when the Layouts menu should hint at the home screen route to fullscreen (iOS without the API). */
export function showFullscreenHint() {
  return isIOS() && !isStandalone() && !fsSupported();
}

export function initScreenControls() {
  initFullscreen(document.getElementById("btn-fs"));
  initAwake(document.getElementById("btn-awake"));
}

// ---- fullscreen -------------------------------------------------------------------------------
function initFullscreen(btn) {
  if (!btn) return;
  const render = () => {
    btn.hidden = !fsSupported() || isStandalone();
    const on = !!fsElement();
    btn.innerHTML = icon(on ? "fullscreen-exit" : "fullscreen");
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "Exit fullscreen" : "Enter fullscreen";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("primary", on);
  };
  btn.addEventListener("click", async () => {
    try {
      if (fsElement()) {
        const r = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        if (r?.then) await r;
      } else {
        const root = fsRoot();
        const r = root.requestFullscreen ? root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen();
        if (r?.then) await r;
      }
    } catch { toast("Fullscreen is not available here."); }
    render();
  });
  // Also fires when the user leaves with Esc or a system gesture.
  document.addEventListener("fullscreenchange", render);
  document.addEventListener("webkitfullscreenchange", render);
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", render);
  render();
}

// ---- keep awake -------------------------------------------------------------------------------
function initAwake(btn) {
  if (!btn) return;
  const wakeLockOk = () => window.isSecureContext && "wakeLock" in navigator;
  let mech = wakeLockOk() ? "Wake Lock" : "video fallback";
  let want = localStorage.getItem(AWAKE_KEY) === "1"; // the user's preference
  let held = false;                                   // a lock/video is actually keeping the screen on
  let sentinel = null, video = null, armed = false;

  const save = () => { try { localStorage.setItem(AWAKE_KEY, want ? "1" : "0"); } catch { /* storage blocked */ } };

  function render() {
    const pending = want && !held;
    btn.innerHTML = icon(held ? "awake-on" : "awake");
    btn.classList.toggle("primary", held);
    btn.classList.toggle("pending", pending);
    btn.setAttribute("aria-pressed", String(held));
    btn.setAttribute("aria-label", "Keep screen awake");
    btn.dataset.mech = mech;
    btn.title = held ? `Keep screen awake: on (${mech}). Tap to turn off.`
      : pending ? `Keep screen awake: tap to resume (${mech})`
      : `Keep screen awake: off (uses ${mech})`;
    if (pending) arm(); else disarm();
  }

  // A saved "on" preference cannot start by itself (play() needs a gesture), so the first tap anywhere resumes it.
  function onGesture(e) {
    if (btn.contains(e.target)) return; // the button's own click handles itself
    disarm();
    if (want && !held) start();
  }
  function arm() {
    if (armed) return;
    armed = true;
    for (const t of ["click", "touchend", "keydown"]) document.addEventListener(t, onGesture, true);
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const t of ["click", "touchend", "keydown"]) document.removeEventListener(t, onGesture, true);
  }

  function ensureVideo() {
    if (video) return video;
    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("aria-hidden", "true");
    video.setAttribute("tabindex", "-1");
    video.title = "Keeps the screen awake";
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.disableRemotePlayback = true;
    // Tiny and nearly invisible, but still laid out: some browsers pause display:none or fully off-screen videos.
    video.style.cssText = "position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.02;pointer-events:none;z-index:-1;border:0";
    for (const [src, type] of [["awake.webm", "video/webm"], ["awake.mp4", "video/mp4"]]) {
      const s = document.createElement("source");
      s.src = src; s.type = type;
      video.append(s);
    }
    // NoSleep.js: nudge the playhead so the loop never reaches a hard end (some mobile browsers idle there).
    video.addEventListener("timeupdate", () => { if (video.currentTime > 0.5) video.currentTime = Math.random() * 0.4; });
    // If something else pauses us while the page is visible, try again.
    video.addEventListener("pause", () => {
      if (want && held && !document.hidden) video.play().catch(() => { held = false; render(); });
    });
    document.body.append(video);
    return video;
  }

  // Must be called synchronously from a user gesture when it ends up on the video path.
  async function start() {
    if (mech === "Wake Lock" && wakeLockOk()) {
      try {
        await acquireWakeLock();
        held = true; render();
        return true;
      } catch { mech = "video fallback"; } // refused (e.g. battery saver); try the video trick instead
    }
    try {
      await ensureVideo().play();
      held = true; render();
      return true;
    } catch {
      held = false; render();
      return false;
    }
  }

  async function acquireWakeLock() {
    const s = await navigator.wakeLock.request("screen");
    sentinel = s;
    // The browser releases the lock whenever the page is hidden; visibilitychange below gets it back.
    s.addEventListener("release", () => { if (sentinel === s) { sentinel = null; held = false; render(); } });
  }

  function stop() {
    held = false;
    const s = sentinel; sentinel = null;
    s?.release().catch(() => {});
    video?.pause();
    render();
  }

  btn.addEventListener("click", async () => {
    if (held) { want = false; save(); stop(); return; }
    want = true; save();
    const ok = await start();
    if (!ok) { want = false; save(); render(); toast("Could not keep the screen awake on this browser."); }
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !want) return;
    if (mech === "Wake Lock" && wakeLockOk()) {
      if (!sentinel) { try { await acquireWakeLock(); held = true; } catch { held = false; } render(); }
    } else if (video && !video.ended) {
      try { await video.play(); held = true; } catch { held = false; } // iOS may insist on a new tap
      render();
    }
  });

  render();
}
