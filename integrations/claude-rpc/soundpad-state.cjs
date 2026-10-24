'use strict';

// Drop-in helper for claude-rpc (or any other presence app): tells whether
// soundpad-rpc is currently showing a Soundpad activity in Discord.
//
//   const { isSoundpadActive } = require('./soundpad-state.cjs');      // CommonJS
//   import soundpadState from './soundpad-state.cjs';                  // ESM
//   const { isSoundpadActive } = soundpadState;
//
//   if (isSoundpadActive()) { /* switch Claude to Watching or clear it */ }
//
// Reads %LOCALAPPDATA%\soundpad-rpc\state.json written by soundpad-rpc.
// No dependencies, synchronous and cheap (one small file read).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultStateFile(env = process.env) {
  return path.join(env.LOCALAPPDATA || os.tmpdir(), 'soundpad-rpc', 'state.json');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readSoundpadState(file = defaultStateFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// graceMs: how long after the computed end of a sound it still counts as
// active (covers a crashed soundpad-rpc that could not reset the file).
function isSoundpadActive({ file = defaultStateFile(), now = Date.now(), graceMs = 5000, pidAlive = isPidAlive } = {}) {
  const state = readSoundpadState(file);
  if (!state || state.active !== true) return false;
  if (!pidAlive(state.pid)) return false;
  if (typeof state.ends_at === 'number' && now > state.ends_at + graceMs) return false;
  return true;
}

module.exports = { isSoundpadActive, readSoundpadState, defaultStateFile, isPidAlive };
