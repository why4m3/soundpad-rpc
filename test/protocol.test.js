'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/soundpad-protocol');

const soundlistXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'soundlist.xml'), 'utf8');
const categoriesXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'categories.xml'), 'utf8');

test('play status parsing', () => {
  assert.equal(P.parsePlayStatus('PLAYING'), 'PLAYING');
  assert.equal(P.parsePlayStatus('paused\0\0'), 'PAUSED');
  assert.equal(P.parsePlayStatus(' STOPPED \r\n'), 'STOPPED');
  assert.equal(P.parsePlayStatus('SEEKING'), 'SEEKING');
  assert.equal(P.parsePlayStatus('R-500'), null);
  assert.equal(P.parsePlayStatus(''), null);
  assert.equal(P.parsePlayStatus(undefined), null);
});

test('status codes', () => {
  assert.equal(P.statusCode('R-200'), 200);
  assert.equal(P.statusCode('R-404: Not found'), 404);
  assert.equal(P.statusCode('PLAYING'), null);
  assert.equal(P.isErrorResponse('R-200'), false);
  assert.equal(P.isErrorResponse('R-500'), true);
  assert.equal(P.isErrorResponse('12345'), false);
});

test('integer responses', () => {
  assert.equal(P.parseInteger('12345'), 12345);
  assert.equal(P.parseInteger('0\0'), 0);
  assert.equal(P.parseInteger('-1'), -1);
  assert.equal(P.parseInteger('R-400'), null);
  assert.equal(P.parseInteger('12.5'), null);
  assert.equal(P.parseInteger(''), null);
});

test('duration attribute', () => {
  assert.equal(P.parseDurationAttr('0:03'), 3000);
  assert.equal(P.parseDurationAttr('12:34'), 754000);
  assert.equal(P.parseDurationAttr('1:02:03'), 3723000);
  assert.equal(P.parseDurationAttr('2.5'), 2500);
  assert.equal(P.parseDurationAttr(''), null);
  assert.equal(P.parseDurationAttr('abc'), null);
  assert.equal(P.parseDurationAttr(undefined), null);
});

test('date attribute', () => {
  assert.equal(P.parseDateAttr('2026-10-24T09:15:02'), new Date(2026, 9, 24, 9, 15, 2).getTime());
  assert.equal(P.parseDateAttr('2026-10-24 09:15'), new Date(2026, 9, 24, 9, 15, 0).getTime());
  assert.equal(P.parseDateAttr('24.10.2026 09:15:02'), new Date(2026, 9, 24, 9, 15, 2).getTime());
  assert.equal(P.parseDateAttr('1761297302'), 1761297302000);
  assert.equal(P.parseDateAttr(''), null);
  assert.equal(P.parseDateAttr('0'), null);
  assert.equal(P.parseDateAttr('never'), null);
  assert.ok(P.parseDateAttr('2026-10-24T09:15:02.500') > P.parseDateAttr('2026-10-24T09:15:02'));
});

test('file name without extension', () => {
  assert.equal(P.fileNameWithoutExtension('C:\\Sounds\\long.track.ogg'), 'long.track');
  assert.equal(P.fileNameWithoutExtension('C:/a/b/bruh.mp3'), 'bruh');
  assert.equal(P.fileNameWithoutExtension('file:///C:/a/%D0%B7%D0%B2%D1%83%D0%BA.wav'), 'звук');
  assert.equal(P.fileNameWithoutExtension('https://x.y/sound.mp3?x=1'), 'sound');
  assert.equal(P.fileNameWithoutExtension('.hidden'), '.hidden');
  assert.equal(P.fileNameWithoutExtension(''), '');
});

test('soundlist parsing', () => {
  const sounds = P.parseSoundlist(soundlistXml);
  assert.equal(sounds.length, 4);
  const [bruh, horn, long, oh] = sounds;
  assert.equal(bruh.index, 1);
  assert.equal(bruh.fileName, 'bruh');
  assert.equal(bruh.title, '');
  assert.equal(P.soundDisplayName(bruh), 'bruh');
  assert.equal(bruh.durationMs, 3000);
  assert.equal(bruh.playCount, 12);
  assert.equal(horn.title, 'Air Horn & Echo');
  assert.equal(horn.artist, 'DJ');
  assert.equal(P.soundDisplayName(horn), 'Air Horn & Echo');
  assert.equal(long.fileName, 'long.track');
  assert.equal(long.lastPlayedOn, null);
  assert.equal(long.durationMs, 3723000);
  assert.equal(oh.title, 'Оу май');
  assert.equal(oh.lastPlayedOnRaw, '2026-10-23T22:00:00');
});

test('soundlist edge cases', () => {
  assert.deepEqual(P.parseSoundlist('<Soundlist />'), []);
  assert.deepEqual(P.parseSoundlist('<Soundlist></Soundlist>\0'), []);
  const single = P.parseSoundlist("<Soundlist><Sound index='7' url='D:\\x\\a&apos;b.mp3' title='' duration='0:01'/></Soundlist>");
  assert.equal(single.length, 1);
  assert.equal(single[0].index, 7);
  assert.equal(single[0].fileName, "a'b");
  assert.throws(() => P.parseSoundlist('R-500'), /R-500/);
  assert.throws(() => P.parseSoundlist('garbage'), /Unexpected/);
});

test('entities', () => {
  assert.equal(P.decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#1046; &#x416;'), 'a & b <c> "d" Ж Ж');
});

test('categories parsing and picking', () => {
  const map = P.parseCategories(categoriesXml);
  assert.deepEqual(map.get(1).map((c) => c.name), ['All sounds', 'Мемы']);
  assert.deepEqual(map.get(4).map((c) => c.name), ['All sounds', 'Русские мемы']);
  assert.deepEqual(map.get(4)[1].path, ['Мемы', 'Русские мемы']);
  assert.equal(map.get(3).length, 1);

  const ignored = ['All sounds', 'Все звуки'];
  assert.equal(P.pickCategory(map.get(1), ignored), 'Мемы');
  assert.equal(P.pickCategory(map.get(4), ignored), 'Русские мемы');
  assert.equal(P.pickCategory(map.get(2), ignored), 'Эффекты');
  assert.equal(P.pickCategory(map.get(3), ignored), '');
  assert.equal(P.pickCategory(undefined, ignored), '');
  // Without the ignore list the special typed category still loses to a plain one.
  assert.equal(P.pickCategory(map.get(1), []), 'Мемы');
  assert.equal(P.pickCategory(map.get(3), []), 'All sounds');
  assert.throws(() => P.parseCategories('R-404'), /R-404/);
});

test('response completeness for chunked pipe reads', () => {
  assert.equal(P.isResponseComplete('PLAYING'), true);
  assert.equal(P.isResponseComplete(''), false);
  assert.equal(P.isResponseComplete('<Soundlist />'), true);
  assert.equal(P.isResponseComplete('<?xml version="1.0"?>\n<Soundlist>'), false);
  assert.equal(P.isResponseComplete(soundlistXml), true);
  const half = soundlistXml.slice(0, Math.floor(soundlistXml.length / 2));
  assert.equal(P.isResponseComplete(half), false);
  assert.equal(P.isResponseComplete(soundlistXml + '\0'), true);
  assert.equal(P.isResponseComplete(categoriesXml), true);
});
