'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Packaged as a single executable (release build) the app lives next to the
// .exe; from source it is the repository root.
function isPackaged() {
  try { return require('node:sea').isSea(); } catch { return false; }
}
const APP_DIR = isPackaged() ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

const DEFAULTS = Object.freeze({
  client_id: '',
  poll_interval_ms: 1000,
  activity_type: 2, // 2 = Listening ("Слушает")
  status_display_type: 2, // 0 = app name, 1 = state, 2 = details in the member list line
  details: '{title}',
  state: '{category}',
  default_category: 'Soundpad',
  unknown_title: 'Soundpad',
  show_when_paused: true,
  paused_state: 'На паузе',
  large_image: 'soundpad',
  large_text: 'Soundpad',
  small_image_paused: '',
  ignored_categories: ['All sounds', 'Все звуки', 'Alle Sounds'],
  state_file: '',
  log_file: 'soundpad-rpc.log',
  soundpad_pipe: '\\\\.\\pipe\\sp_remote_control',
  discord_pipe: '',
  discord_retry_ms: 15000,
});

function defaultStateFile(env = process.env) {
  const base = env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'soundpad-rpc', 'state.json');
}

function stripJsonComments(text) {
  // Allow "//" line comments in config.json; strings are respected.
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] || ''; continue; }
      if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += c;
    }
  }
  return out;
}

function normalizeConfig(raw, { env = process.env, baseDir = APP_DIR } = {}) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.client_id = String(cfg.client_id || '').trim();
  const interval = Number(cfg.poll_interval_ms);
  cfg.poll_interval_ms = Number.isFinite(interval) ? Math.min(Math.max(Math.round(interval), 250), 60000) : DEFAULTS.poll_interval_ms;
  cfg.activity_type = [0, 2, 3, 5].includes(Number(cfg.activity_type)) ? Number(cfg.activity_type) : 2;
  if (cfg.status_display_type === null || cfg.status_display_type === '') {
    cfg.status_display_type = null;
  } else {
    const sdt = Number(cfg.status_display_type);
    cfg.status_display_type = [0, 1, 2].includes(sdt) ? sdt : null;
  }
  cfg.show_when_paused = cfg.show_when_paused !== false;
  if (!Array.isArray(cfg.ignored_categories)) cfg.ignored_categories = [];
  cfg.state_file = cfg.state_file ? path.resolve(baseDir, cfg.state_file) : defaultStateFile(env);
  cfg.log_file = cfg.log_file ? path.resolve(baseDir, cfg.log_file) : '';
  const retry = Number(cfg.discord_retry_ms);
  cfg.discord_retry_ms = Number.isFinite(retry) && retry >= 1000 ? retry : DEFAULTS.discord_retry_ms;
  return cfg;
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.client_id) problems.push('client_id не задан: впишите Application ID из Discord Developer Portal в config.json');
  else if (!/^\d{15,22}$/.test(cfg.client_id)) problems.push('client_id должен состоять только из цифр (Application ID), сейчас: ' + cfg.client_id);
  return problems;
}

function loadConfig(configPath = path.join(APP_DIR, 'config.json')) {
  if (!fs.existsSync(configPath)) {
    const example = path.join(APP_DIR, 'config.example.json');
    if (fs.existsSync(example)) fs.copyFileSync(example, configPath);
  }
  let raw = {};
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
    try {
      raw = JSON.parse(stripJsonComments(text));
    } catch (e) {
      throw new Error('Не удалось прочитать ' + configPath + ': ' + e.message);
    }
  }
  return normalizeConfig(raw, { baseDir: path.dirname(configPath) });
}

module.exports = { DEFAULTS, APP_DIR, loadConfig, normalizeConfig, validateConfig, stripJsonComments, defaultStateFile };
