#!/usr/bin/env node
'use strict';

// soundpad-rpc: Discord Rich Presence ("Слушает") for Soundpad.
//
//   node index.js                 run (normally started hidden via start-hidden.vbs)
//   node index.js --dry-run       no Discord: print what would be shown
//   node index.js --diagnose      print raw Soundpad API answers and exit
//   node index.js --test-discord  show a 30 s demo activity and exit
//   node index.js --debug         more log lines
//   node index.js --version       print the version and exit

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { loadConfig, validateConfig, APP_DIR } = require('./src/config');
const { createLogger } = require('./src/logger');
const { SoundpadClient } = require('./src/soundpad-client');
const { DiscordIpcClient } = require('./src/discord-ipc');
const { SoundpadPresenceApp } = require('./src/app');
const { writeStateFile } = require('./src/state-file');
const P = require('./src/soundpad-protocol');

const args = new Set(process.argv.slice(2));
const MIN_NODE = 18;

function discordPipes(config) {
  return config.discord_pipe ? [config.discord_pipe] : null;
}

// One running instance per user (autostart + a manual start would fight).
// A listening pipe is released by Windows when the process dies, unlike a
// pid file whose pid may be reused after a reboot.
function acquireSingleInstance(stateFile) {
  const user = (process.env.USERNAME || process.env.USER || 'user').replace(/[^\w.-]/g, '_');
  const lockPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\soundpad-rpc-instance-' + user
    : path.join(require('node:os').tmpdir(), 'soundpad-rpc-instance-' + user + '.sock');
  const pidFile = path.join(path.dirname(stateFile), 'soundpad-rpc.pid');
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.end());
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return resolve({ ok: true, pidFile, server: null });
      // Stale Unix socket file (no Windows equivalent): probe it.
      const probe = net.connect(lockPath);
      probe.once('connect', () => { probe.destroy(); resolve({ ok: false, pidFile }); });
      probe.once('error', () => {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        server.listen(lockPath, () => resolve({ ok: true, pidFile, server }));
      });
    });
    server.listen(lockPath, () => resolve({ ok: true, pidFile, server }));
  }).then((res) => {
    if (res.ok) {
      try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(process.pid));
      } catch { /* only used by windows/stop.ps1 */ }
    }
    return res;
  });
}

async function diagnose(config) {
  const client = new SoundpadClient({ pipePath: config.soundpad_pipe });
  const commands = ['IsAlive()', 'GetVersion()', 'GetRemoteControlVersion()', 'GetPlayStatus()',
    'GetPlaybackPositionInMs()', 'GetPlaybackDurationInMs()', 'GetTitleText()', 'GetStatusBarText()',
    'GetSoundFileCount()', 'GetSoundlist()', 'GetCategories(true, false)'];
  const raw = {};
  for (const cmd of commands) {
    try {
      raw[cmd] = await client.send(cmd);
    } catch (err) {
      console.log(cmd + ' -> ОШИБКА: ' + err.message);
      if (cmd === 'IsAlive()') {
        console.log('Soundpad не запущен или pipe ' + config.soundpad_pipe + ' недоступен.');
        client.close();
        return 1;
      }
      continue;
    }
    const text = raw[cmd];
    console.log(cmd + ' -> ' + (text.length > 400 ? text.slice(0, 400) + ' ... (' + text.length + ' символов)' : text));
  }
  client.close();
  try {
    const sounds = P.parseSoundlist(raw['GetSoundlist()']);
    console.log('\nЗвуков в списке: ' + sounds.length);
    const recent = sounds.filter((s) => s.lastPlayedOn).sort((a, b) => b.lastPlayedOn - a.lastPlayedOn).slice(0, 5);
    for (const s of recent) {
      console.log('  #' + s.index + ' ' + P.soundDisplayName(s) + ' | длительность ' + s.durationMs + ' мс | lastPlayedOn=' +
        s.lastPlayedOnRaw + ' | playCount=' + s.playCount);
    }
  } catch (err) {
    console.log('Разбор GetSoundlist(): ' + err.message);
  }
  return 0;
}

