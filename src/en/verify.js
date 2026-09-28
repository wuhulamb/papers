'use strict';

/**
 * 用 pdf-parse 提取 PDF 元数据/正文，与预期题名比对，判断下载到的是否为目标论文。
 * 这是避免"下到同名或主题相近的错误文献"的关键一步。
 */

const fs = require('fs');
const pdfParse = require('pdf-parse');

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'after', 'during', 'using',
  'their', 'which', 'these', 'those', 'between', 'evidence', 'context', 'into', 'role',
]);

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function words(t) {
  return [...new Set(norm(t).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)))];
}

/**
 * @returns {Promise<{score:number,basis:string,exact:boolean,metaTitle:string}>}
 *   score: 题名关键词命中比例（0~1）；basis: 依据（meta/top）；exact: 连续题名片段是否命中。
 */
async function verifyPdf(file, title) {
  let info = {};
  let text = '';
  try {
    const d = await pdfParse(fs.readFileSync(file));
    info = d.info || {};
    text = d.text || '';
  } catch (e) {
    /* ignore */
  }
  if (!text) {
    // 兜底：从原始字节里找 /Title
    try {
      const raw = fs.readFileSync(file).toString('latin1');
      const m = raw.match(/\/Title\s*\(([^)]*)\)/);
      if (m) {
        info.Title = m[1];
        text = m[1];
      }
    } catch (e) {
      /* ignore */
    }
  }

  const metaTitle = (info.Title || '').replace(/\s+/g, ' ').trim();
  // 反例：某些候选是文献管理/引文报告导出（如 Web of Science Citation Report），meta 含目标题名但并非论文全文
  if (/citation report|web of science|clarivate/i.test(metaTitle)) {
    return { score: 0, basis: 'citation-report', exact: false, metaTitle };
  }
  const tw = words(title);
  const scoreOf = (candidate) => {
    const c = norm(candidate);
    return tw.length ? tw.filter((w) => c.includes(w)).length / tw.length : 0;
  };

  let score = 0;
  let basis = 'none';
  const looksRealTitle = metaTitle.length >= 15 && !/microsoft word|untitled|manuscript/i.test(metaTitle);
  if (looksRealTitle) {
    score = scoreOf(metaTitle);
    basis = 'meta';
  }
  if (score < 0.7) {
    const s2 = scoreOf(text.slice(0, 1500));
    if (s2 > score) {
      score = s2;
      basis = 'top';
    }
  }

  const phrase = norm(title).split(' ').filter((w) => !STOP.has(w)).slice(0, 6).join(' ');
  const exact = phrase.length > 10 && norm(metaTitle + ' ' + text.slice(0, 2000)).includes(phrase);

  return { score, basis, exact, metaTitle };
}

/** 判定是否命中目标论文。 */
function isMatch(v) {
  return v.score >= 0.7 || v.exact;
}

module.exports = { verifyPdf, isMatch, norm, words };
