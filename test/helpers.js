'use strict';

// Fake Soundpad and Discord pipe servers (Unix sockets on Linux/macOS,
// named pipes on Windows) so the I/O code runs in tests without either app.

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { FrameDecoder, encodeFrame, OP } = require('../src/discord-ipc');

let counter = 0;
function socketPath(name) {
  counter++;
  if (process.platform === 'win32') return '\\\\.\\pipe\\soundpad-rpc-test-' + name + '-' + process.pid + '-' + counter;
  const p = path.join(os.tmpdir(), 'sprpc-' + name + '-' + process.pid + '-' + counter + '.sock');
  try { fs.unlinkSync(p); } catch { /* not there */ }
  return p;
}

// handler(command) -> string | string[] (array = send in separate chunks)
function startFakeSoundpad(handler) {
  const pipePath = socketPath('sp');
  const sockets = new Set();
  const received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', async (buf) => {
      const command = buf.toString('utf8');
      received.push(command);
      const answer = await handler(command);
      if (answer === undefined) return; // simulate no answer
      const chunks = Array.isArray(answer) ? answer : [answer];
      for (const c of chunks) {
        socket.write(c);
        await new Promise((r) => setTimeout(r, 5));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(pipePath, () => resolve({
      pipePath,
      received,
      close: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

// Minimal Discord RPC server: answers handshake with READY and every
// command with the same nonce. Records SET_ACTIVITY payloads.
function startFakeDiscord({ rejectHandshake = false, failCommands = false } = {}) {
  const pipePath = socketPath('discord');
  const sockets = new Set();
  const activities = [];
  const handshakes = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.feed(chunk)) {
        if (frame.op === OP.HANDSHAKE) {
          handshakes.push(frame.data);
          if (rejectHandshake) {
            socket.write(encodeFrame(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' }));
            socket.end();
          } else {
            socket.write(encodeFrame(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'alex' } } }));
          }
        } else if (frame.op === OP.FRAME) {
          const { cmd, args, nonce } = frame.data;
          if (cmd === 'SET_ACTIVITY') activities.push(args.activity === undefined ? null : args.activity);
          if (failCommands) {
            socket.write(encodeFrame(OP.FRAME, { cmd, evt: 'ERROR', nonce, data: { code: 4000, message: 'bad' } }));
          } else {
            socket.write(encodeFrame(OP.FRAME, { cmd, evt: null, nonce, data: args.activity || null }));
          }
        } else if (frame.op === OP.PONG) {
          socket.emit('pong', frame.data);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(pipePath, () => resolve({
      pipePath,
      activities,
      handshakes,
      sockets,
      kick: () => { for (const s of sockets) s.destroy(); },
      close: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

module.exports = { startFakeSoundpad, startFakeDiscord, socketPath };
