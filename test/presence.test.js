'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/soundpad-protocol');
const S = require('../src/presence');
const { normalizeConfig } = require('../src/config');

const sounds = P.parseSoundlist(fs.readFileSync(path.join(__dirname, 'fixtures', 'soundlist.xml'), 'utf8'));
const byIndex = (i) => sounds.find((s) => s.index === i);
const config = normalizeConfig({ client_id: '123456789012345678' }, { env: {} });

function bump(list, index, stamp) {
  return list.map((s) => (s.index === index ? { ...s, playCount: s.playCount + 1, lastPlayedOnRaw: stamp, lastPlayedOn: Date.parse(stamp) } : s));
}

test('identify by changed play counter', () => {
  const snapshot = S.snapshotOf(sounds);
  const after = bump(sounds, 1, '2026-10-24T10:00:00');
  const r = S.identifySound({ sounds: after, snapshot, durationMs: 3050 });
  assert.equal(r.method, 'counter');
  assert.equal(r.sound.index, 1);
});

test('counter change with wrong duration is ignored', () => {
  const snapshot = S.snapshotOf(sounds);
  const after = bump(sounds, 1, '2026-10-24T10:00:00'); // bruh is 3 s
  const r = S.identifySound({ sounds: after, snapshot, durationMs: 7000 });
  assert.notEqual(r.method, 'counter');
});

test('several changed sounds: text match wins, otherwise most recent', () => {
  const snapshot = S.snapshotOf(sounds);
  let after = bump(sounds, 2, '2026-10-24T10:00:05');
  after = bump(after, 4, '2026-10-24T10:00:01');
  const byText = S.identifySound({ sounds: after, snapshot, durationMs: 7000, texts: ['Soundpad - Оу май'] });
  assert.equal(byText.method, 'text');
  assert.equal(byText.sound.index, 4);
  const byTime = S.identifySound({ sounds: after, snapshot, durationMs: 7000 });
  assert.equal(byTime.method, 'counter');
  assert.equal(byTime.sound.index, 2);
});

test('identify by window or status bar text', () => {
  const r = S.identifySound({ sounds, durationMs: 3000, texts: ['Playing: bruh.mp3'] });
  assert.equal(r.method, 'text');
  assert.equal(r.sound.index, 1);
  // Ambiguous or unrelated text is ignored.
  const none = S.identifySound({ sounds, durationMs: 3000, texts: ['Soundpad'] });
  assert.notEqual(none.method, 'text');
});

test('keeps the current sound when nothing changed (replay, seek)', () => {
  const r = S.identifySound({ sounds, snapshot: S.snapshotOf(sounds), durationMs: 7000, current: byIndex(4) });
  assert.equal(r.method, 'current');
  assert.equal(r.sound.index, 4);
});

test('falls back to duration, then recency', () => {
  const unique = S.identifySound({ sounds, durationMs: 3723400 });
  assert.equal(unique.method, 'duration');
  assert.equal(unique.sound.index, 3);
  const twoWithSameLength = S.identifySound({ sounds, durationMs: 7000 });
  assert.equal(twoWithSameLength.method, 'recent+duration');
  assert.equal(twoWithSameLength.sound.index, 2);
  const noDuration = S.identifySound({ sounds, durationMs: null });
  assert.equal(noDuration.method, 'recent');
  assert.equal(noDuration.sound.index, 2);
  assert.deepEqual(S.identifySound({ sounds: [], durationMs: 1 }), { sound: null, method: 'none' });
});

test('new playback detection', () => {
  const play = (positionMs, at, durationMs = 7000, status = 'PLAYING') => ({ status, positionMs, durationMs, at });
  assert.equal(S.isNewPlayback(null, play(100, 0)), true);
  assert.equal(S.isNewPlayback({ status: 'STOPPED', at: 0 }, play(100, 1000)), true);
  assert.equal(S.isNewPlayback(play(1000, 0), play(2000, 1000)), false);
  assert.equal(S.isNewPlayback(play(1000, 0), play(2000, 1000, 3000)), true); // other length
  assert.equal(S.isNewPlayback(play(5000, 0), play(200, 1000)), true); // restarted
  assert.equal(S.isNewPlayback(play(5000, 0), play(3500, 1000)), false); // seek back, not to start
  assert.equal(S.isNewPlayback(play(5000, 0, 7000, 'PAUSED'), play(5000, 9000, 7000, 'PAUSED')), false);
  assert.equal(S.isNewPlayback(play(5000, 0), { status: 'STOPPED', at: 1000 }), false);
});

