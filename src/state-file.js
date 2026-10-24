'use strict';

// Small JSON file that tells other programs (claude-rpc) whether Soundpad
// presence is currently shown. Written only when the state changes.

const fs = require('node:fs');
const path = require('node:path');

function buildState({ activity, sample, title, pid = process.pid, now = Date.now() }) {
  const active = Boolean(activity);
  return {
    active,
    status: sample ? sample.status : 'CLOSED',
    title: active ? title || '' : '',
    ends_at: active && activity.timestamps ? activity.timestamps.end : null,
    pid,
    updated_at: now,
  };
}

function writeStateFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { buildState, writeStateFile };