async function testDiscord(config) {
  const discord = new DiscordIpcClient({ clientId: config.client_id, pipePaths: discordPipes(config) });
  const user = await discord.connect();
  console.log('Discord: подключено как ' + (user.username || '?'));
  const start = Date.now();
  const activity = {
    type: config.activity_type,
    details: 'Тестовый звук',
    state: 'Проверка soundpad-rpc',
    timestamps: { start, end: start + 30000 },
    instance: false,
  };
  if (config.status_display_type !== null) activity.status_display_type = config.status_display_type;
  if (config.large_image) activity.assets = { large_image: config.large_image, large_text: config.large_text || 'Soundpad' };
  await discord.setActivity(activity);
  console.log('Показана тестовая активность на 30 секунд. Откройте свой профиль в Discord.');
  await new Promise((r) => setTimeout(r, 30000));
  await discord.clearActivity();
  discord.close();
  console.log('Тестовая активность убрана.');
  return 0;
}

async function main() {
  if (args.has('--version')) {
    console.log('soundpad-rpc ' + require('./package.json').version);
    return 0;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) {
    console.error('Нужен Node.js ' + MIN_NODE + '+ (лучше 20+), сейчас ' + process.version);
    return 1;
  }

  const config = loadConfig(path.join(APP_DIR, 'config.json'));
  if (args.has('--diagnose')) return diagnose(config);

  const dryRun = args.has('--dry-run');
  const problems = dryRun ? [] : validateConfig(config);
  const log = createLogger({ file: config.log_file, console: process.stdout.isTTY || dryRun, debug: args.has('--debug') || dryRun });
  if (problems.length) {
    for (const p of problems) { log.error(p); if (!process.stdout.isTTY) console.error(p); }
    return 2;
  }
  if (args.has('--test-discord')) return testDiscord(config);

  const lock = dryRun ? { ok: true, pidFile: '', server: null } : await acquireSingleInstance(config.state_file);
  if (!lock.ok) {
    log.info('soundpad-rpc уже запущен, второй экземпляр не нужен.');
    return 0;
  }

  const soundpad = new SoundpadClient({ pipePath: config.soundpad_pipe, logger: log });
  const createDiscord = dryRun
    ? () => new DryRunDiscord(log)
    : () => new DiscordIpcClient({ clientId: config.client_id, pipePaths: discordPipes(config) });
  const app = new SoundpadPresenceApp({
    config,
    soundpad,
    createDiscord,
    logger: log,
    writeState: dryRun ? null : (state) => writeStateFile(config.state_file, state),
  });

  log.info('soundpad-rpc запущен, опрос каждые ' + config.poll_interval_ms + ' мс' + (dryRun ? ' (dry-run)' : ''));

  let stopping = false;
  let timer = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    log.info('Остановка');
    await app.shutdown();
    try { if (Number(fs.readFileSync(lock.pidFile, 'utf8')) === process.pid) fs.unlinkSync(lock.pidFile); } catch { /* ignore */ }
    if (lock.server) lock.server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);

  const loop = async () => {
    const started = Date.now();
    try {
      await app.tick();
    } catch (err) {
      log.error('Ошибка цикла: ' + (err && err.stack ? err.stack : err));
    }
    if (!stopping) timer = setTimeout(loop, Math.max(100, config.poll_interval_ms - (Date.now() - started)));
  };
  loop();
  return null;
}

// Prints activities instead of sending them (for --dry-run).
class DryRunDiscord {
  constructor(log) {
    this.log = log;
    this.connected = false;
  }
  on() {}
  async connect() { this.connected = true; return { username: 'dry-run' }; }
  async setActivity(activity) { this.log.info('[dry-run] SET_ACTIVITY ' + JSON.stringify(activity)); }
  async clearActivity() { return this.setActivity(null); }
  close() { this.connected = false; }
}

main().then((code) => {
  if (code !== null && code !== undefined) process.exit(code);
}, (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
