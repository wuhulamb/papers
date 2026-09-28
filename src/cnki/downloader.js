'use strict';

const fs = require('fs');
const path = require('path');
const { sleep } = require('../core/cdp');
const { sanitize, loadLog, saveLog, evalIn } = require('../core/utils');
const { CAPTCHA_SOLVER_SOURCE } = require('./captcha');
const {
  buildSearchUrl,
  splitTitleQueries,
  findRowExpr,
  downloadLinksExpr,
  CAPTCHA_PRESENT_EXPR,
} = require('./cnki');

/** 题名归一化，用于精确比对。 */
const normTitle = (s) => String(s || '').replace(/[\s\u00a0]/g, '').replace(/[—–-]/g, '-');

/**
 * 批量下载主流程。
 *
 * @param {object} opts
 * @param {import('../core/cdp').CDP} opts.page    页面级 CDP 连接
 * @param {import('../core/cdp').CDP} opts.browser 浏览器级 CDP 连接
 * @param {Array}  opts.papers   文献列表 [{id,title,authors,source,year}]
 * @param {object} opts.config   {outputDir,tmpDir,logFile,authorFilter,dryRun,downloadTimeoutMs}
 * @param {(e:object)=>void} opts.onEvent 事件回调 {type, ...}
 * @returns {Promise<Array>} 更新后的日志
 */
