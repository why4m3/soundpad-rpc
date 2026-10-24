'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SoundpadClient } = require('../src/soundpad-client');
const { DiscordIpcClient, FrameDecoder, encodeFrame, candidatePipePaths, OP } = require('../src/discord-ipc');
const { startFakeSoundpad, startFakeDiscord, socketPath } = require('./helpers');

const soundlistXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'soundlist.xml'), 'utf8');

test('frame encoder/decoder handles split and merged chunks', () => {
  const a = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: '1', args: { x: 'звук' } });
  const b = encodeFrame(OP.PING, { n: 2 });
  assert.equal(a.readInt32LE(0), 1);
  assert.equal(a.readInt32LE(4), a.length - 8);
  const all = Buffer.concat([a, b]);
  const d = new FrameDecoder();
  const frames = [];
  for (let i = 0; i < all.length; i += 7) frames.push(...d.feed(all.subarray(i, i + 7)));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.args.x, 'звук');
  assert.equal(frames[1].op, OP.PING);
  assert.throws(() => new FrameDecoder().feed(Buffer.from([1, 0, 0, 0, 255, 255, 255, 255])), /length/);
});

test('discord pipe candidates', () => {
  const win = candidatePipePaths('win32', {});
  assert.equal(win.length, 10);
  assert.equal(win[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(candidatePipePaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })[3], '/run/user/1000/discord-ipc-3');
});

test('soundpad client: sequential commands, chunked XML, reconnect', async () => {
  const half = Math.floor(soundlistXml.length / 3);
  const server = await startFakeSoundpad((cmd) => {
    if (cmd === 'GetPlayStatus()') return 'PLAYING\0';
    if (cmd === 'GetPlaybackPositionInMs()') return '1234';
    if (cmd === 'GetSoundlist()') return [soundlistXml.slice(0, half), soundlistXml.slice(half, 2 * half), soundlistXml.slice(2 * half)];
    return 'R-400';
  });
  const client = new SoundpadClient({ pipePath: server.pipePath, timeoutMs: 1000 });
  try {
    const results = await Promise.all([
      client.send('GetPlayStatus()'),
      client.send('GetSoundlist()'),
      client.send('GetPlaybackPositionInMs()'),
      client.send('Nope()'),
    ]);
    assert.equal(results[0], 'PLAYING');
    assert.equal(results[1], soundlistXml.trim());
    assert.equal(results[2], '1234');
    assert.equal(results[3], 'R-400');
    assert.deepEqual(server.received, ['GetPlayStatus()', 'GetSoundlist()', 'GetPlaybackPositionInMs()', 'Nope()']);

    // Soundpad closed: the next command fails fast instead of hanging.
    await server.close();
    await assert.rejects(client.send('GetPlayStatus()'));
  } finally {
    client.close();
  }
});

test('soundpad client: not running and silent server', async () => {
  const missing = new SoundpadClient({ pipePath: socketPath('missing'), timeoutMs: 300 });
  await assert.rejects(missing.send('GetPlayStatus()'));
  missing.close();

  const server = await startFakeSoundpad(() => undefined);
  const client = new SoundpadClient({ pipePath: server.pipePath, timeoutMs: 200 });
  await assert.rejects(client.send('GetPlayStatus()'), /did not answer/);
  client.close();
  await server.close();
});

test('soundpad client: reconnects after Soundpad restarts', async () => {
  let server = await startFakeSoundpad(() => 'STOPPED');
  const pipePath = server.pipePath;
  const client = new SoundpadClient({ pipePath, timeoutMs: 500 });
  assert.equal(await client.send('GetPlayStatus()'), 'STOPPED');
  await server.close();
  await assert.rejects(client.send('GetPlayStatus()'));
  client.close();
  // same path again
  const net = require('node:net');
  try { fs.unlinkSync(pipePath); } catch { /* windows */ }
  const srv = net.createServer((s) => s.on('data', () => s.write('PLAYING')));
  await new Promise((r) => srv.listen(pipePath, r));
  assert.equal(await client.send('GetPlayStatus()'), 'PLAYING');
  client.close();
  await new Promise((r) => srv.close(r));
});

test('discord client: handshake, set and clear activity, ping', async () => {
  const fake = await startFakeDiscord();
  const client = new DiscordIpcClient({ clientId: '123456789012345678', pipePaths: [socketPath('none'), fake.pipePath], timeoutMs: 1000, pid: 42 });
  try {
    const user = await client.connect();
    assert.equal(user.username, 'alex');
    assert.deepEqual(fake.handshakes, [{ v: 1, client_id: '123456789012345678' }]);
    await client.setActivity({ type: 2, details: 'x1' });
    await client.clearActivity();
    assert.deepEqual(fake.activities, [{ type: 2, details: 'x1' }, null]);

    const [socket] = fake.sockets;
    const pong = new Promise((r) => socket.once('pong', r));
    socket.write(encodeFrame(OP.PING, { hello: 1 }));
    assert.deepEqual(await pong, { hello: 1 });

    const dropped = new Promise((r) => client.once('disconnected', r));
    fake.kick();
    await dropped;
    assert.equal(client.connected, false);
    await assert.rejects(client.setActivity({ type: 2, details: 'zz' }));
    await client.connect(); // reconnects
    assert.equal(client.connected, true);
  } finally {
    client.close();
    await fake.close();
  }
});

test('discord client: rejected client id and command errors', async () => {
  const bad = await startFakeDiscord({ rejectHandshake: true });
  const c1 = new DiscordIpcClient({ clientId: '1', pipePaths: [bad.pipePath], timeoutMs: 1000 });
  await assert.rejects(c1.connect(), (e) => e.code === 'DISCORD_CLOSED');
  await bad.close();

  const failing = await startFakeDiscord({ failCommands: true });
  const c2 = new DiscordIpcClient({ clientId: '1', pipePaths: [failing.pipePath], timeoutMs: 1000 });
  await c2.connect();
  await assert.rejects(c2.setActivity({ type: 2 }), (e) => e.code === 'DISCORD_COMMAND_ERROR');
  c2.close();
  await failing.close();

  const none = new DiscordIpcClient({ clientId: '1', pipePaths: [socketPath('x')], timeoutMs: 300 });
  await assert.rejects(none.connect(), (e) => e.code === 'DISCORD_UNAVAILABLE');
  assert.throws(() => new DiscordIpcClient({}), /client_id/);
});
