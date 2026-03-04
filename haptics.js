const WEB_HAPTICS_ESM_URL = "https://cdn.jsdelivr.net/npm/web-haptics/+esm";
const COOLDOWN_MS = 100;
const PREFERENCE_KEY = "site-haptics-preference";
const SUCCESS_PATTERN = [
  { duration: 40, intensity: 0.85 },
  { delay: 45, duration: 70, intensity: 1 },
];

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

let hapticClient = null;
let lastTriggerAt = 0;
let moduleLoaded = false;

import(WEB_HAPTICS_ESM_URL)
  .then(function (mod) {
    if (mod && typeof mod.WebHaptics === "function") {
      hapticClient = new mod.WebHaptics();
    }
    moduleLoaded = true;
  })
  .catch(function () {
    moduleLoaded = true;
  });

function getPreference() {
  try {
    const stored = window.localStorage.getItem(PREFERENCE_KEY);
    return stored === "off" ? "off" : "auto";
  } catch (error) {
    return "auto";
  }
}

function setPreference(nextPreference) {
  const normalized = nextPreference === "off" ? "off" : "auto";
  try {
    window.localStorage.setItem(PREFERENCE_KEY, normalized);
  } catch (error) {}
  return normalized;
}

function isDataSaverEnabled() {
  const connection =
    navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;
  return Boolean(connection && connection.saveData);
}

function isCoarsePointerActive() {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(pointer: coarse)").matches;
  }
  return false;
}

function isEnabled() {
  if (!isCoarsePointerActive()) return false;
  if (getPreference() === "off") return false;
  if (reducedMotionQuery.matches) return false;
  if (isDataSaverEnabled()) return false;
  return true;
}

function trigger(type) {
  if (!isEnabled()) return false;
  if (!moduleLoaded || !hapticClient || typeof hapticClient.trigger !== "function") {
    return false;
  }

  const now = Date.now();
  if (now - lastTriggerAt < COOLDOWN_MS) return false;
  lastTriggerAt = now;

  hapticClient.trigger(type || "medium");
  return true;
}

export const haptics = {
  trigger: trigger,
  selection: function () {
    return trigger("selection");
  },
  light: function () {
    return trigger("light");
  },
  medium: function () {
    return trigger("medium");
  },
  success: function () {
    return trigger(SUCCESS_PATTERN);
  },
  getPreference: getPreference,
  setPreference: setPreference,
};
