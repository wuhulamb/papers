#!/usr/bin/env node
'use strict';

/**
 * 用 Crossref REST API（fetch，无需浏览器）为配置批量补全 DOI。
 * 比 get-dois.js（浏览器逐条导航）快得多；作为其无头替代。
 *
 * 用法：
 *   node tools/batch-dois.js --config config/refs-en.json [--out <file>] [--min-score 0.5]
 *
 * 说明：
 *   - 对每条文献用 query.bibliographic 检索，再按题名关键词命中率打分；
 *   - score >= 0.6 才写入（可用 --min-score 调整）；
 *   - 写入后打印总览，方便人工核验可疑匹配。
 */

const fs = require('fs');
const path = require('path');

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'after', 'during', 'using',
  'their', 'which', 'these', 'those', 'between', 'evidence', 'context', 'into', 'role',
  'study', 'research', 'based',
]);
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => [...new Set(norm(t).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)))];

async function crossrefQuery(title) {
  const url =
    'https://api.crossref.org/works?rows=5&select=DOI,title,container-title,published&query.bibliographic=' +
    encodeURIComponent(title);
  const r = await fetch(url, { headers: { 'User-Agent': 'paper-downloader/1.0 (mailto:test@example.com)' } });
  if (!r.ok) throw new Error('crossref HTTP ' + r.status);
  const j = await r.json();
  return (j.message && j.message.items) || [];
}

function scoreOf(title, candidate) {
  const tw = words(title);
  const c = norm(candidate);
  return tw.length ? tw.filter((w) => c.includes(w)).length / tw.length : 0;
}

function parseArgs(argv) {
  const a = { minScore: 0.6 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === '--config') a.config = next();
    else if (x === '--out') a.out = next();
    else if (x === '--min-score') a.minScore = Number(next());
    else if (x === '-h' || x === '--help') a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.config) {
    console.log('用法: node tools/batch-dois.js --config <file> [--out <file>] [--min-score 0.6]');
    return;
  }
  const configPath = path.resolve(args.config);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  let updated = 0;
  for (const p of cfg.papers) {
    if (p.doi) {
      console.log(`#${p.id} 已有 DOI: ${p.doi}`);
      continue;
    }
    try {
      const items = await crossrefQuery(p.title);
      let best = null;
      for (const it of items) {
        const t = (it.title && it.title[0]) || '';
        const s = scoreOf(p.title, t);
        if (!best || s > best.score) {
          best = { doi: it.DOI, score: s, title: t, container: (it['container-title'] || [])[0] || '' };
        }
      }
      if (best && best.score >= args.minScore) {
        p.doi = best.doi;
        updated++;
        console.log(`#${p.id} ${best.score.toFixed(2)} ${best.doi}  <-  ${best.title.slice(0, 60)}`);
      } else {
        console.log(`#${p.id} 无可靠匹配（best=${best ? best.score.toFixed(2) : 'none'}）`);
      }
    } catch (e) {
      console.log(`#${p.id} ERROR ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 350)); // 轻量限速，遵守 Crossref 礼仪
  }

  const outPath = args.out ? path.resolve(args.out) : configPath;
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  console.log(`\n已写入 ${outPath}（新增/更新 ${updated} 条 DOI）`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});