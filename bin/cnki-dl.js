#!/usr/bin/env node
'use strict';

/**
 * CNKI 批量下载 CLI。
 *
 * 用法：
 *   node bin/cnki-dl.js --config examples/cnki-guoqi.json [选项]
 *
 * 选项：
 *   --config <file>   配置文件（默认 ./cnki.config.json）
 *   --ids 14,15,16    只处理指定 id
 *   --port <n>        Chrome 调试端口（默认自动发现）
 *   --launch          自动启动一个 Chrome（有界面）
 *   --headless        配合 --launch，无头模式
 *   --no-new-tab      复用现有标签页，而不是新建
 *   --dry-run         只检索匹配，不下载
 *   -h, --help        帮助
 */

const fs = require('fs');
const path = require('path');
const { discoverPort, launchChrome, connectBrowser } = require('../src/core/browser');
const { runDownloader } = require('../src/cnki/downloader');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--config':
        args.config = next();
        break;
      case '--ids':
        args.ids = next();
        break;
      case '--port':
        args.port = next();
        break;
      case '--launch':
        args.launch = true;
        break;
      case '--headless':
        args.headless = true;
        break;
      case '--no-new-tab':
        args.newTab = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error('未知参数: ' + a);
        args._.push(a);
    }
  }
  return args;
}

function printHelp() {
  console.log(`CNKI 批量下载 CLI

用法：
  node bin/cnki-dl.js --config examples/cnki-guoqi.json [选项]

选项：
  --config <file>   配置文件（默认 ./cnki.config.json）
  --ids 14,15,16    只处理指定 id
  --port <n>        Chrome 调试端口（默认自动发现）
  --launch          自动启动一个 Chrome（有界面）
  --headless        配合 --launch，无头模式
  --no-new-tab      复用现有标签页，而不是新建
  --dry-run         只检索匹配，不下载
  -h, --help        帮助`);
}

function resolvePath(baseDir, p) {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const configPath = path.resolve(args.config || 'cnki.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件: ${configPath}（可用 examples/cnki-guoqi.json 作为模板）`);
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
    authorFilter: raw.authorFilter || '',
    outputDir: resolvePath(configDir, raw.outputDir || './output'),
    tmpDir: resolvePath(configDir, raw.tmpDir || './.tmp-download'),
    logFile: resolvePath(configDir, raw.logFile || './output/download-log.json'),
    dryRun: !!args.dryRun,
    downloadTimeoutMs: raw.downloadTimeoutMs || 45000,
    delayBetweenMs: raw.delayBetweenMs || 0,
    cooldownEvery: raw.cooldownEvery || 0,
    cooldownMs: raw.cooldownMs || 0,
  };

  console.log(`[${stamp()}] 配置: ${configPath}`);
  console.log(`[${stamp()}] 输出: ${config.outputDir}`);
  console.log(`[${stamp()}] 文献: ${papers.length} 篇${config.dryRun ? '（dry-run）' : ''}`);

  // 连接或启动浏览器
  let port;
  if (args.launch) {
    port = Number(args.port || 9222);
    console.log(`[${stamp()}] 启动 Chrome，调试端口 ${port}…`);
    await launchChrome({ port, headless: !!args.headless });
  } else {
    port = await discoverPort(args.port);
    console.log(`[${stamp()}] 连接 Chrome 调试端口 ${port}`);
  }

  const { browser, pages } = await connectBrowser(port, { tabs: 1, newTab: args.newTab !== false });
  const page = pages[0];

  const onEvent = (e) => {
    const t = `[${stamp()}]`;
    switch (e.type) {
      case 'start':
        console.log(`\n${t} === #${e.paper.id} ${e.paper.title} ===`);
        break;
      case 'skip':
        console.log(`${t} [skip] #${e.paper.id} ${e.reason}`);
        break;
      case 'captcha':
        console.log(`${t}   ${e.message}`);
        break;
      case 'captcha-result':
        console.log(`${t}   验证码结果: ${JSON.stringify(e.result || e.message || e.error)}`);
        break;
      case 'cooldown':
        console.log(`${t}   ⏸ 冷却 ${Math.round(e.ms / 1000)}s（降低风控概率）…`);
        break;
      case 'matched':
        console.log(`${t}   命中: ${e.row.title} | ${e.row.authors} | ${e.row.source} ${e.row.date}`);
        break;
      case 'download-link':
        console.log(`${t}   下载链接(${e.kind}): ${String(e.href).slice(0, 90)}…`);
        break;
      case 'dry-run':
        console.log(`${t}   [dry-run] 匹配成功，未下载`);
        break;
      case 'success':
        console.log(`${t}   ✅ ${e.file} (${e.bytes} 字节)`);
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

  const log = await runDownloader({ page, browser, papers, config, onEvent });

  console.log('\n===== 汇总 =====');
  for (const e of log) {
    const mark = e.status === 'success' ? '✅' : e.status === 'matched' ? '🔎' : '❌';
    console.log(`${mark} #${e.id} [${e.status || 'pending'}] ${e.title} ${e.file ? '-> ' + e.file : e.reason || ''}`);
  }
  const ok = log.filter((e) => e.status === 'success').length;
  console.log(`\n成功 ${ok} / ${log.length}`);

  browser.close();
  pages.forEach((p) => p.close());
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
