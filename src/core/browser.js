'use strict';

/**
 * Chrome 启动 / 端口发现 / CDP 页面连接。
 * 由 CNKI 与英文文献两个下载器共享。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CDP, httpJson, sleep } = require('./cdp');

/** 判断某个调试端口上的 Chrome 是否可用。 */
async function isAlive(port, host = '127.0.0.1') {
  try {
    await httpJson(port, '/json/version', host);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 自动发现本机 Chrome 调试端口：
 *   1) 显式传入；
 *   2) 环境变量 CHROME_DEBUG_PORT；
 *   3) 常见 profile 目录下的 DevToolsActivePort 文件；
 *   4) 默认 9222。
 */
async function discoverPort(explicit) {
  if (explicit) return Number(explicit);
  if (process.env.CHROME_DEBUG_PORT) return Number(process.env.CHROME_DEBUG_PORT);

  const candidates = [];
  try {
    for (const d of fs.readdirSync('/tmp')) {
      if (d.startsWith('pi-chrome-devtools-profile-') || d.startsWith('cnki-chrome')) {
        candidates.push(path.join('/tmp', d, 'DevToolsActivePort'));
      }
    }
  } catch (e) {
    /* ignore */
  }
  const home = process.env.HOME || os.homedir();
  candidates.push(path.join(home, 'chromium-profile', 'DevToolsActivePort'));
  candidates.push('/home/node/chromium-profile/DevToolsActivePort');

  for (const f of candidates) {
    try {
      const port = parseInt(fs.readFileSync(f, 'utf8').split('\n')[0], 10);
      if (port && (await isAlive(port))) return port;
    } catch (e) {
      /* ignore */
    }
  }
  if (await isAlive(9222)) return 9222;
  throw new Error(
    '未找到可用的 Chrome 调试端口。请用 --port 指定，或设置 CHROME_DEBUG_PORT，或使用 --launch 启动。'
  );
}

/** 在常见位置寻找 Chromium/Chrome 可执行文件。 */
function findChromeBin() {
  const cands = [
    process.env.CHROME_BIN,
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (e) {
      /* ignore */
    }
  }
  throw new Error('未找到 Chromium/Chrome 可执行文件，请设置 CHROME_BIN。');
}

/**
 * 启动一个带调试端口的 Chrome（默认有界面，便于人工处理验证码）。
 * 返回子进程，并等待端口就绪。
 * @param {{port?:number, userDataDir?:string, headless?:boolean, proxy?:string}} opts
 *   proxy 形如 socks5://127.0.0.1:1080，走代理（用于访问被墙站点）；undefined 则直连。
 */
async function launchChrome({ port = 9222, userDataDir = '/tmp/cnki-chrome', headless = false, proxy } = {}) {
  const bin = findChromeBin();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  if (proxy) args.unshift(`--proxy-server=${proxy}`);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await isAlive(port)) return child;
    await sleep(250);
  }
  throw new Error(`Chrome 已在 ${port} 启动，但调试端口未就绪。`);
}

/**
 * 启动一个"PDF 直接落盘"的**有头** Chrome（英文文献下载用）。
 *
 * 为什么有头：curl / 无头 Chrome 访问出版商站点会被 Cloudflare 拦截（403 / Just a moment），
 * 有界面 Chromium + 机构 IP 才能通过；且英文文献下载在有机构订阅时依赖真实浏览器会话。
 * 为什么全新 profile：Chrome 启动后会重写 Preferences，`always_open_pdf_externally` 等字段
 * 只有在 profile 首次启动前写入才会被保留；且每次任务用干净 profile 可避免被
 * Cloudflare 按浏览器指纹逐步标记。
 *
 * 关键点：必须在 profile 首次启动前写入 Preferences
 * （plugins.always_open_pdf_externally=true，否则 PDF 会被内置阅读器打开而不是落盘）。
 * 默认每次调用都会重建 /tmp/en-headed（每组任务新 profile），可用 userDataDir 指定复用。
 */
async function launchHeadedPdf({ port = 9336, userDataDir = '/tmp/en-headed', downloadDir = '/tmp/en-paper-dl', proxy } = {}) {
  // 每次默认重建 profile，保证 Preferences 预写 + 无风控指纹残留
  if (String(userDataDir).startsWith('/tmp/en-headed')) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const prefs = {
    plugins: { always_open_pdf_externally: true },
    download: { prompt_for_download: false, default_directory: downloadDir },
  };
  fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify(prefs));

  const bin = findChromeBin();
  const args = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--window-size=1200,900',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  if (proxy) args.unshift(`--proxy-server=${proxy}`);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await isAlive(port)) return child;
    await sleep(250);
  }
  throw new Error(`Chrome 已在 ${port} 启动，但调试端口未就绪。`);
}

/**
 * 连接浏览器并创建 `tabs` 个 page 目标。
 * `newTab: false` 时优先复用现有标签页（不足再新建）。
 * @returns {Promise<{browser: CDP, pages: CDP[]}>}
 */
async function connectBrowser(port, { tabs = 1, newTab = true } = {}) {
  const version = await httpJson(port, '/json/version');
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect();

  const pages = [];
  if (!newTab) {
    const list = await httpJson(port, '/json');
    for (const t of list.filter((x) => x.type === 'page').slice(0, tabs)) {
      const p = new CDP(t.webSocketDebuggerUrl);
      await p.connect();
      await p.send('Page.enable');
      pages.push(p);
    }
  }
  while (pages.length < tabs) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    await sleep(400);
    const list = await httpJson(port, '/json');
    const t = list.find((x) => x.id === targetId) || list.find((x) => x.type === 'page');
    const p = new CDP(t.webSocketDebuggerUrl);
    await p.connect();
    await p.send('Page.enable');
    pages.push(p);
  }
  return { browser, pages };
}

module.exports = { isAlive, discoverPort, findChromeBin, launchChrome, launchHeadedPdf, connectBrowser };
