'use strict';

/** CNKI（中国知网）KNS8 检索相关的页面逻辑。 */

const SEARCH_BASE = 'https://kns.cnki.net/kns8s/defaultresult/index';

/**
 * 构造「篇名」检索 URL。
 * @param {string} title 篇名
 * @param {{baseUrl?:string, order?:string}} opts order 默认 TI（篇名）
 */
function buildSearchUrl(title, { baseUrl = SEARCH_BASE, order = 'TI' } = {}) {
  return `${baseUrl}?kw=${encodeURIComponent(title)}&korder=${order}`;
}

/**
 * 生成检索词候选：完整题名；若含「——」等副标题分隔符，再加入主标题。
 * CNKI 对含「——」的完整篇名精确检索常无结果，用主标题更稳。
 */
function splitTitleQueries(title) {
  const queries = [title];
  const main = String(title).split(/\u2014\u2014|\u2014|--/)[0].trim();
  if (main && main !== title) queries.push(main);
  return queries;
}

/**
 * 在检索结果页里查找与目标篇名匹配的记录（注入页面执行的源码）。
 * 返回 { found, title, authors, downloadHref, articleHref, source, date } 或 { found:false, bodyText }。
 */
function findRowExpr(target) {
  return `(function(){
    // 标点归一化：知网存储的题名与引用题名常在 全角/半角 冒号、括号、引号、逗号 上不一致，统一后再比对
    function norm(s){return (s||'').replace(/[\s\u00a0]/g,'').replace(/[—–\-]/g,'-').replace(/[：:]/g,':').replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/[“”'"]/g,'"').replace(/[，,]/g,',').replace(/、/g,',');}
    const want=norm(${JSON.stringify(target)});
    const build=function(tr,a){
      const authors=(tr.querySelector('td.author')?tr.querySelector('td.author').innerText:'').replace(/\\s+/g,';');
      const dl=tr.querySelector('a.downloadlink');
      const src=tr.querySelector('td.source');
      const date=tr.querySelector('td.date');
      return {found:true,title:a.innerText.trim(),authors,downloadHref:dl?dl.href:null,articleHref:a.href,
              source:src?src.innerText.replace(/\\s+/g,' ').trim():'',date:date?date.innerText.trim():''};
    };
    let exact=null, partial=null;
    const rows=[...document.querySelectorAll('tr')];
    for(const tr of rows){
      const a=tr.querySelector('a.fz14')||tr.querySelector('td.name a');
      if(!a) continue;
      const t=norm(a.innerText);
      if(!t) continue;
      if(t===want){ exact=build(tr,a); break; }
      if(!partial && (t.includes(want)||want.includes(t))) partial=build(tr,a);
    }
    const row=exact||partial;
    if(row) return row;
    return {found:false, bodyText:document.body.innerText.slice(0,300)};
  })()`;
}

/**
 * 从知网文章页（知网节）提取 PDF / CAJ 下载链接（注入页面执行的源码）。
 * 优先 PDF，其次 CAJ。
 */
function downloadLinksExpr() {
  return `(function(){
    const out={};
    [...document.querySelectorAll('a')].forEach(a=>{
      const t=a.innerText.trim();
      if(/^PDF下载$/.test(t) && !out.pdf) out.pdf=a.href;
      if(/^CAJ下载$/.test(t) && !out.caj) out.caj=a.href;
    });
    return out;
  })()`;
}

/** 判断页面是否出现了安全验证弹窗。 */
const CAPTCHA_PRESENT_EXPR = `({title:document.title, has:!!document.querySelector('.verify-move-block')})`;

module.exports = {
  SEARCH_BASE,
  buildSearchUrl,
  splitTitleQueries,
  findRowExpr,
  downloadLinksExpr,
  CAPTCHA_PRESENT_EXPR,
};
