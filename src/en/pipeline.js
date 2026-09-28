'use strict';

const fs = require('fs');
const path = require('path');
const { sleep } = require('../core/cdp');
const { sanitize, loadLog, saveLog, clearDir } = require('../core/utils');
const { downloadUrl, clickPdfButton } = require('./download');
const { verifyPdf, isMatch } = require('./verify');
const {
  extractPdfLinks,
  crossrefLookup,
  bingSearch,
  bingQueries,
  directPdfUrlsForDoi,
  clickUrlsForDoi,
  scoreUrl,
  isBadHost,
  unBing,
  isCloudflare,
} = require('./search');

/**
 * 批量下载主流程。
 * @param {object} opts
 * @param {import('./cdp').CDP} opts.browser
 * @param {import('./cdp').CDP} opts.searchPage   用于 Bing / Crossref / 落地页解析
 * @param {import('./cdp').CDP} opts.downloadPage 用于实际下载
 * @param {Array}  opts.papers
 * @param {object} opts.config  { outputDir, tmpDir, rejectedDir, logFile, paperBudgetMs, downloadTimeoutMs, useBing }
 * @param {(e:object)=>void} opts.onEvent
 */
async function runPipeline({ browser, searchPage, downloadPage, papers, config, onEvent = () => {} }) {
  const {
    outputDir,
    tmpDir,
    rejectedDir,
    logFile,
    paperBudgetMs = 70000,
    downloadTimeoutMs = 14000,
    useBing = true,
  } = config;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(rejectedDir, { recursive: true });

  const log = loadLog(logFile);
  const persist = () => saveLog(logFile, log);
  const reject = (file, paper) => {
    try {
      fs.copyFileSync(file, path.join(rejectedDir, `${paper.id}_${path.basename(file)}`));
    } catch (e) {
      /* ignore */
    }
  };

  /** 校验 tmpDir 里的 PDF 是否为目标论文；命中则填充 result。 */
  const checkTmpPdf = async (paper) => {
    let files = [];
    try {
      files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.crdownload'));
    } catch (e) {
      return null;
    }
    if (!files.length) return null;
    const fp = path.join(tmpDir, files[0]);
    const buf = fs.readFileSync(fp);
    if (buf.slice(0, 5).toString() !== '%PDF-') return null;
    const v = await verifyPdf(fp, paper.title);
    if (isMatch(v)) return { file: fp, buf, verify: v };
    reject(fp, paper);
    try {
      fs.unlinkSync(fp);
    } catch (e) {
      /* ignore */
    }
    return null;
  };

  for (const paper of papers) {
    let entry = log.find((x) => x.id === paper.id);
    if (!entry) {
      entry = { id: paper.id, title: paper.title, source: paper.source, year: paper.year, doi: paper.doi };
      log.push(entry);
    }
    if (entry.status === 'success' && entry.file && fs.existsSync(path.join(outputDir, entry.file))) {
      onEvent({ type: 'skip', paper });
      continue;
    }
    onEvent({ type: 'start', paper });

    try {
      const deadline = Date.now() + paperBudgetMs;
      let result = null;

      // 0) 补 DOI
      let doi = paper.doi || (entry.doi = entry.doi || null);
      if (!doi) {
        const cr = await crossrefLookup(searchPage, paper.title);
        if (cr && cr.score >= 0.6) {
          doi = cr.doi;
          entry.doi = doi;
          onEvent({ type: 'doi', paper, doi, crossref: cr });
        }
      }

      const tryCandidate = async (url, via) => {
        if (Date.now() > deadline) return false;
        const r = await downloadUrl({ browser, page: downloadPage, url, downloadDir: tmpDir, timeoutMs: downloadTimeoutMs });
        if (!r.ok || !r.buf || r.buf.length < 40000) return false;
        const v = await verifyPdf(r.file, paper.title);
        onEvent({ type: 'verify', paper, via, url, verify: v });
        if (isMatch(v)) {
          result = { via, url, file: r.file, verify: v };
          return true;
        }
        reject(r.file, paper);
        try {
          fs.unlinkSync(r.file);
        } catch (e) {
          /* ignore */
        }
        return false;
      };

      // 1) 出版商 DOI 前缀直链 PDF
      const direct = directPdfUrlsForDoi(doi);
      for (const u of direct) {
        if (await tryCandidate(u, 'direct')) break;
      }

      // 1.5) SAGE 中国镜像：DOI 解析常被 Cloudflare 卡住，直接点镜像页的 PDF 按钮
      if (!result && doi && doi.startsWith('10.1177/')) {
        const cu = `https://sage.cnpereading.com/doi/${doi}`;
        const r = await clickPdfButton({ browser, page: downloadPage, url: cu, downloadDir: tmpDir });
        if (r.ok && r.buf.length >= 40000) {
          const v = await verifyPdf(r.file, paper.title);
          onEvent({ type: 'verify', paper, via: 'sage-mirror', url: cu, verify: v });
          if (isMatch(v)) result = { via: 'sage-mirror', url: cu, file: r.file, verify: v };
          else reject(r.file, paper);
        }
      }

      // 2) DOI 解析落地页：citation_pdf_url / .pdf 链接；也可能直接下到 PDF
      let landingLinks = [];
      if (!result && doi) {
        clearDir(tmpDir);
        await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: tmpDir, eventsEnabled: true });
        const info = await extractPdfLinks(downloadPage, 'https://doi.org/' + doi);
        onEvent({ type: 'landing', paper, info, cloudflare: isCloudflare(info) });
        const direct1 = await checkTmpPdf(paper);
        if (direct1) result = { via: 'landing-direct', url: info && info.url, file: direct1.file, verify: direct1.verify };
        if (!result && info) landingLinks = info.links || [];
      }

      // 3) Bing 候选
      let bingUrls = [];
      if (useBing) {
        for (const q of bingQueries(paper)) {
          if (Date.now() > deadline) break;
          try {
            bingUrls = bingUrls.concat((await bingSearch(searchPage, q)) || []);
          } catch (e) {
            /* ignore */
          }
        }
      }

      const candidates = [...direct, ...landingLinks, ...bingUrls]
        .map(unBing)
        .filter((u) => u && !isBadHost(u));
      const ordered = [...new Set(candidates)].sort((a, b) => scoreUrl(b) - scoreUrl(a));

      for (const u of ordered) {
        if (result) break;
        if (Date.now() > deadline) {
          onEvent({ type: 'budget', paper });
          break;
        }
        if (await tryCandidate(u, 'candidate')) break;
      }

      // 4) 兜底：点击落地页上的 PDF 按钮（如 SAGE 中国镜像）
      if (!result && doi) {
        for (const cu of clickUrlsForDoi(doi)) {
          if (result || Date.now() > deadline + 30000) break;
          const r = await clickPdfButton({ browser, page: downloadPage, url: cu, downloadDir: tmpDir });
          if (r.ok && r.buf.length >= 40000) {
            const v = await verifyPdf(r.file, paper.title);
            onEvent({ type: 'verify', paper, via: 'click-pdf', url: cu, verify: v });
            if (isMatch(v)) result = { via: 'click-pdf', url: cu, file: r.file, verify: v };
            else reject(r.file, paper);
          }
        }
      }

      if (!result) {
        entry.status = 'failed';
        entry.reason = '未找到可验证的开放获取/可访问 PDF（付费墙或 Cloudflare 限制）';
        persist();
        onEvent({ type: 'failed', paper, reason: entry.reason });
        continue;
      }

      const nice = path.join(outputDir, `${paper.id}_${sanitize(paper.title)}.pdf`);
      try {
        fs.renameSync(result.file, nice);
      } catch (e) {
        fs.copyFileSync(result.file, nice);
        fs.unlinkSync(result.file);
      }
      entry.status = 'success';
      entry.file = path.relative(outputDir, nice);
      entry.bytes = fs.statSync(nice).size;
      entry.via = result.via;
      entry.sourceUrl = result.url;
      entry.verify = { score: +result.verify.score.toFixed(2), basis: result.verify.basis, exact: result.verify.exact };
      persist();
      onEvent({ type: 'success', paper, file: nice, bytes: entry.bytes, via: result.via, verify: entry.verify });
      await sleep(600);
    } catch (err) {
      entry.status = 'failed';
      entry.reason = '异常: ' + err.message;
      persist();
      onEvent({ type: 'error', paper, error: err.message });
    }
  }

  persist();
  return log;
}

module.exports = { runPipeline };
