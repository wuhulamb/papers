'use strict';

/** 文献定位：Bing 搜索候选、Crossref DOI 查询、落地页 PDF 链接提取、候选优先级排序。 */

const { sleep } = require('../core/cdp');
const { evalIn } = require('../core/utils');
const { norm, words } = require('./verify');

/** Bing 搜索，返回结果链接。 */
async function bingSearch(page, query) {
  await page.send('Page.navigate', { url: 'https://cn.bing.com/search?q=' + encodeURIComponent(query) });
  await sleep(2200);
  return (await evalIn(page, `[...document.querySelectorAll('#b_results > li.b_algo h2 a')].map(a=>a.href)`, { awaitPromise: true })) || [];
}

/** 打开落地页，提取 citation_pdf_url 与 .pdf 链接，并返回页面信息。 */
/** 打开落地页，提取 citation_pdf_url 与 .pdf 链接，并返回页面信息。
 *
 * 关键：出版商站点（ScienceDirect/T&F 等）直接裸访文章页会被 Cloudflare 挑战（Just a moment）；
 * 遇到挑战时先访问平台**首页**建立机构会话，再回来重试（实测有效）。
 */
async function extractPdfLinks(page, url) {
  const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return null; } };
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Page.navigate 可能因 Cloudflare/重定向长时间挂起，用超时包裹
    await Promise.race([
      page.send('Page.navigate', { url }).catch(() => {}),
      sleep(12000),
    ]);
    await sleep(4000);
    last = await evalIn(
      page,
      `(function(){
        const out=[];
        const m=document.querySelector('meta[name="citation_pdf_url"]');
        if(m&&m.content) out.push(m.content);
        document.querySelectorAll('a').forEach(a=>{ if(a.href && /\\.pdf([?]|$)/i.test(a.href)) out.push(a.href); });
        return { links:[...new Set(out)], title:document.title, ct:document.contentType, url:location.href, body:(document.body||document.documentElement).innerText.slice(0,200) };
      })()`,
      { awaitPromise: true, timeoutMs: 12000 }
    );
    if (!last) last = { links: [], title: '', ct: '', url, body: '' };
    if (!isCloudflare(last)) return last;
    // Cloudflare 挑战：先访问平台首页建立会话（机构 IP 通常自动授权），再回来重试
    const origin = originOf(last.url && last.url !== 'about:blank' ? last.url : url);
    if (origin) {
      await Promise.race([
        page.send('Page.navigate', { url: origin }).catch(() => {}),
        sleep(12000),
      ]);
      await sleep(6000);
    } else {
      break;
    }
  }
  return last;
}

/** 通过 Crossref 按题名查 DOI（返回命中题名相似度最高的一条）。 */
async function crossrefLookup(page, title) {
  const url =
    'https://api.crossref.org/works?rows=6&select=DOI,title,type,container-title,published,author&query.bibliographic=' +
    encodeURIComponent(title);
  await page.send('Page.navigate', { url });
  await sleep(1800);
  let json = null;
  try {
    json = JSON.parse(await evalIn(page, 'document.body.innerText', { awaitPromise: true }));
  } catch (e) {
    return null;
  }
  const tw = words(title);
  const scoreOf = (t) => {
    const c = norm(t);
    return tw.length ? tw.filter((w) => c.includes(w)).length / tw.length : 0;
  };
  let best = null;
  let bestScore = 0;
  for (const it of (json.message && json.message.items) || []) {
    const t = (it.title && it.title[0]) || '';
    const s = scoreOf(t);
    if (s > bestScore) {
      bestScore = s;
      best = {
        doi: it.DOI,
        title: t,
        type: it.type,
        container: (it['container-title'] || [])[0],
        year: it.published && it.published['date-parts'] && it.published['date-parts'][0] && it.published['date-parts'][0][0],
      };
    }
  }
  return best ? { ...best, score: +bestScore.toFixed(2) } : null;
}

/** 反解 Bing 跳转链接。 */
function unBing(u) {
  try {
    if (/bing\.com\/ck\/a/.test(u)) {
      const m = u.match(/[?&]u=a1([^&]+)/);
      if (m) {
        let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        return Buffer.from(b, 'base64').toString('utf8');
      }
    }
  } catch (e) {
    /* ignore */
  }
  return u;
}

function isBadHost(u) {
  return /ablesci|sci-hub|scihub|libgen|zlib|booksc|bookzz|ebsco|proquest|x-mol|book118|docin|doc88|taodocs|renrendoc/i.test(u);
}

const REPO_RE =
  /core\.ac\.uk|researchgate\.net|repec\.org|ideas\.repec|\.edu(\/|$)|\.ac\.[a-z]+\/|arxiv\.org|ssrn\.com|osf\.io|semanticscholar|econstor|nber\.org|iza\.org|cesifo|mdpi\.com|frontiersin\.org|plos\.org|ncbi\.nlm\.nih\.gov|springeropen|tandfonline\.com\/doi\/pdf|wiley\.com\/doi\/pdf|sagepub\.com\/doi\/pdf|link\.springer\.com\/content\/pdf|sciencedirect.*\/pdfft/i;
const PAYWALL_RE =
  /tandfonline\.com\/doi\/(full|abs)|link\.springer\.com\/article|onlinelibrary\.wiley\.com\/doi\/(full|abs|10)|journals\.sagepub\.com\/doi\/(full|abs|10)|sciencedirect\.com\/science\/article|emerald\.com|jstor\.org\/stable/i;

/** 候选排序：直链 PDF / 机构库优先，出版商落地页次之。 */
function scoreUrl(u) {
  let s = 0;
  if (/\.pdf(\?|$)/i.test(u) || /\/content\/pdf\/|\/doi\/pdf\//i.test(u)) s += 60;
  if (REPO_RE.test(u)) s += 40;
  if (PAYWALL_RE.test(u)) s -= 60;
  if (isBadHost(u)) s -= 999;
  return s;
}

/** 根据 DOI 前缀构造可直连的 PDF 直链（仅保留实测可用的 OA/机构可下站点）。 */
function directPdfUrlsForDoi(doi) {
  const out = [];
  if (!doi) return out;
  if (doi.startsWith('10.1007/')) out.push(`https://link.springer.com/content/pdf/${doi}.pdf`);
  return out;
}

/** 需要"点击 PDF 按钮"的候选页（例如 SAGE 中国镜像 sage.cnpereading.com）。 */
function clickUrlsForDoi(doi) {
  const out = [];
  if (!doi) return out;
  if (doi.startsWith('10.1177/')) out.push(`https://sage.cnpereading.com/doi/${doi}`);
  out.push(`https://doi.org/${doi}`);
  return out;
}

/** 生成 Bing 检索词。 */
function bingQueries(paper) {
  const q = [`"${paper.title}" pdf`, `"${paper.title}" filetype:pdf`];
  if (paper.source) q.push(`"${paper.title}" ${String(paper.source).split('.')[0]}`);
  return q;
}

function isCloudflare(info) {
  return !!info && /just a moment|security verification/i.test((info.title || '') + (info.body || ''));
}

module.exports = {
  evalIn,
  bingSearch,
  extractPdfLinks,
  crossrefLookup,
  unBing,
  isBadHost,
  scoreUrl,
  directPdfUrlsForDoi,
  clickUrlsForDoi,
  bingQueries,
  isCloudflare,
};
