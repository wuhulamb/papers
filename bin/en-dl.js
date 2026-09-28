#!/usr/bin/env node
'use strict';

/**
 * 英文文献批量下载 CLI（Bing/Crossref 定位 + **有头 Chrome** 下载 + pdf-parse 校验）。
 *
 * 为什么用有头 Chrome：curl / 无头 Chrome 访问出版商站点会被 Cloudflare 拦截（403 / Just a moment），
 * 有界面 Chromium + 机构 IP 才能通过；且每次运行默认用**全新 profile**（预写
 * plugins.always_open_pdf_externally=true 让 PDF 直接落盘），避免被反爬指纹标记。
 *
 * 用法：
 *   node bin/en-dl.js --config examples/en-guoqi.json [选项]
 *
 * 选项：
 *   --config <file>   配置文件（默认 ./en.config.json）
 *   --ids 1,2,3       只处理指定 id
 *   --port <n>        调试端口（默认 9336）
 *   --no-bing         不使用 Bing，只用 DOI / Crossref 定位
 *   --keep-chrome     结束后保留启动的 Chrome（便于人工观察/复用）
 *   --profile <dir>   指定 user-data-dir（默认 /tmp/en-headed，每次运行自动重建）
 *   -h, --help        帮助
 */

const fs = require('fs');
const path = require('path');
const { launchHeadedPdf, connectBrowser } = require('../src/core/browser');
const { runPipeline } = require('../src/en/pipeline');

function parseArgs(argv) {
  const a = { port: 9336 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === '--config') a.config = next();
    else if (x === '--ids') a.ids = next();
    else if (x === '--port') a.port = Number(next());
    else if (x === '--no-bing') a.noBing = true;
    else if (x === '--keep-chrome') a.keepChrome = true;
    else if (x === '--profile') a.profile = next();
    else if (x === '-h' || x === '--help') a.help = true;
  }
  return a;
}

function printHelp() {
  console.log(`英文文献批量下载 CLI

用法：
  node bin/en-dl.js --config examples/en-guoqi.json [选项]

选项：
  --config <file>   配置文件（默认 ./en.config.json）
  --ids 1,2,3       只处理指定 id
  --port <n>        调试端口（默认 9336）
  --no-bing         不使用 Bing，只用 DOI / Crossref 定位
  --keep-chrome     结束后保留启动的 Chrome（便于人工观察/复用）
  --profile <dir>   指定 user-data-dir（默认 /tmp/en-headed，每次运行自动重建）
  -h, --help        帮助`);
}

function resolvePath(baseDir, p) {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const configPath = path.resolve(args.config || 'en.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件: ${configPath}（可用 examples/en-guoqi.json 作为模板）`);
  }
  const configDir = path.dirname(configPath);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  let papers = raw.papers || [];
  if (args.ids) {
    const ids = args.ids.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n));
    papers = papers.filter((p) => ids.includes(p.id));
  }
  if (!papers.length) throw new Error('没有可处理的文献（请检查 config.papers 或 --ids）。');

  const config = {
    outputDir: resolvePath(configDir, raw.outputDir || './output'),
    // 注意：下载临时目录必须是 ASCII（Chrome 对非 ASCII 下载路径会回退到默认目录）
    tmpDir: raw.tmpDir || '/tmp/en-paper-dl',
    rejectedDir: raw.rejectedDir || '/tmp/en-paper-rejected',
    logFile: resolvePath(configDir, raw.logFile || './output/download-log.json'),
    paperBudgetMs: raw.paperBudgetMs || 70000,
    downloadTimeoutMs: raw.downloadTimeoutMs || 14000,
    useBing: args.noBing ? false : raw.useBing !== false,
  };

  console.log(`[${stamp()}] 配置: ${configPath}`);
  console.log(`[${stamp()}] 输出: ${config.outputDir}`);
  console.log(`[${stamp()}] 文献: ${papers.length} 篇`);

  // 启动有头 Chrome（每次默认全新 profile，避免反爬指纹残留）
  const userDataDir = args.profile || '/tmp/en-headed';
  console.log(`[${stamp()}] 启动有头 Chrome（端口 ${args.port}, profile ${userDataDir}）…`);
  const child = await launchHeadedPdf({ port: args.port, userDataDir });

  const { browser, pages } = await connectBrowser(args.port, { tabs: 2 });
  const [searchPage, downloadPage] = pages;

  const onEvent = (e) => {
    const t = `[${stamp()}]`;
    switch (e.type) {
      case 'start':
        console.log(`\n${t} === #${e.paper.id} ${e.paper.title} ===`);
        break;
      case 'skip':
        console.log(`${t} [skip] #${e.paper.id}`);
        break;
      case 'doi':
        console.log(`${t}   DOI: ${e.doi} (crossref ${e.crossref.score})`);
        break;
      case 'landing':
        console.log(`${t}   落地页: ${(e.info && e.info.url || '').slice(0, 90)}${e.cloudflare ? ' [Cloudflare]' : ''}`);
        break;
      case 'verify':
        console.log(`${t}   校验 ${e.via}: score=${e.verify.score.toFixed(2)} basis=${e.verify.basis} meta="${(e.verify.metaTitle || '').slice(0, 40)}"`);
        break;
      case 'budget':
        console.log(`${t}   超出单篇时间预算，跳过剩余候选`);
        break;
      case 'success':
        console.log(`${t}   ✅ ${e.file} (${e.bytes} 字节) via ${e.via}`);
        break;
      case 'failed':
        console.log(`${t}   ❌ ${e.reason}`);
        break;
      case 'error':
        console.log(`${t}   ⚠️  ${e.error}`);
        break;
      default:
        break;
    }
  };

  const log = await runPipeline({ browser, searchPage, downloadPage, papers, config, onEvent });

  console.log('\n===== 汇总 =====');
  for (const e of log) {
    const mark = e.status === 'success' ? '✅' : '❌';
    console.log(`${mark} #${e.id} [${e.status || 'pending'}] ${e.title} ${e.file ? '-> ' + e.file : e.reason || ''}`);
  }
  const ok = log.filter((e) => e.status === 'success').length;
  console.log(`\n成功 ${ok} / ${log.length}`);

  browser.close();
  pages.forEach((p) => p.close());
  if (child && !args.keepChrome) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (e) {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});