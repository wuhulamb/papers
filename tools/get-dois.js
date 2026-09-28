#!/usr/bin/env node
'use strict';

/**
 * 用 Crossref 为配置文件里的论文补全 DOI。
 *
 * 用法：
 *   node tools/get-dois.js --config examples/guoqi.json [--port 9336]
 *   --out <file>   另存到文件（默认写回 --config）
 */

const fs = require('fs');
const path = require('path');
const { launchHeadedPdf, connectBrowser } = require('../src/core/browser');
const { crossrefLookup } = require('../src/en/search');

function parseArgs(argv) {
  const a = { port: 9336 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === '--config') a.config = next();
    else if (x === '--out') a.out = next();
    else if (x === '--port') a.port = Number(next());
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    console.log('用法: node tools/get-dois.js --config <file> [--out <file>] [--port n]');
    return;
  }
  const configPath = path.resolve(args.config);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const child = await launchHeadedPdf({ port: args.port });
  const { browser, pages } = await connectBrowser(args.port, { tabs: 1 });
  const page = pages[0];

  for (const p of cfg.papers) {
    if (p.doi) {
      console.log(`#${p.id} 已有 DOI: ${p.doi}`);
      continue;
    }
    try {
      const cr = await crossrefLookup(page, p.title);
      if (cr && cr.score >= 0.6) {
        p.doi = cr.doi;
        console.log(`#${p.id} score=${cr.score} doi=${cr.doi} | ${cr.title}`);
      } else {
        console.log(`#${p.id} 未匹配到可靠 DOI（best=${cr ? cr.score : 'none'}）`);
      }
    } catch (e) {
      console.log(`#${p.id} ERROR ${e.message}`);
    }
  }

  const outPath = args.out ? path.resolve(args.out) : configPath;
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  console.log(`\n已写入 ${outPath}`);

  browser.close();
  pages.forEach((pg) => pg.close());
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch (e) {
    /* ignore */
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