test('activity while playing has Spotify-like timestamps', () => {
  const at = 1_800_000_000_000;
  const a = S.buildActivity({ sample: { status: 'PLAYING', positionMs: 2000, durationMs: 7000, at }, sound: byIndex(4), category: 'Мемы', config });
  assert.equal(a.type, 2);
  assert.equal(a.details, 'Оу май');
  assert.equal(a.state, 'Мемы');
  assert.equal(a.status_display_type, 2);
  assert.deepEqual(a.timestamps, { start: at - 2000, end: at + 5000 });
  assert.deepEqual(a.assets, { large_image: 'soundpad', large_text: 'Soundpad' });
  assert.equal(a.instance, false);
  assert.doesNotMatch(JSON.stringify(a), /\p{Extended_Pictographic}/u);
});

test('activity fallbacks: no category, unknown sound, short names, long names', () => {
  const sample = { status: 'PLAYING', positionMs: 0, durationMs: 1000, at: 0 };
  const a = S.buildActivity({ sample, sound: byIndex(1), category: '', config });
  assert.equal(a.details, 'bruh');
  assert.equal(a.state, 'Soundpad');
  const unknown = S.buildActivity({ sample, sound: null, category: '', config });
  assert.equal(unknown.details, 'Soundpad');
  const short = S.buildActivity({ sample, sound: { title: 'a', fileName: 'a' }, category: 'b', config });
  assert.equal(short.details.length, 2);
  assert.equal(short.state.length, 2);
  const long = S.buildActivity({ sample, sound: { title: 'x'.repeat(300), fileName: '' }, category: '', config });
  assert.equal([...long.details].length, 128);
});

test('position is clamped into the duration', () => {
  const a = S.buildActivity({ sample: { status: 'PLAYING', positionMs: 99999, durationMs: 7000, at: 10000 }, sound: byIndex(2), category: '', config });
  assert.deepEqual(a.timestamps, { start: 3000, end: 10000 });
});

test('paused, stopped and closed', () => {
  const paused = S.buildActivity({ sample: { status: 'PAUSED', positionMs: 2000, durationMs: 7000, at: 0 }, sound: byIndex(2), category: 'Эффекты', config });
  assert.equal(paused.details, 'Air Horn & Echo');
  assert.equal(paused.state, 'На паузе');
  assert.equal(paused.timestamps, undefined);
  const hidden = S.buildActivity({ sample: { status: 'PAUSED', positionMs: 0, durationMs: 7000, at: 0 }, sound: byIndex(2), category: '', config: { ...config, show_when_paused: false } });
  assert.equal(hidden, null);
  assert.equal(S.buildActivity({ sample: { status: 'STOPPED', at: 0 }, sound: byIndex(2), category: '', config }), null);
  assert.equal(S.buildActivity({ sample: null, sound: null, category: '', config }), null);
});

test('templates', () => {
  const cfg = { ...config, details: '{artist} - {title}', state: '{category} / {file}' };
  const a = S.buildActivity({ sample: { status: 'PLAYING', positionMs: 0, durationMs: 7000, at: 0 }, sound: byIndex(2), category: 'FX', config: cfg });
  assert.equal(a.details, 'DJ - Air Horn & Echo');
  assert.equal(a.state, 'FX / airhorn');
  assert.equal(S.fillTemplate('{nope}{title}', { title: 'x' }), 'x');
});

test('activity change detection ignores timestamp jitter', () => {
  const base = { type: 2, details: 'a', state: 'b', timestamps: { start: 1000, end: 8000 } };
  assert.equal(S.activityChanged(base, { ...base, timestamps: { start: 1400, end: 8400 } }), false);
  assert.equal(S.activityChanged(base, { ...base, timestamps: { start: 4000, end: 11000 } }), true);
  assert.equal(S.activityChanged(base, { ...base, details: 'c' }), true);
  assert.equal(S.activityChanged(base, { ...base, timestamps: undefined }), true);
  assert.equal(S.activityChanged(base, null), true);
  assert.equal(S.activityChanged(null, null), false);
  assert.equal(S.activityChanged(undefined, null), true);
});
