'use strict';

const fs = require('fs');
const path = require('path');
const { sleep } = require('../core/cdp');
const { clearDir } = require('../core/utils');

async function waitForPdf(downloadDir, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(600);
    const files = fs.readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'));
    if (files.length) {
      const fp = path.join(downloadDir, files[0]);
      const buf = fs.readFileSync(fp);
      if (buf.slice(0, 5).toString() === '%PDF-') return { ok: true, file: fp, buf };
    }
  }
  return { ok: false };
}

/**
 * 直接导航到 URL 并等待 Chrome 落盘 PDF。
 * 依赖有头 Chrome 已设置 always_open_pdf_externally=true（见 browser.js 的 launchHeadedPdf）。
 */
async function downloadUrl({ browser, page, url, downloadDir, timeoutMs = 14000 }) {
  clearDir(downloadDir);
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  let nav;
  try {
    nav = await page.send('Page.navigate', { url });
  } catch (e) {
    nav = { errorText: e.message };
  }
  const r = await waitForPdf(downloadDir, timeoutMs);
  if (!r.ok) r.navError = nav && nav.errorText;
  return r;
}

/**
 * 某些站点（如 SAGE 中国镜像）没有直接的 PDF 链接，而是 JS 按钮。
 * 导航后**用 CDP Input 真实点击**文本含 "PDF" 的可见按钮，再等待下载。
 * 注意：合成 dispatchEvent(click) 会被强反爬站点忽略，必须走 Input 真实手势。
 */
async function clickPdfButton({ browser, page, url, downloadDir, timeoutMs = 15000 }) {
  clearDir(downloadDir);
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  // 导航可能挂起，加超时
  await Promise.race([
    page.send('Page.navigate', { url }).catch(() => {}),
    new Promise((r) => setTimeout(r, 12000)),
  ]);
  await sleep(4000);
  try {
    const r = await page.send('Runtime.evaluate', {
      expression: `(function(){
        const els=[...document.querySelectorAll('a,button,div,span')].filter(e=>e.innerText && /pdf/i.test(e.innerText.trim()) && e.innerText.trim().length<40 && e.offsetParent!==null);
        if(!els.length) return null;
        const el=els[els.length-1];
        const r=el.getBoundingClientRect();
        return { x:r.left+r.width/2, y:r.top+r.height/2 };
      })()`,
      returnByValue: true,
      timeout: 8000,
    }).catch(() => null);
    const pos = r && r.result && r.result.value;
    if (pos && typeof pos.x === 'number') {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(80);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 });
    }
  } catch (e) {
    /* ignore */
  }
  return waitForPdf(downloadDir, timeoutMs);
}

module.exports = { clearDir, downloadUrl, clickPdfButton, waitForPdf };
