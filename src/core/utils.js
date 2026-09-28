'use strict';

/** 通用工具：文件名清洗 / 日志读写 / 目录清理 / 页面求值。两个下载器共享。 */

const fs = require('fs');
const path = require('path');
const { sleep } = require('./cdp');

/** 把标题变成安全的文件名（保留中文，去掉非法字符）。 */
function sanitize(s, { max = 90 } = {}) {
  return String(s)
    .replace(/[\/\\?%*:|"<>\n\r\t]/g, '_')
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 读取/初始化 JSON 日志（数组）。 */
function loadLog(logFile) {
  if (logFile && fs.existsSync(logFile)) {
    try {
      return JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch (e) {
      /* ignore */
    }
  }
  return [];
}

/** 写回 JSON 日志。 */
function saveLog(logFile, log) {
  if (logFile) fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
}

/** 清空目录（不存在则创建）。 */
function clearDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * 在 page 上执行表达式并返回值。
 * @param {import('./cdp').CDP} page
 * @param {string} expression
 * @param {{awaitPromise?:boolean, timeoutMs?:number}} opts timeoutMs 用于页面卡死时兜底（超时返回 null）
 */
async function evalIn(page, expression, { awaitPromise = false, timeoutMs = 15000 } = {}) {
  const r = await Promise.race([
    page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
    sleep(timeoutMs).then(() => null),
  ]);
  if (!r) return null; // 超时（页面可能仍在导航）
  if (r.exceptionDetails) {
    const desc =
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
    throw new Error('页面执行异常: ' + desc);
  }
  return r.result ? r.result.value : undefined;
}

module.exports = { sanitize, loadLog, saveLog, clearDir, evalIn };
