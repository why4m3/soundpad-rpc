'use strict';

// Pure parsing helpers for the Soundpad Remote Control API.
// No I/O here, so everything is covered by tests without a real Soundpad.
//
// Protocol summary (Soundpad Remote Control, pipe \\.\pipe\sp_remote_control):
//   request:  plain text command, e.g. "GetPlayStatus()"
//   response: plain text value ("PLAYING", "12345", XML) or a status code
//             "R-200" (ok), "R-400"/"R-404"/"R-500"... on errors.

const PLAY_STATUSES = ['STOPPED', 'PLAYING', 'PAUSED', 'SEEKING'];

const COMMANDS = Object.freeze({
  isAlive: 'IsAlive()',
  playStatus: 'GetPlayStatus()',
  position: 'GetPlaybackPositionInMs()',
  duration: 'GetPlaybackDurationInMs()',
  soundlist: 'GetSoundlist()',
  categories: 'GetCategories(true, false)',
  titleText: 'GetTitleText()',
  statusBarText: 'GetStatusBarText()',
  version: 'GetVersion()',
  remoteControlVersion: 'GetRemoteControlVersion()',
});

function cleanResponse(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\0+$/g, '').replace(/^\uFEFF/, '').trim();
}

// "R-200" style status codes. Returns the numeric code or null.
function statusCode(raw) {
  const m = /^R-(\d{3})\b/.exec(cleanResponse(raw));
  return m ? Number(m[1]) : null;
}

function isErrorResponse(raw) {
  const code = statusCode(raw);
  return code !== null && code !== 200;
}

function parsePlayStatus(raw) {
  const text = cleanResponse(raw).toUpperCase();
  return PLAY_STATUSES.includes(text) ? text : null;
}

// Integer responses (position/duration in ms). Returns null when invalid.
function parseInteger(raw) {
  const text = cleanResponse(raw);
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// Soundlist "duration" attribute: "0:03", "12:34", "1:02:03", or plain seconds.
function parseDurationAttr(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return Math.round(seconds * 1000);
}

// Dates in the soundlist ("addedOn", "lastPlayedOn"). The exact format is not
// documented, so accept ISO-like strings, "dd.mm.yyyy hh:mm:ss" and epoch
// numbers. Returns epoch ms or null.
function parseDateAttr(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === '0') return null;
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(text);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), msPart(m[7])).getTime();
  }
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function msPart(frac) {
  if (!frac) return 0;
  return Math.round(Number('0.' + frac) * 1000);
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, ent) => {
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        try { return String.fromCodePoint(code); } catch { return all; }
      }
    }
  });
}

function parseAttributes(attrText) {
  const attrs = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

// Minimal tag tokenizer: enough for Soundpad's attribute-only XML.
function* iterateTags(xml) {
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    yield { closing: m[1] === '/', name: m[2], attrs: parseAttributes(m[3]), selfClosing: m[4] === '/' };
  }
}

