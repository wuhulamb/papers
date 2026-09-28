#!/usr/bin/env node
'use strict';

/**
 * 按「主题/关键词」枚举 CNKI 上的论文，输出可被 cnki-dl 直接使用的配置（papers 数组）。
 * 与 tools/enumerate-author.js 对称：那边按作者，这里按主题词（korder=SU）。
 *
 * 用法：
 *   node tools/topic-enumerate.js --queries "区域间投资联系,区域投资联系" --out examples/区域投资联系.json
 *   选项：
 *     --queries <词1,词2,...>  主题检索词（逗号分隔，逐词检索后合并去重）
 *     --out <file>            输出配置文件
 *     --port <n>              Chrome 调试端口（默认自动发现）
 *     --type <正则>           结果类型过滤，例如 期刊 / 期刊|博士|硕士 / 硕士（默认：学术期刊+博硕士论文）
 *     --max <n>               最多枚举多少条
 *     --max-pages <n>         每个检索词最多翻几页（默认 5）
 */

const fs = require('fs');
const path = require('path');
const { sleep } = require('../src/core/cdp');
const { evalIn } = require('../src/core/utils');
const { discoverPort, connectBrowser } = require('../src/core/browser');
const { CAPTCHA_SOLVER_SOURCE } = require('../src/cnki/captcha');
const { CAPTCHA_PRESENT_EXPR } = require('../src/cnki/cnki');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === '--queries') a.queries = next();
    else if (x === '--out') a.out = next();
    else if (x === '--port') a.port = next();
    else if (x === '--max') a.max = Number(next());
    else if (x === '--max-pages') a.maxPages = Number(next());
    else if (x === '--type') a.type = next();
    else if (x === '-h' || x === '--help') a.help = true;
  }
  return a;
}

const EXTRACT_ROWS = `(function(){
  const out=[];
  [...document.querySelectorAll('tr')].filter(r=>r.querySelector('a.fz14')).forEach(r=>{
    const a=r.querySelector('a.fz14');
    const g=(s)=>{const e=r.querySelector(s);return e?e.innerText.replace(/\\s+/g,' ').trim():'';};
    out.push({title:a.innerText.trim(), authors:g('td.author').replace(/;/g,','), source:g('td.source'), date:g('td.date'), type:g('td.data')});
  });
  return out;
})()`;

const NEXT_ENABLED = `(function(){
  const n=document.querySelector('#PageNext');
  return !!(n && !/disabled/.test(n.className||'') && n.innerText.trim()==='下一页');
})()`;

const PAGER = `(function(){
  const t=(document.querySelector('.search-page')||{}).innerText||'';
  const m=t.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  return m?{page:+m[1],total:+m[2]}:null;
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.queries) {
    console.log(
      '用法: node tools/topic-enumerate.js --queries "词1,词2" [--out file] [--port n] [--max n] [--max-pages n] [--type 正则]'
    );
    return;
  }
  const queries = args.queries.split(',').map((s) => s.trim()).filter(Boolean);
  const typeRe = args.type ? new RegExp(args.type) : /期刊|博士|硕士/;
  const maxPages = args.maxPages || 5;

  const port = await discoverPort(args.port);
  const { browser, pages } = await connectBrowser(port, { tabs: 1 });
  const page = pages[0];

  const ensureNotCaptcha = async () => {
    for (let i = 0; i < 5; i++) {
      let st = null;
      try {
        st = await evalIn(page, CAPTCHA_PRESENT_EXPR);
      } catch (e) {
        await sleep(1500);
        continue;
      }
      if (st && st.has) {
        console.log('  检测到安全验证，求解中…');
        try {
          await evalIn(page, CAPTCHA_SOLVER_SOURCE, { awaitPromise: true });
        } catch (e) {
          /* 求解后跳转属正常 */
        }
        await sleep(3000);
      } else return true;
    }
    return true;
  };

  /** 对一个检索词翻页枚举。返回该词的结果行数组（含 type）。 */
  const enumerateQuery = async (q, seen) => {
    const url = `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(q)}&korder=SU`;
    console.log('检索主题:', q);
    await page.send('Page.navigate', { url });
    await sleep(4000);
    await ensureNotCaptcha();
    const rows = [];
    for (let p = 0; p < maxPages; p++) {
      await ensureNotCaptcha();
      let batch = [];
      for (let i = 0; i < 20 && !batch.length; i++) {
        batch = (await evalIn(page, EXTRACT_ROWS)) || [];
        if (!batch.length) await sleep(1000);
      }
      for (const r of batch) {
        if (!seen.has(r.title)) {
          seen.add(r.title);
          rows.push(r);
        }
      }
      const pager = await evalIn(page, PAGER);
      console.log(`  第 ${pager ? pager.page + '/' + pager.total : '?'} 页，本词累计 ${rows.length} 条`);
      if (pager && p >= pager.total - 1) break;
      const canNext = await evalIn(page, NEXT_ENABLED);
      if (!canNext) break;
      await evalIn(page, `document.querySelector('#PageNext').click()`);
      await sleep(2800);
    }
    return rows;
  };

  const seen = new Set();
  const all = [];
  for (const q of queries) {
    const rows = await enumerateQuery(q, seen);
    all.push(...rows);
    if (args.max && all.length >= args.max) break;
  }

  const papers = all
    .filter((r) => typeRe.test(r.type || ''))
    .map((r, idx) => ({
      id: idx + 1,
      title: r.title,
      authors: r.authors,
      source: r.source,
      year: (r.date || '').slice(0, 4),
    }));

  console.log(`\n枚举完成：共 ${all.length} 条（去重），类型过滤后 ${papers.length} 条。`);
  const out = { queries, papers };
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(`已写入 ${args.out}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }

  browser.close();
  pages.forEach((p) => p.close());
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});