async function runDownloader({ page, browser, papers, config, onEvent = () => {} }) {
  const {
    authorFilter = '',
    outputDir,
    tmpDir,
    logFile,
    dryRun = false,
    downloadTimeoutMs = 45000,
    delayBetweenMs = 0,
    cooldownEvery = 0,
    cooldownMs = 0,
  } = config;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const log = loadLog(logFile);
  const persist = () => saveLog(logFile, log);

  // 下载事件跟踪
  let downloads = [];
  browser.on((m) => {
    if (m.method === 'Browser.downloadWillBegin') {
      downloads.push({ guid: m.params.guid, name: m.params.suggestedFilename, state: 'begin', t: Date.now() });
    } else if (m.method === 'Browser.downloadProgress') {
      const d = downloads.find((x) => x.guid === m.params.guid);
      if (d) d.state = m.params.state;
    }
  });

  /** 若出现滑块验证则自动求解。 */
  const ensureNotCaptcha = async () => {
    for (let i = 0; i < 5; i++) {
      let st = null;
      try {
        st = await evalIn(page, CAPTCHA_PRESENT_EXPR);
      } catch (e) {
        // 页面正在跳转，稍等后重试
        await sleep(1500);
        continue;
      }
      if (st && st.has) {
        onEvent({ type: 'captcha', message: '检测到安全验证，正在求解…' });
        try {
          const res = await evalIn(page, CAPTCHA_SOLVER_SOURCE, { awaitPromise: true });
          onEvent({ type: 'captcha-result', result: res });
        } catch (e) {
          // 验证成功后页面会跳转，使这次 evaluate 报错，属正常现象
          onEvent({ type: 'captcha-result', message: '求解后页面跳转（正常）', error: e.message });
        }
        await sleep(3000);
      } else {
        return true;
      }
    }
    try {
      const st = await evalIn(page, CAPTCHA_PRESENT_EXPR);
      return !(st && st.has);
    } catch (e) {
      return true;
    }
  };

  /** 等待临时目录出现已下载文件（或下载事件完成）。 */
  const waitForDownload = async (startMs, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(700);
      const done = downloads.find((d) => d.state === 'completed' && d.t >= startMs - 1000);
      if (done) return done;
      const canceled = downloads.find((d) => d.state === 'canceled' && d.t >= startMs - 1000);
      if (canceled && Date.now() - t0 > 5000) return { canceled: true };
      try {
        const files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.crdownload'));
        if (files.length) return { file: files[0] };
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  };

  const clearTmp = () => {
    for (const f of fs.readdirSync(tmpDir)) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch (e) {
        /* ignore */
      }
    }
  };

  let processed = 0;
  for (const paper of papers) {
    const baseName = `${paper.id}_${sanitize(paper.title)}`;
    let entry = log.find((x) => x.id === paper.id);
    if (!entry) {
      entry = {
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        source: paper.source,
        year: paper.year,
      };
      log.push(entry);
    }

    if (entry.status === 'success' && entry.file && fs.existsSync(path.join(outputDir, entry.file))) {
      onEvent({ type: 'skip', paper, reason: '已下载' });
      continue;
    }
    // 平铺式输出：outputDir/<id>_<题名>.<ext>，不建子目录
    const existing = fs.readdirSync(outputDir).find((f) => f.startsWith(`${paper.id}_`) && !f.endsWith('.crdownload'));
    if (existing) {
      entry.status = 'success';
      entry.file = existing;
      persist();
      onEvent({ type: 'skip', paper, reason: '输出目录已存在文件' });
      continue;
    }
    // 限速：篇间延时 / 定期冷却，降低触发知网风控的概率
    processed++;
    if (processed > 1) {
      if (cooldownEvery && (processed - 1) % cooldownEvery === 0 && cooldownMs) {
        onEvent({ type: 'cooldown', ms: cooldownMs });
        await sleep(cooldownMs);
      } else if (delayBetweenMs) {
        await sleep(delayBetweenMs);
      }
    }
    onEvent({ type: 'start', paper });

    try {
      // 1) 篇名检索（完整题名 -> 主标题回退）
      const searchPaper = async (q) => {
        await page.send('Page.navigate', { url: buildSearchUrl(q) });
        await sleep(3500);
        await ensureNotCaptcha();
        for (let i = 0; i < 15; i++) {
          const r = await evalIn(page, findRowExpr(q));
          if (r && r.found) return r;
          if (r && r.bodyText && /共找到\s*0\s*条/.test(r.bodyText)) break;
          await sleep(1500);
          await ensureNotCaptcha();
        }
        return null;
      };

      let row = null;
      for (const q of splitTitleQueries(paper.title)) {
        row = await searchPaper(q);
        if (row) {
          onEvent({ type: 'matched', paper, query: q, row });
          break;
        }
      }
      if (!row) {
        entry.status = 'failed';
        entry.reason = '未在检索结果中找到匹配记录';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }
      entry.matchedTitle = row.title;
      entry.matchedAuthors = row.authors;
      entry.articleHref = row.articleHref;

      if (authorFilter && !String(row.authors).includes(authorFilter)) {
        // 知网结果只显示前几位作者，多作者论文可能被截断；题名精确匹配时放行
        const exactTitle = normTitle(row.title) === normTitle(paper.title);
        if (!exactTitle) {
          entry.status = 'failed';
          entry.reason = '作者不匹配: ' + row.authors;
          persist();
          onEvent({ type: 'failed', paper, reason: entry.reason });
          continue;
        }
      }

      if (dryRun) {
        entry.status = 'matched';
        delete entry.reason;
        persist();
        onEvent({ type: 'dry-run', paper, row });
        continue;
      }

      // 2) 打开知网文章页，提取 PDF/CAJ 下载链接
      let dlHref = null;
      let dlKind = null;
      const referrer = buildSearchUrl(paper.title);
      await page.send('Page.navigate', { url: row.articleHref, referrer });
      await sleep(4000);
      await ensureNotCaptcha();
      for (let i = 0; i < 10 && !dlHref; i++) {
        const links = await evalIn(page, downloadLinksExpr());
        if (links && (links.pdf || links.caj)) {
          if (links.pdf) {
            dlHref = links.pdf;
            dlKind = 'PDF';
          } else {
            dlHref = links.caj;
            dlKind = 'CAJ';
          }
          break;
        }
        await sleep(1500);
        await ensureNotCaptcha();
      }
      if (!dlHref) {
        entry.status = 'failed';
        entry.reason = '该条目在知网无下载按钮（可能无权限或无全文）';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }
      entry.downloadHref = dlHref;
      entry.format = dlKind;
      onEvent({ type: 'download-link', paper, kind: dlKind, href: dlHref });

      // 3) 通过下载行为 + 导航到下载链接完成下载（附 referrer 以通过防盗链）
      downloads = [];
      clearTmp();
      await browser.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: tmpDir,
        eventsEnabled: true,
      });
      const startMs = Date.now();
      const nav = await page.send('Page.navigate', { url: dlHref, referrer: row.articleHref });
      entry.isDownload = !!nav.isDownload;

      const dl = await waitForDownload(startMs, downloadTimeoutMs);
      await ensureNotCaptcha();
      if (!dl) {
        entry.status = 'failed';
        entry.reason = '下载未开始或超时（可能需要登录/权限或触发验证）';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }
      if (dl.canceled && !dl.file) {
        entry.status = 'failed';
        entry.reason = '下载被取消';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }

      let files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.crdownload'));
      if (!files.length) {
        await sleep(3000);
        files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.crdownload'));
      }
      if (!files.length) {
        entry.status = 'failed';
        entry.reason = '下载完成但未找到文件';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }

      const raw = path.join(tmpDir, files[0]);
      const ext = path.extname(files[0]) || '.pdf';
      const nice = path.join(outputDir, `${paper.id}_${sanitize(paper.title)}${ext}`);
      try {
        fs.renameSync(raw, nice);
      } catch (e) {
        fs.copyFileSync(raw, nice);
        fs.unlinkSync(raw);
      }
      entry.status = 'success';
      entry.file = path.relative(outputDir, nice);
      entry.bytes = fs.statSync(nice).size;
      delete entry.reason;
      persist();
      onEvent({ type: 'success', paper, file: nice, bytes: entry.bytes });
      await sleep(2500);
    } catch (err) {
      entry.status = 'failed';
      entry.reason = '异常: ' + err.message;
      persist();
      onEvent({ type: 'error', paper, error: err.message });
      await sleep(2000);
    }
  }

  persist();
  return log;
}

module.exports = { runDownloader };