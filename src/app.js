'use strict';

const P = require('./soundpad-protocol');
const {
  identifySound,
  isNewPlayback,
  isActiveStatus,
  buildActivity,
  activityChanged,
  snapshotOf,
} = require('./presence');
const { buildState } = require('./state-file');

const RATE_WINDOW_MS = 20000;
const RATE_MAX = 5; // Discord allows about 5 presence updates per 20 s
const STRONG_METHODS = new Set(['counter', 'text']);

class SoundpadPresenceApp {
  constructor({ config, soundpad, createDiscord, logger, now = Date.now, writeState = null }) {
    this.config = config;
    this.soundpad = soundpad;
    this.createDiscord = createDiscord;
    this.log = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.now = now;
    this.writeState = writeState;

    this.prevSample = null;
    this.current = null; // { sound, method, category }
    this.snapshot = null;
    this.reidentifyAt = null;
    this.snapshotAt = null;
    this.soundpadUp = null;
    this.textCommands = [P.COMMANDS.titleText, P.COMMANDS.statusBarText];

    this.discord = null;
    this.discordNextTry = 0;
    this.lastSent = undefined; // undefined = unknown, null = cleared
    this.sendTimes = [];
    this.lastStateKey = null;
    this.desired = null;
  }

  async readSample() {
    const at = this.now();
    let statusRaw;
    try {
      statusRaw = await this.soundpad.send(P.COMMANDS.playStatus);
    } catch (err) {
      if (this.soundpadUp !== false) this.log.info('Soundpad недоступен: ' + err.message);
      this.soundpadUp = false;
      this.soundpad.close();
      return null;
    }
    if (this.soundpadUp !== true) this.log.info('Подключено к Soundpad');
    this.soundpadUp = true;

    const status = P.parsePlayStatus(statusRaw);
    if (!status) {
      this.log.warn('Непонятный ответ GetPlayStatus(): ' + JSON.stringify(statusRaw));
      return { status: 'STOPPED', positionMs: null, durationMs: null, at };
    }
    if (!isActiveStatus(status)) return { status, positionMs: null, durationMs: null, at };

    const positionMs = P.parseInteger(await this.soundpad.send(P.COMMANDS.position));
    const durationMs = P.parseInteger(await this.soundpad.send(P.COMMANDS.duration));
    return {
      status,
      positionMs: positionMs !== null && positionMs >= 0 ? positionMs : null,
      durationMs: durationMs !== null && durationMs > 0 ? durationMs : null,
      at,
    };
  }

  // Fills in position/duration that Soundpad did not report.
  completeSample(sample, newPlayback) {
    const prev = this.prevSample;
    if (sample.positionMs === null) {
      if (newPlayback || !prev || prev.positionMs === null) {
        sample.positionMs = 0;
      } else {
        sample.positionMs = prev.positionMs + (prev.status === 'PLAYING' ? sample.at - prev.at : 0);
      }
      sample.positionEstimated = true;
    }
    if (sample.durationMs === null && this.current && this.current.sound) {
      sample.durationMs = this.current.sound.durationMs;
    }
    return sample;
  }

  async identify(sample) {
    let sounds;
    try {
      sounds = P.parseSoundlist(await this.soundpad.send(P.COMMANDS.soundlist));
    } catch (err) {
      this.log.warn('Не удалось получить список звуков: ' + err.message);
      return;
    }
    // Window title / status bar may contain the sound name. Optional: an
    // empty answer never arrives through the pipe, so a command that times
    // out once is not asked again.
    const texts = [];
    for (const cmd of this.textCommands.slice()) {
      try {
        const t = await this.soundpad.send(cmd, { timeoutMs: 400 });
        if (t && P.statusCode(t) === null) texts.push(t);
      } catch {
        this.textCommands = this.textCommands.filter((c) => c !== cmd);
        this.log.debug(cmd + ' не отвечает, больше не спрашиваю');
      }
    }
    const result = identifySound({
      sounds,
      snapshot: this.snapshot,
      durationMs: sample.durationMs,
      current: this.current && this.current.sound,
      texts,
    });
    this.snapshot = snapshotOf(sounds);

    let category = '';
    if (result.sound) {
      try {
        const map = P.parseCategories(await this.soundpad.send(P.COMMANDS.categories));
        category = P.pickCategory(map.get(result.sound.index), this.config.ignored_categories);
      } catch (err) {
        this.log.debug('Категории недоступны: ' + err.message);
      }
    }
    const prevIndex = this.current && this.current.sound ? this.current.sound.index : null;
    this.current = { sound: result.sound, method: result.method, category };
    const newIndex = result.sound ? result.sound.index : null;
    if (newIndex !== prevIndex || this.reidentifyAt === null) {
      this.log.info('Звук: ' + (P.soundDisplayName(result.sound) || '(не определён)') +
        (category ? ' [' + category + ']' : '') + ' (способ: ' + result.method + ')');
    }
  }

