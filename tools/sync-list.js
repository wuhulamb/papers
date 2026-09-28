#!/usr/bin/env node
'use strict';

/**
 * 把下载日志（en-log.json / cnki-log.json）的状态同步回 Markdown 清单。
 * 清单每行形如 `| id | ... | 状态 | 文件 |`，脚本只改最后两列。
 *
 * 用法：
 *   node tools/sync-list.js --log <log.json> --list <download-list.md>
 *
 * status 映射：success → `✅`；failed → `❌ <reason>`；其余保留原值。
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') a.log = argv[++i];
    else if (argv[i] === '--list') a.list = argv[++i];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.log || !args.list) {
    console.log('用法: node tools/sync-list.js --log <log.json> --list <download-list.md>');
    return;
  }
  const log = JSON.parse(fs.readFileSync(path.resolve(args.log), 'utf8'));
  const byId = new Map(log.map((e) => [e.id, e]));

  const listPath = path.resolve(args.list);
  const lines = fs.readFileSync(listPath, 'utf8').split('\n');
  let changed = 0;

  const out = lines.map((line) => {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (!m) return line;
    const id = Number(m[1]);
    if (!byId.has(id)) return line;
    const e = byId.get(id);
    const cells = line.split('|');
    // cells: ['', id, ...mid..., status, file, '']  → 倒数第 3、第 2 项为状态、文件
    const statusIdx = cells.length - 3;
    const fileIdx = cells.length - 2;
    let status;
    if (e.status === 'success') status = `✅ ${new Date().toISOString().slice(0, 10)}`;
    else if (e.status === 'failed') status = `❌ ${(e.reason || '失败').replace(/\|/g, '/').slice(0, 40)}`;
    else status = cells[statusIdx].trim() || '⏳ 待下载';
    const file = e.status === 'success' && e.file ? ` ${e.file} ` : ' ';
    cells[statusIdx] = ` ${status} `;
    cells[fileIdx] = file;
    changed++;
    return cells.join('|').replace(/\| +\|/g, '| |');
  });

  fs.writeFileSync(listPath, out.join('\n'));
  console.log(`已根据 ${args.log} 更新 ${changed} 行 → ${args.list}`);
}

main();
