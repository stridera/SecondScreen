// Display controls for the top bar: Fullscreen toggle and "Keep screen awake" toggle, plus the iOS
// "Add to Home Screen" hint.
//
// Fullscreen: Fullscreen API on <html>, with webkit-prefixed fallbacks. Hidden when unsupported (and not iOS)
// or when the app already runs standalone (home screen app). On iOS Safari the API is missing (iPhone) or
// unreliable (iPad), so the button stays visible there and falls back to the Add to Home Screen hint.
//
// Keep awake: the plugin is normally served over plain http, which is not a secure context, so
// navigator.wakeLock does not exist there. In that case we use the NoSleep technique: a tiny muted, looping,
// inline video that is started from the user's click. Over https/localhost the Screen Wake Lock API is used.
// The video is inlined as a data: URI (awake-media.js) so Safari does not need HTTP Range requests for it.

import { icon } from "./icons.js";
import { toast } from "./ui.js";
import { AWAKE_MP4, AWAKE_WEBM } from "./awake-media.js";

const AWAKE_KEY = "ss.awake";
const A2HS_KEY = "ss.a2hsDismissed";

export function isStandalone() {
  return !!(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone);
}

// iPadOS 13+ Safari reports a Macintosh user agent, so tell it apart from a Mac by its touch screen.
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || ((/Macintosh/.test(navigator.userAgent) || navigator.platform === "MacIntel") && navigator.maxTouchPoints > 1);

const fsRoot = () => document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = () => {
  const r = fsRoot();
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  return enabled !== false && !!(r.requestFullscreen || r.webkitRequestFullscreen);
};

// ---- Add to Home Screen hint -------------------------------------------------------------------
/** True on iOS/iPadOS when not yet running as a home screen app. */
export const a2hsEligible = () => isIOS() && !isStandalone();

/** Kept for the Layouts menu: show its "Add to Home Screen" note whenever the hint applies. */
export function showFullscreenHint() { return a2hsEligible(); }

const A2HS_TEXT = "Tap Share → Add to Home Screen for a full-screen app. Keep the screen awake with the sun button; "
  + "if it still sleeps, set Settings → Display & Brightness → Auto-Lock to Never while playing.";

/**
 * Show the dismissible hint banner under the top bar. Without `force` it respects an earlier dismissal.
 * Returns true when the hint is on screen (so callers can skip their own message).
 */
export function showA2hsHint(force = false) {
  if (!a2hsEligible()) return false;
  const existing = document.getElementById("a2hs");
  if (existing) return true;
  let dismissed = false;
  try { dismissed = localStorage.getItem(A2HS_KEY) === "1"; } catch { /* storage blocked */ }
  if (dismissed && !force) return false;
  const bar = document.createElement("div");
  bar.id = "a2hs";
  bar.className = "a2hs";
  bar.setAttribute("role", "note");
  const text = document.createElement("span");
  text.textContent = A2HS_TEXT;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Got it";
  close.setAttribute("aria-label", "Dismiss the Add to Home Screen hint");
  close.addEventListener("click", () => {
    try { localStorage.setItem(A2HS_KEY, "1"); } catch { /* storage blocked */ }
    bar.remove();
  });
  bar.append(text, close);
  const anchor = document.querySelector(".topbar");
  if (anchor) anchor.after(bar); else document.body.prepend(bar);
  return true;
}

export function initScreenControls() {
  initFullscreen(document.getElementById("btn-fs"));
  initAwake(document.getElementById("btn-awake"));
  showA2hsHint(false);
}

// ---- fullscreen -------------------------------------------------------------------------------
function initFullscreen(btn) {
  if (!btn) return;
  const render = () => {
    // On iOS keep the button so a tap can explain the Home Screen route instead of the control just missing.
    btn.hidden = isStandalone() || !(fsSupported() || isIOS());
    const on = !!fsElement();
    btn.innerHTML = icon(on ? "fullscreen-exit" : "fullscreen");
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "Exit fullscreen" : "Enter fullscreen";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("primary", on);
  };
  const unavailable = () => { if (!showA2hsHint(true)) toast("Fullscreen is not available here."); };
  btn.addEventListener("click", async () => {
    try {
      if (fsElement()) {
        const r = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        if (r?.then) await r;
      } else if (!fsSupported()) {
        unavailable();
      } else {
        const root = fsRoot();
        const r = root.requestFullscreen ? root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen();
        if (r?.then) {
          await r;
          if (isIOS() && !fsElement()) unavailable(); // resolved but Safari did not actually go fullscreen
        }
      }
    } catch { unavailable(); }
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
    // Attributes first (iOS reads them when the element starts loading), then the matching properties.
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("loop", "");
    video.setAttribute("preload", "auto");
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
    // H.264 for Safari / iOS; VP8 WebM for browsers without H.264.
    video.src = video.canPlayType('video/mp4; codecs="avc1.42E01E"') || !video.canPlayType("video/webm") ? AWAKE_MP4 : AWAKE_WEBM;
    // NoSleep.js: nudge the playhead so the loop never reaches a hard end (some mobile browsers idle there).
    video.addEventListener("timeupdate", () => { if (video.currentTime > 0.5) video.currentTime = Math.random() * 0.4; });
    // If something else pauses us while the page is visible, try again.
    video.addEventListener("pause", () => {
      if (want && held && !document.hidden) video.play().catch(() => { held = false; render(); });
    });
    video.addEventListener("error", () => { if (held) { held = false; render(); } });
    document.body.append(video);
    return video;
  }

  // Why the last start() failed, as a sentence for the user.
  let failure = "";
  function describe(e) {
    const name = e?.name || "";
    if (name === "NotAllowedError") return "Safari blocked the keep-awake video (Low Power Mode or autoplay settings).";
    if (name === "NotSupportedError" || video?.error) return "This browser could not play the keep-awake video.";
    return `Keep awake failed${name ? ` (${name})` : ""}${e?.message ? `: ${e.message}` : ""}.`;
  }

  // Must be called synchronously from a user gesture: on the video path play() is its first await-free step.
  async function start() {
    if (mech === "Wake Lock" && wakeLockOk()) {
      try {
        await acquireWakeLock();
        held = true; render();
        return true;
      } catch { mech = "video fallback"; } // refused (e.g. battery saver); try the video trick instead
    }
    try {
      const v = ensureVideo();
      const p = v.play(); // no await before this line
      if (p?.then) await p;
      held = true; render();
      return true;
    } catch (e) {
      failure = describe(e);
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

  btn.addEventListener("click", () => {
    if (held) { want = false; save(); stop(); return; }
    want = true; save();
    start().then((ok) => {
      if (ok) return;
      want = false; save(); render();
      toast(failure || "Could not keep the screen awake on this browser.", 6000);
      showA2hsHint(true); // iOS only: points at Add to Home Screen / Auto-Lock as the workaround
    });
  });

  async function resume() {
    if (document.hidden || !want) return;
    if (mech === "Wake Lock" && wakeLockOk()) {
      if (!sentinel) { try { await acquireWakeLock(); held = true; } catch { held = false; } render(); }
    } else if (video && !video.ended) {
      try { await video.play(); held = true; } catch { held = false; } // iOS may insist on a new tap
      render();
    }
  }
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);

  render();
}
