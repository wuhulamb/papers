#!/usr/bin/env node
'use strict';
// 探查 CNKI 篇名检索：给定若干关键词，打印前几条命中标题（用于修正配置里因标点/引号不一致导致的失配）
const { httpJson, CDP, sleep } = require('/workspace/src/core/cdp');

const QUERIES = process.argv.slice(2);

async function main() {
  const version = await httpJson(9222, '/json/version');
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect();
  const list = await httpJson(9222, '/json');
  const t = list.find((x) => x.type === 'page');
  const page = new CDP(t.webSocketDebuggerUrl);
  await page.connect();
  await page.send('Page.enable');
  for (const q of QUERIES) {
    const url = 'https://kns.cnki.net/kns8s/defaultresult/index?kw=' + encodeURIComponent(q) + '&korder=TI';
    await page.send('Page.navigate', { url });
    await sleep(3500);
    const r = await page.send('Runtime.evaluate', {
      expression: `(function(){return [...document.querySelectorAll('tr')].map(tr=>{const a=tr.querySelector('a.fz14')||tr.querySelector('td.name a');if(!a)return null;const s=tr.querySelector('td.source');const d=tr.querySelector('td.date');return {t:a.innerText.trim(),s:s?s.innerText.trim():'',d:d?d.innerText.trim():'',h:a.href};}).filter(Boolean).slice(0,5);})()`,
      returnByValue: true,
    });
    console.log('\n### 查询:', q);
    for (const x of r.result.value || []) console.log(`  - ${x.t}  [${x.s} ${x.d}]`);
    if (!(r.result.value || []).length) console.log('  (无结果)');
  }
  page.close();
  browser.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
