#!/usr/bin/env node
'use strict';
// 手动抢救下载：对给定 (id, title, url) 用有头 Chrome 直接下载 + pdf-parse 校验 + 归档
const fs = require('fs');
const path = require('path');
const { launchHeadedPdf, connectBrowser } = require('/workspace/src/core/browser');
const { downloadUrl } = require('/workspace/src/en/download');
const { verifyPdf, isMatch } = require('/workspace/src/en/verify');
const { sanitize } = require('/workspace/src/core/utils');

const OUT = '/workspace/output/城际投资联系研究进展_参考文献';
const TMP = '/tmp/refs2-en-dl';

const ITEMS = [
  { id: 73, title: 'External Relations of German Cities through Intra-firm Networks—A Global Perspective', url: 'https://rur.oekom.de/index.php/rur/en/article/download/785/1084' },
  { id: 71, title: 'Polycentric Puzzles-emerging Mega-city Regions Seen through the Lens of Advanced Producer Services', url: 'https://www.tandfonline.com/doi/pdf/10.1080/00343400802389377' },
  { id: 72, title: 'Application of the Interlocking Network Model to Mega-city-regions: Measuring Polycentricity within and beyond City-regions', url: 'https://www.tandfonline.com/doi/pdf/10.1080/00343400701874214' },
  { id: 9, title: 'Fluctuating Rounds of Inward Investment in Peripheral Regions: Semiconductors in the North East of England', url: 'https://www.sheffield.ac.uk/media/34544/download?attachment' },
];

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const child = await launchHeadedPdf({ port: 9337, userDataDir: '/tmp/salvage-headed', downloadDir: TMP });
  const { browser, pages } = await connectBrowser(9337, { tabs: 2 });
  const [, dlPage] = pages;

  for (const it of ITEMS) {
    console.log(`\n=== #${it.id} ${it.title.slice(0, 50)} ===`);
    let r = await downloadUrl({ browser, page: dlPage, url: it.url, downloadDir: TMP, timeoutMs: 25000 });
    if (!r.ok) { console.log('  ❌ 下载失败', r.navError); continue; }
    const v = await verifyPdf(r.file, it.title);
    console.log('  校验 score=', v.score.toFixed(2), 'basis=', v.basis, 'meta="', (v.metaTitle || '').slice(0, 40), '"');
    if (isMatch(v)) {
      const nice = path.join(OUT, `${it.id}_${sanitize(it.title)}.pdf`);
      try { fs.renameSync(r.file, nice); } catch (e) { fs.copyFileSync(r.file, nice); fs.unlinkSync(r.file); }
      console.log('  ✅', path.basename(nice), fs.statSync(nice).size, '字节');
    } else {
      fs.copyFileSync(r.file, `/tmp/refs2-en-rejected/${it.id}_salvage.pdf`);
      console.log('  ❌ 校验不匹配（留档 rejected）');
    }
  }

  browser.close();
  pages.forEach((p) => p.close());
  try { process.kill(child.pid, 'SIGKILL'); } catch (e) { /* ignore */ }
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });