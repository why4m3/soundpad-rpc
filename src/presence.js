'use strict';

// Pure logic: which sound is playing, what activity to show, when to update.

const { soundDisplayName } = require('./soundpad-protocol');

const DURATION_TOLERANCE_MS = 1500;
const TIMESTAMP_TOLERANCE_MS = 1500;
const BLANK = '⠀'; // Discord rejects strings shorter than 2 chars

function durationMatches(sound, durationMs) {
  if (!sound || sound.durationMs == null || !durationMs) return true;
  return Math.abs(sound.durationMs - durationMs) <= DURATION_TOLERANCE_MS;
}

function byRecency(a, b) {
  return (b.lastPlayedOn || 0) - (a.lastPlayedOn || 0) || (b.index || 0) - (a.index || 0);
}

function snapshotOf(sounds) {
  const map = new Map();
  for (const s of sounds) map.set(s.index, { playCount: s.playCount, lastPlayedOnRaw: s.lastPlayedOnRaw });
  return map;
}

// Sounds whose play counter or "last played" stamp changed since the snapshot.
function changedSounds(snapshot, sounds) {
  if (!snapshot) return [];
  return sounds.filter((s) => {
    const prev = snapshot.get(s.index);
    if (!prev) return s.playCount > 0;
    return prev.playCount !== s.playCount || prev.lastPlayedOnRaw !== s.lastPlayedOnRaw;
  });
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Sounds whose name is visible in the Soundpad window title / status bar.
function textMatches(sounds, texts) {
  const haystack = texts.map(normalize).filter(Boolean);
  if (!haystack.length) return [];
  const found = [];
  for (const s of sounds) {
    const names = [s.title, s.fileName].map(normalize).filter((n) => n.length >= 3);
    let best = 0;
    for (const n of names) if (haystack.some((h) => h.includes(n))) best = Math.max(best, n.length);
    if (best) found.push({ sound: s, score: best });
  }
  found.sort((a, b) => b.score - a.score);
  if (found.length > 1 && found[0].score === found[1].score) return [];
  return found.map((f) => f.sound);
}

// Soundpad's API has no "currently playing sound" command, so the sound is
// inferred. Returns { sound, method } where method tells how sure we are.
function identifySound({ sounds, snapshot = null, durationMs = null, current = null, texts = [] }) {
  if (!sounds || !sounds.length) return { sound: null, method: 'none' };

  const changed = changedSounds(snapshot, sounds).filter((s) => durationMatches(s, durationMs));
  if (changed.length === 1) return { sound: changed[0], method: 'counter' };

  const byText = textMatches(changed.length ? changed : sounds, texts).filter((s) => durationMatches(s, durationMs));
  if (byText.length) return { sound: byText[0], method: 'text' };

  if (changed.length > 1) return { sound: changed.slice().sort(byRecency)[0], method: 'counter' };

  if (current) {
    const fresh = sounds.find((s) => s.index === current.index);
    if (fresh && durationMatches(fresh, durationMs)) return { sound: fresh, method: 'current' };
  }

  const matching = sounds.filter((s) => s.durationMs != null && durationMs && durationMatches(s, durationMs));
  if (matching.length === 1) return { sound: matching[0], method: 'duration' };
  if (matching.length > 1) return { sound: matching.slice().sort(byRecency)[0], method: 'recent+duration' };

  const recent = sounds.filter((s) => s.lastPlayedOn).sort(byRecency);
  if (recent.length) return { sound: recent[0], method: 'recent' };
  return { sound: null, method: 'none' };
}

// Did a new playback start between two polls? (as opposed to the same sound
// continuing, pausing or being seeked forward)
function isNewPlayback(prev, cur) {
  if (!cur || !isActiveStatus(cur.status)) return false;
  if (!prev || !isActiveStatus(prev.status)) return true;
  if (prev.durationMs && cur.durationMs && Math.abs(prev.durationMs - cur.durationMs) > 500) return true;
  if (prev.positionMs != null && cur.positionMs != null) {
    const elapsed = prev.status === 'PLAYING' ? Math.max(0, cur.at - prev.at) : 0;
    const expected = prev.positionMs + elapsed;
    if (cur.positionMs + DURATION_TOLERANCE_MS < expected && cur.positionMs < 2000) return true;
  }
  return false;
}

function isActiveStatus(status) {
  return status === 'PLAYING' || status === 'PAUSED' || status === 'SEEKING';
}

function fillTemplate(template, values) {
  return String(template || '')
    .replace(/\{(\w+)\}/g, (all, key) => (values[key] != null ? String(values[key]) : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function fitField(text, fallback) {
  let t = (text || '').trim() || (fallback || '').trim();
  if (!t) return null;
  if ([...t].length > 128) t = [...t].slice(0, 127).join('') + '…';
  if (t.length < 2) t += BLANK;
  return t;
}

// Builds the Discord activity object, or null when nothing should be shown.
// sample: { status, positionMs, durationMs, at }
function buildActivity({ sample, sound, category, config }) {
  if (!sample || !isActiveStatus(sample.status)) return null;
  const paused = sample.status === 'PAUSED';
  if (paused && !config.show_when_paused) return null;

  const title = soundDisplayName(sound) || config.unknown_title;
  const values = {
    title,
    file: (sound && sound.fileName) || title,
    artist: (sound && sound.artist) || '',
    category: category || config.default_category,
  };
  const details = fitField(fillTemplate(config.details, values), title);
  let state = fitField(fillTemplate(config.state, values), config.default_category);
  if (paused && config.paused_state) state = fitField(fillTemplate(config.paused_state, values), state);

  const activity = { type: config.activity_type, details };
  if (state) activity.state = state;
  if (config.status_display_type !== null && config.status_display_type !== undefined) {
    activity.status_display_type = config.status_display_type;
  }

  if (!paused && sample.durationMs > 0) {
    const position = Math.min(Math.max(0, sample.positionMs || 0), sample.durationMs);
    const start = sample.at - position;
    activity.timestamps = { start, end: start + sample.durationMs };
  }

  const assets = {};
  if (config.large_image) assets.large_image = config.large_image;
  const largeText = fitField(fillTemplate(config.large_text, values), '');
  if (largeText && config.large_image) assets.large_text = largeText;
  if (paused && config.small_image_paused) {
    assets.small_image = config.small_image_paused;
    assets.small_text = fitField(config.paused_state, 'Paused');
  }
  if (Object.keys(assets).length) activity.assets = assets;
  activity.instance = false;
  return activity;
}

// True when the new activity differs enough from the last sent one to be
// worth a SET_ACTIVITY call (Discord rate-limits presence updates).
function activityChanged(prev, next) {
  if (!prev || !next) return prev !== next;
  const strip = (a) => JSON.stringify({ ...a, timestamps: undefined });
  if (strip(prev) !== strip(next)) return true;
  const a = prev.timestamps;
  const b = next.timestamps;
  if (!a || !b) return Boolean(a) !== Boolean(b);
  return Math.abs(a.start - b.start) > TIMESTAMP_TOLERANCE_MS || Math.abs(a.end - b.end) > TIMESTAMP_TOLERANCE_MS;
}

module.exports = {
  identifySound,
  isNewPlayback,
  isActiveStatus,
  buildActivity,
  activityChanged,
  snapshotOf,
  changedSounds,
  textMatches,
  fillTemplate,
  durationMatches,
};
