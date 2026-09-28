'use strict';

/**
 * 极简 Chrome DevTools Protocol (CDP) 客户端。
 * 仅依赖 Node 内置模块 + 全局 WebSocket（Node >= 20）。
 */

const http = require('http');

/** Promise 版 sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 读取 Chrome 调试端口的 HTTP JSON 接口（/json、/json/version 等）。
 * @param {number} port
 * @param {string} urlPath
 */
function httpJson(port, urlPath = '/json/version', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP HTTP timeout')));
  });
}

/** CDP 客户端：send(method, params) 返回 Promise，on(handler) 订阅事件。 */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._id = 0;
    this._pending = new Map();
    this._handlers = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const p = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else {
          this._handlers.forEach((h) => h(msg));
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(handler) {
    this._handlers.push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = { CDP, httpJson, sleep };
