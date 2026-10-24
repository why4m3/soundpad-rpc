'use strict';

const net = require('node:net');
const { cleanResponse, isResponseComplete } = require('./soundpad-protocol');

const DEFAULT_PIPE = '\\\\.\\pipe\\sp_remote_control';

// Keeps one connection to Soundpad's named pipe and sends commands one at a
// time (the protocol has no request ids, so requests must not overlap).
class SoundpadClient {
  constructor({ pipePath = DEFAULT_PIPE, timeoutMs = 3000, quietMs = 150, logger = null } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.quietMs = quietMs;
    this.logger = logger;
    this.socket = null;
    this.connecting = null;
    this.queue = Promise.resolve();
    this.pending = null;
  }

  get connected() {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.pipePath);
      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        socket.setNoDelay && socket.setNoDelay(true);
        socket.on('data', (chunk) => { if (this.socket === socket) this._onData(chunk); });
        socket.on('error', (err) => { if (this.socket === socket) this._onClose(err); });
        socket.on('close', () => { if (this.socket === socket) this._onClose(new Error('Soundpad pipe closed')); });
        this.socket = socket;
        resolve();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close() {
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.removeAllListeners();
      s.on('error', () => {});
      s.destroy();
    }
    this._failPending(new Error('Soundpad client closed'));
  }

  // Sends a command and resolves with the cleaned text response.
  send(command, { timeoutMs = this.timeoutMs } = {}) {
    const run = () => this._sendNow(command, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _sendNow(command, timeoutMs) {
    await this.connect();
    if (!this.connected) throw new Error('Soundpad pipe is not connected');
    return new Promise((resolve, reject) => {
      const pending = { command, chunks: [], resolve, reject, quietTimer: null, timer: null };
      pending.timer = setTimeout(() => {
        // A partial answer is still better than nothing for scalar replies.
        const text = Buffer.concat(pending.chunks).toString('utf8');
        if (text && !text.trim().startsWith('<')) {
          this._finish(pending, null, cleanResponse(text));
        } else {
          this._finish(pending, new Error('Soundpad did not answer ' + command + ' in ' + timeoutMs + ' ms'));
          // A late answer would be taken for the next command: start clean.
          this.close();
        }
      }, timeoutMs);
      this.pending = pending;
      this.socket.write(command, 'utf8', (err) => {
        if (err) this._finish(pending, err);
      });
    });
  }

  _onData(chunk) {
    const pending = this.pending;
    if (!pending) return; // unsolicited data, ignore
    pending.chunks.push(chunk);
    const text = Buffer.concat(pending.chunks).toString('utf8');
    clearTimeout(pending.quietTimer);
    if (isResponseComplete(text)) {
      this._finish(pending, null, cleanResponse(text));
    } else if (!text.trim().startsWith('<')) {
      // Empty or odd answer: wait briefly for more, then accept what we have.
      pending.quietTimer = setTimeout(() => this._finish(pending, null, cleanResponse(text)), this.quietMs);
    }
  }

  _finish(pending, err, value) {
    if (this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.quietTimer);
    if (err) pending.reject(err);
    else pending.resolve(value);
  }

  _failPending(err) {
    if (this.pending) this._finish(this.pending, err);
  }

  _onClose(err) {
    this._failPending(err);
    this.close();
  }
}

module.exports = { SoundpadClient, DEFAULT_PIPE };