function fileNameWithoutExtension(pathOrUrl) {
  if (!pathOrUrl) return '';
  let text = String(pathOrUrl);
  if (/^file:\/\//i.test(text)) {
    try { text = decodeURIComponent(text.replace(/^file:\/+/i, '')); } catch { /* keep raw */ }
  }
  text = text.replace(/[?#].*$/, '');
  const base = text.split(/[\\/]/).filter(Boolean).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function toSound(attrs) {
  const index = parseInteger(attrs.index !== undefined ? attrs.index : attrs.id);
  const playCount = parseInteger(attrs.playCount);
  return {
    index,
    url: attrs.url || '',
    title: (attrs.title || '').trim(),
    artist: (attrs.artist || '').trim(),
    fileName: fileNameWithoutExtension(attrs.url),
    durationMs: parseDurationAttr(attrs.duration),
    addedOn: parseDateAttr(attrs.addedOn),
    lastPlayedOnRaw: attrs.lastPlayedOn || '',
    lastPlayedOn: parseDateAttr(attrs.lastPlayedOn),
    playCount: playCount === null ? 0 : playCount,
  };
}

// GetSoundlist() -> array of sounds (empty array for an empty list).
// Throws on an error status code or a non-XML answer.
function parseSoundlist(raw) {
  const xml = cleanResponse(raw);
  if (statusCode(xml) !== null) throw new Error('Soundpad returned ' + xml + ' for GetSoundlist()');
  if (!xml.startsWith('<')) throw new Error('Unexpected GetSoundlist() response: ' + xml.slice(0, 80));
  const sounds = [];
  for (const tag of iterateTags(xml)) {
    if (!tag.closing && tag.name === 'Sound') {
      const sound = toSound(tag.attrs);
      if (sound.index !== null) sounds.push(sound);
    }
  }
  return sounds;
}

// GetCategories(true, false) -> Map(soundIndex -> [category, ...]) where each
// category is { name, path: [names from the root], type }.
function parseCategories(raw) {
  const xml = cleanResponse(raw);
  if (statusCode(xml) !== null) throw new Error('Soundpad returned ' + xml + ' for GetCategories()');
  if (!xml.startsWith('<')) throw new Error('Unexpected GetCategories() response: ' + xml.slice(0, 80));
  const bySound = new Map();
  const stack = [];
  for (const tag of iterateTags(xml)) {
    if (tag.name === 'Category') {
      if (tag.closing) {
        stack.pop();
      } else {
        const category = {
          name: (tag.attrs.name || '').trim(),
          type: tag.attrs.type !== undefined ? tag.attrs.type : null,
          hidden: tag.attrs.hidden === 'true',
          path: stack.map((c) => c.name).concat((tag.attrs.name || '').trim()),
        };
        if (!tag.selfClosing) stack.push(category);
      }
    } else if (tag.name === 'Sound' && !tag.closing && stack.length) {
      const index = parseInteger(tag.attrs.index !== undefined ? tag.attrs.index : tag.attrs.id);
      if (index === null) continue;
      const current = stack[stack.length - 1];
      if (!bySound.has(index)) bySound.set(index, []);
      bySound.get(index).push({ name: current.name, path: current.path.slice(), type: current.type, hidden: current.hidden });
    }
  }
  return bySound;
}

// Picks the most specific "real" category for a sound: skips ignored names
// (e.g. "All sounds") and categories with a special type attribute when
// a plain one exists.
function pickCategory(categories, ignoredNames = []) {
  if (!categories || !categories.length) return '';
  const ignored = new Set(ignoredNames.map((n) => n.toLowerCase()));
  const usable = categories.filter((c) => c.name && !ignored.has(c.name.toLowerCase()));
  if (!usable.length) return '';
  const plain = usable.filter((c) => c.type === null || c.type === '0');
  const pool = plain.length ? plain : usable;
  pool.sort((a, b) => b.path.length - a.path.length);
  return pool[0].name;
}

// Decides whether a chunk of response text is complete. Scalar answers come
// in one message; long XML lists may be split into several pipe reads.
function isResponseComplete(text) {
  const t = cleanResponse(text);
  if (!t) return false;
  if (t[0] !== '<') return true;
  const body = t.replace(/^<\?xml[^>]*\?>\s*/i, '');
  const m = /^<([A-Za-z_][\w.-]*)/.exec(body);
  if (!m) return false;
  const root = m[1];
  const firstTagEnd = body.indexOf('>');
  if (firstTagEnd !== -1 && body[firstTagEnd - 1] === '/') return true;
  return body.endsWith('</' + root + '>');
}

function soundDisplayName(sound) {
  if (!sound) return '';
  return sound.title || sound.fileName || '';
}

module.exports = {
  COMMANDS,
  PLAY_STATUSES,
  cleanResponse,
  statusCode,
  isErrorResponse,
  parsePlayStatus,
  parseInteger,
  parseDurationAttr,
  parseDateAttr,
  parseSoundlist,
  parseCategories,
  pickCategory,
  isResponseComplete,
  fileNameWithoutExtension,
  soundDisplayName,
  decodeEntities,
};
