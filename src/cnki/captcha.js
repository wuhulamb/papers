'use strict';

/**
 * CNKI「滑块拼图」安全验证求解器（在页面上下文中执行的 JS 源码）。
 *
 * 原理：
 *   1. 取出验证弹窗里的两张图：背景图 + 拼图块（base64）。
 *   2. 在 <canvas> 上读像素，用归一化互相关（NCC）扫描出拼图块在背景图中的最佳 x 偏移，
 *      即缺口位置（对亮度/对比度变化不敏感）。
 *   3. 在滑块 .verify-move-block 上派发 mousedown -> 多步 mousemove -> mouseup 的合成事件完成拖动。
 *
 * 该字符串通过 Runtime.evaluate 注入页面执行，返回 { ok, offset, score }。
 */
const CAPTCHA_SOLVER_SOURCE = `(async () => {
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  function load(im){return new Promise((res)=>{const i=new Image();i.onload=()=>res(i);i.src=im.src;});}
  const imgs=[...document.querySelectorAll('img')];
  if(imgs.length<2) return {ok:false,reason:'no-images'};
  const [bi,pi]=await Promise.all([load(imgs[0]),load(imgs[1])]);
  const bc=document.createElement('canvas');bc.width=bi.width;bc.height=bi.height;bc.getContext('2d').drawImage(bi,0,0);
  const pc=document.createElement('canvas');pc.width=pi.width;pc.height=pi.height;pc.getContext('2d').drawImage(pi,0,0);
  const bd=bc.getContext('2d').getImageData(0,0,bi.width,bi.height).data;
  const pd=pc.getContext('2d').getImageData(0,0,pi.width,pi.height).data;
  const pg=[],mask=[];
  for(let i=0;i<pi.width*pi.height;i++){mask.push(pd[i*4+3]>128?1:0);pg.push(0.299*pd[i*4]+0.587*pd[i*4+1]+0.114*pd[i*4+2]);}
  function ncc(off){let sp=0,sb=0,n=0;
    for(let y=0;y<pi.height;y++)for(let x=0;x<pi.width;x++){const k=y*pi.width+x;if(!mask[k])continue;const j=(y*bi.width+off+x)*4;const bg=0.299*bd[j]+0.587*bd[j+1]+0.114*bd[j+2];sp+=pg[k];sb+=bg;n++;}
    const mp=sp/n,mb=sb/n;let cov=0,vp=0,vb=0;
    for(let y=0;y<pi.height;y++)for(let x=0;x<pi.width;x++){const k=y*pi.width+x;if(!mask[k])continue;const j=(y*bi.width+off+x)*4;const bg=0.299*bd[j]+0.587*bd[j+1]+0.114*bd[j+2];const dp=pg[k]-mp,db=bg-mb;cov+=dp*db;vp+=dp*dp;vb+=db*db;}
    return cov/Math.sqrt(vp*vb+1e-9);}
  let best=-9,bestOff=0;
  for(let off=0;off<=bi.width-pi.width;off++){const c=ncc(off);if(c>best){best=c;bestOff=off;}}
  const move=document.querySelector('.verify-move-block');
  if(!move) return {ok:false,reason:'no-move-block'};
  const mr=move.getBoundingClientRect();
  const sx=mr.left+mr.width/2, sy=mr.top+mr.height/2;
  move.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:sx,clientY:sy,button:0}));
  document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:sx,clientY:sy,button:0}));
  const steps=30;
  for(let i=1;i<=steps;i++){
    const t=i/steps; const eased=1-Math.pow(1-t,2.2);
    const x=sx+bestOff*eased; const y=sy+Math.sin(t*4)*1.2;
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y,button:0}));
    await sleep(12+Math.random()*20);
  }
  document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:sx+bestOff,clientY:sy,button:0}));
  await sleep(120);
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:sx+bestOff,clientY:sy,button:0}));
  await sleep(1500);
  return {ok:true,offset:bestOff,score:best};
})()`;

module.exports = { CAPTCHA_SOLVER_SOURCE };
