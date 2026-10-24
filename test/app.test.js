'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SoundpadPresenceApp, RATE_MAX } = require('../src/app');
const { SoundpadClient } = require('../src/soundpad-client');
const { DiscordIpcClient } = require('../src/discord-ipc');
const { normalizeConfig } = require('../src/config');
const { writeStateFile } = require('../src/state-file');
const { isSoundpadActive, readSoundpadState } = require('../integrations/claude-rpc/soundpad-state.cjs');
const { startFakeSoundpad, startFakeDiscord } = require('./helpers');

const fixtures = path.join(__dirname, 'fixtures');
const categoriesXml = fs.readFileSync(path.join(fixtures, 'categories.xml'), 'utf8');

// Scriptable Soundpad: the test changes `sp` and Soundpad answers from it.
function soundpadModel() {
  const sp = {
    status: 'STOPPED',
    positionMs: 0,
    durationMs: 0,
    playCounts: { 1: 12, 2: 40, 3: 0, 4: 3 },
    lastPlayed: { 1: '2026-10-20T18:30:11', 2: '2026-10-24T09:15:02', 3: '', 4: '2026-10-23T22:00:00' },
    positionSupported: true,
  };
  const meta = {
    1: 'url="C:\\Sounds\\Мемы\\bruh.mp3" title="" duration="0:03"',
    2: 'url="C:\\Sounds\\airhorn.wav" title="Air Horn" duration="0:07"',
    3: 'url="C:\\Sounds\\long.ogg" title="" duration="1:00"',
    4: 'url="C:\\Sounds\\oh.mp3" title="Оу май" duration="0:07"',
  };
  sp.play = (index, durationMs) => {
    sp.status = 'PLAYING';
    sp.positionMs = 0;
    sp.durationMs = durationMs;
    sp.playCounts[index]++;
    sp.lastPlayed[index] = '2026-10-24T10:00:' + String(10 + sp.playCounts[index]).padStart(2, '0');
  };
  sp.handler = (cmd) => {
    switch (cmd) {
      case 'GetPlayStatus()': return sp.status;
      case 'GetPlaybackPositionInMs()': return sp.positionSupported ? String(sp.positionMs) : 'R-404';
      case 'GetPlaybackDurationInMs()': return String(sp.durationMs);
      case 'GetTitleText()': return 'Soundpad';
      case 'GetStatusBarText()': return '';
      case 'GetCategories(true, false)': return categoriesXml;
      case 'GetSoundlist()':
        return '<Soundlist>' + Object.keys(meta).map((i) =>
          `<Sound index="${i}" ${meta[i]} artist="" playCount="${sp.playCounts[i]}" lastPlayedOn="${sp.lastPlayed[i]}"/>`).join('') + '</Soundlist>';
      default: return 'R-400';
    }
  };
  return sp;
}

