'use strict';

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Discord local RPC over IPC: frames are [op:int32le][length:int32le][json].
const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

function encodeFrame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

// Incremental decoder: feed() raw chunks, get back complete frames.
class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (len < 0 || len > 64 * 1024 * 1024) throw new Error('Bad Discord IPC frame length ' + len);
      if (this.buffer.length < 8 + len) break;
      const body = this.buffer.subarray(8, 8 + len).toString('utf8');
      this.buffer = this.buffer.subarray(8 + len);
      let data = null;
      try { data = body ? JSON.parse(body) : null; } catch { data = { raw: body }; }
      frames.push({ op, data });
    }
    return frames;
  }
}

function candidatePipePaths(platform = process.platform, env = process.env) {
  const paths = [];
  for (let i = 0; i < 10; i++) {
    if (platform === 'win32') {
      paths.push('\\\\?\\pipe\\discord-ipc-' + i);
    } else {
      const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
      paths.push(path.join(base, 'discord-ipc-' + i));
    }
  }
  return paths;
}

function connectPipe(pipePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timeout connecting to ' + pipePath));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

class DiscordIpcClient extends EventEmitter {
  constructor({ clientId, pipePaths = null, timeoutMs = 5000, pid = process.pid } = {}) {
    super();
    if (!clientId) throw new Error('client_id is not set');
    this.clientId = String(clientId);
    this.pipePaths = pipePaths;
    this.timeoutMs = timeoutMs;
    this.pid = pid;
    this.socket = null;
    this.decoder = null;
    this.waiters = new Map(); // nonce -> { resolve, reject, timer }
    this.user = null;
  }

  get connected() {
    return this.socket !== null && !this.socket.destroyed && this.user !== null;
  }

  async connect() {
    if (this.connected) return this.user;
    const paths = this.pipePaths || candidatePipePaths();
    let lastError = null;
    for (const p of paths) {
      let socket;
      try {
        socket = await connectPipe(p, this.timeoutMs);
      } catch (err) {
        lastError = err;
        continue;
      }
      try {
        return await this._handshake(socket);
      } catch (err) {
        socket.destroy();
        lastError = err;
        // A rejected client id fails on every pipe the same way.
        if (err.code === 'DISCORD_CLOSED') throw err;
      }
    }
    const err = new Error('Discord is not reachable' + (lastError ? ': ' + lastError.message : ''));
    err.code = 'DISCORD_UNAVAILABLE';
    throw err;
  }

  _handshake(socket) {
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Discord handshake timeout'));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onFail);
        socket.removeListener('close', onFail);
      };
      const onFail = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error('Discord closed the pipe during handshake'));
      };
      const onData = (chunk) => {
        let frames;
        try { frames = decoder.feed(chunk); } catch (e) { onFail(e); return; }
        for (const frame of frames) {
          if (frame.op === OP.FRAME && frame.data && frame.data.evt === 'READY') {
            cleanup();
            this._attach(socket, decoder);
            this.user = (frame.data.data && frame.data.data.user) || {};
            resolve(this.user);
            return;
          }
          if (frame.op === OP.CLOSE) {
            const e = new Error('Discord rejected the connection: ' + JSON.stringify(frame.data));
            e.code = 'DISCORD_CLOSED';
            onFail(e);
            return;
          }
        }
      };
      socket.on('data', onData);
      socket.on('error', onFail);
      socket.on('close', onFail);
      socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
  }

  _attach(socket, decoder) {
    this.socket = socket;
    this.decoder = decoder;
    socket.on('data', (chunk) => {
      let frames;
      try { frames = decoder.feed(chunk); } catch (e) { this._drop(e); return; }
      for (const frame of frames) this._onFrame(frame);
    });
    socket.on('error', (err) => this._drop(err));
    socket.on('close', () => this._drop(new Error('Discord pipe closed')));
  }

  _onFrame(frame) {
    if (frame.op === OP.PING) {
      this._write(OP.PONG, frame.data);
      return;
    }
    if (frame.op === OP.CLOSE) {
      this._drop(new Error('Discord closed the connection: ' + JSON.stringify(frame.data)));
      return;
    }
    const data = frame.data || {};
    if (data.nonce && this.waiters.has(data.nonce)) {
      const w = this.waiters.get(data.nonce);
      this.waiters.delete(data.nonce);
      clearTimeout(w.timer);
      if (data.evt === 'ERROR') {
        const e = new Error('Discord error: ' + JSON.stringify(data.data));
        e.code = 'DISCORD_COMMAND_ERROR';
        w.reject(e);
      } else {
        w.resolve(data.data);
      }
    }
  }

  _write(op, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('Discord is not connected');
    this.socket.write(encodeFrame(op, payload));
  }

  request(cmd, args) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.waiters.delete(nonce);
        reject(new Error('Discord did not answer ' + cmd));
      }, this.timeoutMs);
      this.waiters.set(nonce, { resolve, reject, timer });
      try {
        this._write(OP.FRAME, { cmd, args, nonce });
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(nonce);
        reject(e);
      }
    });
  }

  // activity === null clears the presence of this application.
  setActivity(activity) {
    const args = { pid: this.pid };
    if (activity) args.activity = activity;
    return this.request('SET_ACTIVITY', args);
  }

  clearActivity() {
    return this.setActivity(null);
  }

  _drop(err) {
    const wasConnected = this.socket !== null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on('error', () => {});
      this.socket.destroy();
    }
    this.socket = null;
    this.user = null;
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
    if (wasConnected) this.emit('disconnected', err);
  }

  close() {
    this._drop(new Error('closed'));
  }
}

module.exports = { DiscordIpcClient, FrameDecoder, encodeFrame, candidatePipePaths, OP };