  async tick() {
    let sample = await this.readSample();
    const prev = this.prevSample;
    const active = sample && isActiveStatus(sample.status);

    if (active) {
      const newPlayback = isNewPlayback(prev, sample);
      sample = this.completeSample(sample, newPlayback);
      if (newPlayback) {
        await this.identify(sample);
        this.reidentifyAt = STRONG_METHODS.has(this.current && this.current.method) ? null : sample.at + 2500;
        this.snapshotAt = null;
      } else if (this.reidentifyAt !== null && sample.at >= this.reidentifyAt) {
        this.reidentifyAt = null;
        await this.identify(sample);
      }
    } else {
      // Remember play counters while idle, so the next start shows which
      // sound's counter changed.
      if (prev && isActiveStatus(prev.status) && sample) this.snapshotAt = sample.at + 1500;
      else if (sample && !this.snapshot && this.snapshotAt === null) this.snapshotAt = sample.at;
      this.current = null;
      this.reidentifyAt = null;
      if (sample && this.snapshotAt !== null && sample.at >= this.snapshotAt) {
        this.snapshotAt = null;
        try {
          this.snapshot = snapshotOf(P.parseSoundlist(await this.soundpad.send(P.COMMANDS.soundlist)));
        } catch { /* next time */ }
      }
      if (!sample) this.snapshot = null;
    }
    this.prevSample = sample;

    const activity = buildActivity({
      sample,
      sound: this.current && this.current.sound,
      category: this.current && this.current.category,
      config: this.config,
    });
    this.desired = activity;
    this.updateStateFile(activity, sample);
    await this.publish(activity);
    return activity;
  }

  updateStateFile(activity, sample) {
    if (!this.writeState) return;
    const state = buildState({ activity, sample, title: activity ? activity.details : '', now: this.now() });
    const key = JSON.stringify({ ...state, updated_at: 0, ends_at: state.ends_at && Math.round(state.ends_at / 5000) });
    if (key === this.lastStateKey) return;
    try {
      this.writeState(state);
      this.lastStateKey = key;
    } catch (err) {
      this.log.warn('Не удалось записать файл состояния: ' + err.message);
    }
  }

  async ensureDiscord() {
    if (this.discord && this.discord.connected) return true;
    const now = this.now();
    if (now < this.discordNextTry) return false;
    this.discordNextTry = now + this.config.discord_retry_ms;
    if (!this.discord) {
      this.discord = this.createDiscord();
      this.discord.on('disconnected', (err) => {
        this.log.info('Discord отключился: ' + (err && err.message));
        this.lastSent = undefined;
        this.discordNextTry = 0;
      });
    }
    try {
      const user = await this.discord.connect();
      this.log.info('Подключено к Discord' + (user && user.username ? ' как ' + user.username : ''));
      this.lastSent = null; // a fresh connection has no activity of ours
      return true;
    } catch (err) {
      this.log.info('Discord недоступен: ' + err.message);
      if (err.code === 'DISCORD_CLOSED') this.log.error('Проверьте client_id в config.json');
      return false;
    }
  }

  rateLimited() {
    const now = this.now();
    this.sendTimes = this.sendTimes.filter((t) => now - t < RATE_WINDOW_MS);
    return this.sendTimes.length >= RATE_MAX;
  }

  async publish(activity) {
    // Nothing to show and not connected: Discord has nothing of ours anyway.
    if (!activity && !(this.discord && this.discord.connected)) return;
    if (!(await this.ensureDiscord())) return;
    if (!activityChanged(this.lastSent, activity)) return;
    if (this.rateLimited()) return; // retried on the next tick
    try {
      this.sendTimes.push(this.now());
      await this.discord.setActivity(activity);
      this.lastSent = activity;
      this.log.debug(activity ? 'Активность: ' + activity.details + ' / ' + (activity.state || '') : 'Активность убрана');
    } catch (err) {
      this.log.warn('SET_ACTIVITY не удался: ' + err.message);
      if (err.code === 'DISCORD_COMMAND_ERROR') this.lastSent = activity; // do not hammer a rejected payload
    }
  }

  async shutdown() {
    try {
      if (this.writeState) this.writeState(buildState({ activity: null, sample: null, now: this.now() }));
    } catch { /* ignore */ }
    if (this.discord && this.discord.connected) {
      try { await this.discord.clearActivity(); } catch { /* ignore */ }
      this.discord.close();
    }
    this.soundpad.close();
  }
}

module.exports = { SoundpadPresenceApp, RATE_MAX, RATE_WINDOW_MS };