async function setup(t, extraConfig = {}) {
  const sp = soundpadModel();
  const spServer = await startFakeSoundpad((cmd) => sp.handler(cmd));
  const discord = await startFakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprpc-state-'));
  const config = normalizeConfig({
    client_id: '123456789012345678',
    state_file: path.join(dir, 'state.json'),
    discord_retry_ms: 1000,
    ...extraConfig,
  }, { env: {} });
  let clock = 1_800_000_000_000;
  const soundpad = new SoundpadClient({ pipePath: spServer.pipePath, timeoutMs: 1000 });
  const app = new SoundpadPresenceApp({
    config,
    soundpad,
    createDiscord: () => new DiscordIpcClient({ clientId: config.client_id, pipePaths: [discord.pipePath], timeoutMs: 1000 }),
    now: () => clock,
    logger: process.env.DBG ? { info: console.log, warn: console.log, error: console.log, debug: console.log } : undefined,
    writeState: (s) => writeStateFile(config.state_file, s),
  });
  const ctx = {
    sp, spServer, discord, app, config,
    advance(ms) {
      clock += ms;
      if (sp.status === 'PLAYING') sp.positionMs = Math.min(sp.durationMs, sp.positionMs + ms);
    },
    get now() { return clock; },
    state: () => readSoundpadState(config.state_file),
  };
  t.after(async () => {
    await app.shutdown();
    await spServer.close();
    await discord.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

test('full cycle: play, progress, pause, other sound, stop, Soundpad closed', async (t) => {
  const c = await setup(t);
  const { sp, discord, app } = c;

  // Idle Soundpad: no Discord traffic at all.
  assert.equal(await app.tick(), null);
  assert.equal(discord.activities.length, 0);
  assert.equal(c.state().active, false);

  sp.play(4, 7000);
  c.advance(500);
  let a = await app.tick();
  assert.equal(a.type, 2);
  assert.equal(a.details, 'Оу май');
  assert.equal(a.state, 'Русские мемы');
  assert.deepEqual(a.timestamps, { start: c.now - 500, end: c.now + 6500 });
  assert.equal(discord.activities.length, 1);
  assert.equal(c.state().active, true);
  assert.equal(c.state().title, 'Оу май');
  assert.equal(isSoundpadActive({ file: c.config.state_file, now: c.now, pidAlive: () => true }), true);

  // Steady playback: no extra SET_ACTIVITY calls.
  for (let i = 0; i < 3; i++) {
    c.advance(1000);
    await app.tick();
  }
  assert.equal(discord.activities.length, 1);

  // Pause: activity stays, without progress bar.
  sp.status = 'PAUSED';
  c.advance(1000);
  a = await app.tick();
  assert.equal(a.state, 'На паузе');
  assert.equal(a.timestamps, undefined);
  assert.equal(discord.activities.length, 2);

  // Resume after a while: progress bar is shifted accordingly.
  c.advance(10000);
  sp.status = 'PLAYING';
  a = await app.tick();
  assert.equal(a.timestamps.start, c.now - sp.positionMs);
  assert.equal(discord.activities.length, 3);

  // Seek forward: timestamps are updated.
  sp.positionMs += 2000;
  c.advance(1000);
  a = await app.tick();
  assert.equal(a.timestamps.end, c.now + (7000 - sp.positionMs));
  assert.equal(discord.activities.length, 4);

  // Another sound while playing.
  sp.play(1, 3000);
  c.advance(1000);
  a = await app.tick();
  assert.equal(a.details, 'bruh');
  assert.equal(a.state, 'Мемы');
  assert.equal(discord.activities.at(-1).details, 'bruh');

  // Stopped: activity removed completely. Five updates were sent in the last
  // 20 s, so the clear waits for the rate-limit window and then goes out.
  sp.status = 'STOPPED';
  c.advance(1000);
  assert.equal(await app.tick(), null);
  assert.equal(discord.activities.length, RATE_MAX);
  c.advance(15000);
  assert.equal(await app.tick(), null);
  assert.equal(discord.activities.length, RATE_MAX + 1);
  assert.equal(discord.activities.at(-1), null);
  assert.equal(c.state().active, false);
  assert.equal(isSoundpadActive({ file: c.config.state_file, now: c.now, pidAlive: () => true }), false);

  // Soundpad closed while playing: activity removed.
  sp.play(2, 7000);
  c.advance(1000);
  a = await app.tick();
  assert.equal(a.details, 'Air Horn');
  assert.equal(a.state, 'Эффекты');
  await c.spServer.close();
  c.advance(1000);
  assert.equal(await app.tick(), null);
  assert.equal(discord.activities.at(-1), null);
  assert.equal(c.state().status, 'CLOSED');
});

test('position fallback when GetPlaybackPositionInMs is unsupported', async (t) => {
  const c = await setup(t);
  c.sp.positionSupported = false;
  c.sp.play(2, 7000);
  let a = await c.app.tick();
  const start = a.timestamps.start;
  assert.equal(start, c.now);
  c.advance(3000);
  a = await c.app.tick();
  assert.equal(a.timestamps.start, start); // own clock keeps the bar consistent
});

test('Discord restart: activity is sent again after reconnect', async (t) => {
  const c = await setup(t);
  c.sp.play(2, 7000);
  await c.app.tick();
  assert.equal(c.discord.activities.length, 1);
  c.discord.kick();
  await new Promise((r) => setTimeout(r, 50));
  c.advance(1000);
  await c.app.tick();
  assert.equal(c.discord.activities.length, 2);
  assert.equal(c.discord.activities[1].details, 'Air Horn');
});

test('rate limit: at most RATE_MAX updates per 20 s, latest wins', async (t) => {
  const c = await setup(t);
  for (let i = 0; i < RATE_MAX + 3; i++) {
    c.sp.play(i % 2 ? 1 : 2, i % 2 ? 3000 : 7000);
    c.advance(200);
    await c.app.tick();
  }
  assert.equal(c.discord.activities.length, RATE_MAX);
  c.advance(20000);
  c.sp.status = 'PLAYING';
  await c.app.tick();
  assert.equal(c.discord.activities.length, RATE_MAX + 1);
  assert.equal(c.discord.activities.at(-1).details, c.app.desired.details);
});

test('show_when_paused=false clears on pause', async (t) => {
  const c = await setup(t, { show_when_paused: false });
  c.sp.play(2, 7000);
  await c.app.tick();
  c.sp.status = 'PAUSED';
  c.advance(1000);
  assert.equal(await c.app.tick(), null);
  assert.equal(c.discord.activities.at(-1), null);
});

test('claude-rpc helper treats a dead soundpad-rpc or stale file as inactive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprpc-helper-'));
  const file = path.join(dir, 'state.json');
  assert.equal(isSoundpadActive({ file }), false); // no file
  writeStateFile(file, { active: true, status: 'PLAYING', title: 'x', ends_at: 10000, pid: process.pid, updated_at: 0 });
  assert.equal(isSoundpadActive({ file, now: 9000 }), true);
  assert.equal(isSoundpadActive({ file, now: 20000 }), false); // sound must have ended
  assert.equal(isSoundpadActive({ file, now: 9000, pidAlive: () => false }), false);
  writeStateFile(file, { active: true, status: 'PAUSED', title: 'x', ends_at: null, pid: process.pid, updated_at: 0 });
  assert.equal(isSoundpadActive({ file, now: 1e15 }), true); // paused: as long as the process lives
  fs.writeFileSync(file, '{broken');
  assert.equal(isSoundpadActive({ file }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
