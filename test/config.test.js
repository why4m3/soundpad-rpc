'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, normalizeConfig, validateConfig, stripJsonComments, DEFAULTS } = require('../src/config');

test('config.example.json is valid and matches the defaults', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8');
  const raw = JSON.parse(stripJsonComments(text));
  for (const key of Object.keys(DEFAULTS)) assert.ok(key in raw, 'missing key ' + key);
  assert.equal(raw.soundpad_pipe, '\\\\.\\pipe\\sp_remote_control');
  assert.equal(raw.poll_interval_ms, 1000);
  assert.equal(raw.activity_type, 2);
});

test('comments are stripped, strings with // are kept', () => {
  const raw = JSON.parse(stripJsonComments('{\n // c\n "a": "http://x", // tail\n "b": "q\\"//"\n}'));
  assert.deepEqual(raw, { a: 'http://x', b: 'q"//' });
});

test('normalization and validation', () => {
  const cfg = normalizeConfig({ client_id: 123456789012345678n.toString(), poll_interval_ms: 5, activity_type: 9, status_display_type: null }, { env: { LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local' } });
  assert.equal(cfg.poll_interval_ms, 250);
  assert.equal(cfg.activity_type, 2);
  assert.equal(cfg.status_display_type, null);
  assert.ok(cfg.state_file.includes('soundpad-rpc'));
  assert.deepEqual(validateConfig(cfg), []);
  assert.equal(validateConfig(normalizeConfig({}, { env: {} })).length, 1);
  assert.match(validateConfig(normalizeConfig({ client_id: 'abc' }, { env: {} }))[0], /цифр/);
});

test('loadConfig creates config.json from the example when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprpc-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '\uFEFF{ "client_id": "123456789012345678", // mine\n "poll_interval_ms": 2000 }');
  const cfg = loadConfig(file);
  assert.equal(cfg.client_id, '123456789012345678');
  assert.equal(cfg.poll_interval_ms, 2000);
  assert.equal(cfg.log_file, path.join(dir, 'soundpad-rpc.log'));
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => loadConfig(file), /config\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});
