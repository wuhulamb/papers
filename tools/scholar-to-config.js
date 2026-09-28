'use strict';
/* 步骤B：scholar 结果 → en-dl 配置文件 */
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/tmp/scholar-results.json', 'utf8'));

const SEP = /[ \u00a0]*-[ \u00a0]*/;
const parse = (x) => {
  const meta = (x.meta || '').replace(/\u00a0/g, ' ');
  const parts = meta.split(SEP).map((s) => s.trim()).filter(Boolean);
  const authors = parts[0] || '';
  const rest = parts[1] || '';
  const m = rest.match(/^(.*?),\s*(19\d\d|20\d\d)$/);
  const source = m ? m[1].trim() : rest;
  const year = m ? m[2] : '';
  return { title: x.title, authors, source, year, href: x.href, scholarMeta: meta };
};

const papers = raw.map(parse).filter((p) => p.title && p.authors);
const seen = new Set();
const uniq = papers.filter((p) => (seen.has(p.title) ? false : (seen.add(p.title), true)));
console.log('解析:', papers.length, '条 → 去重:', uniq.length, '条\n');

const cfg = {
  outputDir: '../output/区域间投资联系_英文文献',
  tmpDir: '/tmp/en-paper-dl',
  rejectedDir: '/tmp/en-paper-rejected',
  logFile: '../output/区域间投资联系_英文文献/download-log.json',
  paperBudgetMs: 70000,
  downloadTimeoutMs: 14000,
  useBing: true,
  papers: uniq.map((p, i) => ({ id: i + 1, title: p.title, authors: p.authors, source: p.source, year: p.year })),
};
fs.writeFileSync('examples/scholar-region-invest-en.json', JSON.stringify(cfg, null, 2));
console.log('已写入 examples/scholar-region-invest-en.json');
uniq.forEach((p, i) => console.log(String(i + 1).padStart(2), '|', p.title.slice(0, 55).padEnd(56), '|', p.authors.slice(0, 26).padEnd(27), '|', p.source.slice(0, 20).padEnd(21), '|', p.year, '|', (p.href || '').slice(0, 45)));