'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;

function timestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// Writes to a log file (rotated at 1 MB, one backup) and optionally stdout.
function createLogger({ file = '', console: toConsole = true, debug = false } = {}) {
  let size = 0;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch { file = ''; }
  }

  function write(level, message) {
    const line = timestamp() + ' [' + level + '] ' + message;
    if (toConsole) (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
    if (!file) return;
    try {
      if (size > MAX_LOG_BYTES) {
        fs.renameSync(file, file + '.1');
        size = 0;
      }
      const data = line + '\r\n';
      fs.appendFileSync(file, data, 'utf8');
      size += Buffer.byteLength(data);
    } catch { /* logging must never crash the app */ }
  }

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    debug: (m) => { if (debug) write('DEBUG', m); },
  };
}

module.exports = { createLogger };
