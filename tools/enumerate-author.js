#!/usr/bin/env node
'use strict';

/**
 * 枚举某作者在 CNKI 上的论文，输出可被 cnki-dl 直接使用的配置（papers 数组）。
 *
 * 用法：
 *   node tools/enumerate-author.js --author 朱晟君 --affiliation 北京大学 --out examples/zhuchengjun.json
 *   选项：
 *     --author <name>       作者名（必填）
 *     --affiliation <name>  机构（可选，点击左侧“机构”分面过滤）
 *     --out <file>          输出配置文件
 *     --port <n>            Chrome 调试端口（默认自动发现）
 *     --max <n>             最多枚举多少条
 *     --journal-only        只保留“学术期刊”类结果（默认 true）
 *     --no-journal-only     保留所有类型
 */

const fs = require('fs');
const path = require('path');
const { sleep } = require('../src/core/cdp');
const { evalIn } = require('../src/core/utils');
const { discoverPort, connectBrowser } = require('../src/core/browser');
const { CAPTCHA_SOLVER_SOURCE } = require('../src/cnki/captcha');
const { CAPTCHA_PRESENT_EXPR } = require('../src/cnki/cnki');

function parseArgs(argv) {
  const a = { journalOnly: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === '--author') a.author = next();
    else if (x === '--out') a.out = next();
    else if (x === '--port') a.port = next();
    else if (x === '--max') a.max = Number(next());
    else if (x === '--affiliation') a.affiliation = next();
    else if (x === '--journal-only') a.journalOnly = true;
    else if (x === '--no-journal-only') a.journalOnly = false;
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
  if (args.help || !args.author) {
    console.log(
      '用法: node tools/enumerate-author.js --author <name> [--affiliation <org>] --out <file> [--port n] [--max n] [--no-journal-only]'
    );
    return;
  }

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

  const url = `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(args.author)}&korder=AU`;
  console.log('检索作者:', args.author);
  await page.send('Page.navigate', { url });
  await sleep(4000);
  await ensureNotCaptcha();

  // 可选：按机构过滤（展开“机构”分面并勾选）
  if (args.affiliation) {
    // 等待“机构”分面出现后再展开
    let found = false;
    for (let i = 0; i < 20; i++) {
      found = await evalIn(page, `(function(){
        const t=[...document.querySelectorAll('dt,.tit,h3,.group-title')].find(e=>e.innerText.trim()==='机构');
        if(!t) return false;
        (t.querySelector('a')||t).dispatchEvent(new MouseEvent('click',{bubbles:true}));
        return true;
      })()`);
      if (found) break;
      await sleep(1000);
    }
    await sleep(2000);
    let clicked = false;
    for (let i = 0; i < 20 && !clicked; i++) {
      clicked = await evalIn(page, `(function(){
        const cb=[...document.querySelectorAll('input[type=checkbox]')].find(e=>e.getAttribute('text')===${JSON.stringify(
          args.affiliation
        )});
        if(!cb) return false;
        if(!cb.checked) cb.click();
        return true;
      })()`);
      if (!clicked) await sleep(1000);
    }
    console.log(clicked ? `  已按机构过滤: ${args.affiliation}` : `  未找到机构分面: ${args.affiliation}`);
    await sleep(4000);
    await ensureNotCaptcha();
  }

  const seen = new Set();
  const rows = [];
  for (let p = 0; p < 60; p++) {
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
    console.log(`  第 ${pager ? pager.page + '/' + pager.total : '?'} 页，累计 ${rows.length} 条`);
    if (args.max && rows.length >= args.max) break;
    const canNext = await evalIn(page, NEXT_ENABLED);
    if (!canNext) break;
    await evalIn(page, `document.querySelector('#PageNext').click()`);
    await sleep(2800);
  }

  const papers = rows
    .filter((r) => (args.journalOnly ? /期刊/.test(r.type) : true))
    .map((r, idx) => ({
      id: idx + 1,
      title: r.title,
      authors: r.authors,
      source: r.source,
      year: (r.date || '').slice(0, 4),
    }));

  const out = { authorFilter: args.author, papers };
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(`\n已写入 ${args.out}（${papers.length} 篇）`);
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
