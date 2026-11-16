// 论文仪表盘：各个视图。数据来自页间的文献库（adapter.js），不联网。
const RAW_COLORS=['#34d3c0','#60a5fa','#f472b6','#fbbf24','#a78bfa','#4ade80','#fb923c','#f87171'];
const CCF_COLORS={'CCF-A':'#f6c453','CCF-B':'#8fb3ff','CCF-C':'#7ee0a0','无CCF评级':'#9aa6c4','预印本':'#b69bff','未知':'#8590ac'};
let DATA=null, lastStamp=null, sortMode='order', venueTypeFilter=null, wallSort='time', wallQ='';
let catListView='all';  // 'all'，或文献库里一个书单的名字
let catQ='';
let calYear=new Date().getFullYear(), calView='year', calMonth=new Date().getMonth();
let fState={q:'',cat:[],status:[],year:[],ccf:[],vtype:[],venue:[]};  // 各筛选为多选数组，空=全部
const $=(s,el=document)=>el.querySelector(s);
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pctOf=(a,b)=>b?Math.round(a/b*1000)/10:0;

/* theme —— 默认跟随页间的深浅色；按钮在「跟随页间 / 日间 / 夜间」之间切换，选择记在插件自己的存储里 */
let prefs={theme:'auto',list:'all'};
function applyTheme(){
  const t=prefs.theme==='auto'?(folio.theme.dark?'dark':'light'):prefs.theme;
  document.documentElement.setAttribute('data-theme',t);
  $('#themeIcon').textContent=prefs.theme==='auto'?'🖥️':t==='light'?'☀️':'🌙';
  $('#themeBtn').title='外观：'+(prefs.theme==='auto'?'跟随页间':t==='light'?'日间':'夜间')+'（点击切换）';
}
function savePrefs(){folio.storage.set(prefs).catch(()=>{});}
folio.on('theme',applyTheme);
$('#themeBtn').addEventListener('click',()=>{
  prefs.theme=prefs.theme==='auto'?'light':prefs.theme==='light'?'dark':'auto'; applyTheme(); savePrefs();});

async function load(force=false){
  const btn=$('#refreshBtn'); btn.classList.add('spin');
  try{
    const d=await buildData();   // adapter.js：把页间的文献库整理成下面各个视图要的样子
    const first=lastStamp===null, changed=!first&&d.stamp!==lastStamp;
    DATA=d; lastStamp=d.stamp;
    if(catListView!=='all'&&!DATA.lists.some(l=>l.name===catListView))catListView='all';
    if(first||changed||force){render(); if(changed)toast('数据已更新');}
  }catch(e){$('#root').innerHTML='<div class="empty">读不到文献库：'+esc(e&&e.message||String(e))+'</div>';}
  finally{setTimeout(()=>btn.classList.remove('spin'),550);}
}

function render(){
  const t=DATA.totals, pct=pctOf(t.read,t.total);
  if(!t.total){
    $('#subtitle').textContent='文献库里还没有论文';
    $('#root').innerHTML='<div class="empty">文献库还是空的。在页间左边右键一篇文档或一个文件夹，选「加入文献库」；让 AI 助手找论文并下载，也会自动记进来。</div>';
    return;
  }
  $('#subtitle').textContent=`共 ${t.total} 篇 · 已读 ${t.read} 篇 (${pct}%) · 未读 ${t.unread} 篇`;
  $('#updated').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  $('#root').innerHTML=heroHTML(t,pct)+wallHTML()+catsHTML()+venuesHTML()+yearsHTML()+explorerHTML()+calendarHTML();
  bindCats(); bindVenues(); bindFilters(); bindWall(); bindPaperPreviews(); bindCal();
  requestAnimationFrame(capCalRows); setTimeout(capCalRows,80);
  requestAnimationFrame(()=>requestAnimationFrame(animate));
}

/* hero */
function heroHTML(t,pct){
  const C=2*Math.PI*86;
  const a=DATA.ccf.find(c=>c.name==='CCF-A')||{total:0,read:0};
  return `<div class="hero">
    <div class="card ring-card"><div class="ring-wrap">
      <svg width="200" height="200" viewBox="0 0 200 200">
        <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--read)"/><stop offset="1" stop-color="var(--read2)"/></linearGradient></defs>
        <circle class="ring-track" cx="100" cy="100" r="86" fill="none" stroke-width="16"/>
        <circle id="ringArc" cx="100" cy="100" r="86" fill="none" stroke="url(#rg)" stroke-width="16" stroke-linecap="round"
          transform="rotate(-90 100 100)" stroke-dasharray="0 ${C}" style="transition:stroke-dasharray 1.3s cubic-bezier(.2,.8,.2,1)" data-target="${pct/100*C}"/>
      </svg>
      <div class="ring-center"><div class="pct" data-count="${pct}" data-suffix="%">0%</div><div class="frac">${t.read} / ${t.total} 篇</div></div>
    </div><div class="ring-label">总体阅读进度</div></div>
    <div class="kpis">
      ${kpi('k-total','📚 论文总数',t.total,'文献库里的全部论文',null)}
      ${kpi('k-ccf','🏆 CCF-A 论文',a.total,`已读 ${a.read} / ${a.total}（${pctOf(a.read,a.total)}%）`,pctOf(a.read,a.total))}
      ${kpi('k-read','✅ 已读',t.read,`占总量 ${pct}%`,pct)}
      ${kpi('k-unread','📖 未读',t.unread,`还剩 ${t.unread} 篇待阅读`,null)}
    </div></div>`;
}
function kpi(cls,cap,num,meta,bar){return `<div class="card kpi ${cls}"><div class="glow"></div>
  <div class="cap">${cap}</div><div class="num" data-count="${num}">0</div><div class="meta">${meta}</div>
  ${bar!=null?`<div class="mini-bar"><i data-w="${bar}"></i></div>`:''}</div>`;}

function paperIndex(p){return DATA.papers.indexOf(p);}

/* wall —— 一格一文，悬停看标题，点击预览自己的笔记 */
function wallHTML(){
  const catIdx={}; DATA.categories.forEach((c,i)=>catIdx[c.disp]=i);
  let cells='', n=0;
  const cellOf=p=>{
    const i=catIdx[p.cat_disp], col=i==null?'var(--txt-faint)':RAW_COLORS[i%8];
    const t='第 '+(++n)+' 篇 · '+(p.label||p.title_en)+(p.done?' · 已读 ✓':' · 未读');
    const attrs=`class="cell${p.done?' on':''}" style="color:${col}" data-tip="${esc(t)}"
      data-paper-index="${paperIndex(p)}" data-q="${esc(((p.label||'')+' '+p.title_en+' '+(p.title_zh||'')).toLowerCase())}"
      aria-label="${esc('预览 '+(p.label||p.title_en)+' 的笔记')}"`;
    return `<button type="button" ${attrs}></button>`;
  };
  // 两种排布：按加入文献库的先后 / 按分类分组
  let ordered;
  if(wallSort==='time'){
    ordered=DATA.papers.slice().sort((a,b)=>(a.note_time??Infinity)-(b.note_time??Infinity));
  }else{
    ordered=[]; const seen=new Set();
    DATA.categories.forEach(c=>DATA.papers.forEach(p=>{
      if(p.cat_disp===c.disp){ordered.push(p);seen.add(p);}
    }));
    DATA.papers.forEach(p=>{if(!seen.has(p))ordered.push(p);});
  }
  cells=ordered.map(cellOf).join('');
  const total=DATA.totals.total||1;
  const legend=DATA.categories.map((c,i)=>
    `<span><i style="background:${RAW_COLORS[i%8]}"></i>${esc(c.disp)}<b>${pctOf(c.total,total)}%</b></span>`).join('');
  return `<div class="section"><div class="section-head"><h2>书墙</h2>
    <span class="sub">一格一文 · 着色即已读（按类别配色）· 悬停看标题，点击先看自己的总结与笔记</span>
    <span class="sub" id="wallQCount"></span>
    <span class="spacer"></span>
    <input id="wallQ" class="wall-search" type="text" placeholder="🔍 简称定位（如 LSTM）…" value="${esc(wallQ)}">
    <div class="seg" id="wallSortSeg">
      <button data-s="time" class="${wallSort==='time'?'on':''}">加入时间</button>
      <button data-s="cat" class="${wallSort==='cat'?'on':''}">按分类</button></div></div>
    <div class="card wall-card"><div class="wall">${cells}</div>
    <div class="wall-foot"><span>共 ${DATA.totals.total} 篇 · 已读 ${DATA.totals.read} 篇</span>
    <div class="wall-legend">${legend}</div></div></div></div>`;
}

/* reading calendar —— 每日阅读篇数热力图（按论文标为已读的那天） */
function calendarHTML(){
  const byDate={};
  DATA.papers.forEach(p=>{if(p.read_date)(byDate[p.read_date]=byDate[p.read_date]||[]).push(p);});
  const fmt=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  const today=new Date(); today.setHours(12,0,0,0);
  const todayKey=fmt(today), thisYear=today.getFullYear();
  // 可选年份 = 有记录的年份 ∪ 今年
  const years=new Set([thisYear]);
  Object.keys(byDate).forEach(k=>years.add(+k.slice(0,4)));
  const minY=Math.min(...years), maxY=Math.max(...years);
  if(calYear<minY)calYear=minY; if(calYear>maxY)calYear=maxY;

  let logged=0, days=0, best={n:0,date:''};
  const lvlOf=n=>n===0?0:n===1?1:n<=2?2:n<=4?3:4;
  const stat=(key,n)=>{if(n){logged+=n; days++; if(n>best.n)best={n,date:key};}};
  const tipOf=(key,list,isToday,fut)=>{
    const n=list.length;
    if(!n){
      if(isToday)return ` data-tip="今天 · ${key} · 还没读哦"`;
      return fut?'':` data-tip="${key} · 无阅读记录"`;
    }
    const names=list.slice(0,8).map(p=>p.label||p.title_en).join('、');
    return ` data-tip="${esc((isToday?'今天 · ':'')+key+` · 读了 ${n} 篇：${names}${n>8?'…':''}`)}"`;
  };
  const WEEK=['一','二','三','四','五','六','日'];
  const dimOf=m=>new Date(calYear,m+1,0).getDate(), leadOf=m=>(new Date(calYear,m,1).getDay()+6)%7;

  const smallMonth=m=>{
    let cells='', mSum=0;
    for(let i=0;i<leadOf(m);i++)cells+='<span class="mc-cell blank"></span>';
    for(let day=1;day<=dimOf(m);day++){
      const dt=new Date(calYear,m,day,12), key=fmt(dt);
      const list=byDate[key]||[], n=list.length, isToday=key===todayKey;
      stat(key,n); mSum+=n;
      const lvl=lvlOf(n);
      const cls='mc-cell'+(lvl?` l${lvl} hasread`:'')+(dt>today?' fut':'')+(isToday?' today':'');
      cells+=`<span class="${cls}"${tipOf(key,list,isToday,dt>today)}>${day}</span>`;
    }
    return `<div class="mcal${calYear===thisYear&&m===today.getMonth()?' cur':''}">
      <div class="mc-head"><b>${m+1} 月</b>${mSum?`<span class="mc-sum">${mSum} 篇</span>`:''}</div>
      <div class="mc-week">${WEEK.map(w=>`<span>${w}</span>`).join('')}</div><div class="mc-grid">${cells}</div></div>`;
  };
  const bigMonth=m=>{
    let cells='';
    for(let i=0;i<leadOf(m);i++)cells+='<div class="bmc blank"></div>';
    for(let day=1;day<=dimOf(m);day++){
      const dt=new Date(calYear,m,day,12), key=fmt(dt);
      const list=byDate[key]||[], n=list.length, isToday=key===todayKey;
      stat(key,n);
      const lvl=lvlOf(n);
      const CAP=40; // 全部渲染，超出 3 行的由 capCalRows() 在布局后收起
      const chips=list.slice(0,CAP).map(p=>`<span class="bmc-chip">${esc(p.label||p.title_en)}</span>`).join('');
      const inner=chips?`<div class="bmc-chips" data-total="${n}">${chips}</div>`:'';
      cells+=`<div class="bmc${lvl?' l'+lvl:''}${dt>today?' fut':''}${isToday?' today':''}"${tipOf(key,list,isToday,dt>today)}>
        <span class="bmc-d">${day}</span>${inner}</div>`;
    }
    return `<div class="bmc-week">${WEEK.map(w=>`<span>周${w}</span>`).join('')}</div><div class="bmc-grid">${cells}</div>`;
  };

  const body=calView==='year'
    ?`<div class="mcal-grid">${[...Array(12)].map((_,m)=>smallMonth(m)).join('')}</div>`
    :bigMonth(calMonth);
  const prevDis=calView==='year'?calYear<=minY:(calYear<=minY&&calMonth<=0);
  const nextDis=calView==='year'?calYear>=maxY:(calYear>=maxY&&calMonth>=11);
  const navLabel=calView==='year'?`${calYear} 年`:`${calYear} 年 ${calMonth+1} 月`;
  const range=calView==='year'?`${calYear} 年`:`${calYear} 年 ${calMonth+1} 月`;
  const histo=DATA.papers.filter(p=>p.done&&!p.read_date).length;
  const mix=n=>`color-mix(in srgb,var(--read) ${n}%,transparent)`;
  return `<div class="section"><div class="section-head"><h2>阅读日历</h2>
    <span class="sub">读得越多颜色越深 · 按标为已读的那天${histo?`（${histo} 篇已读的日期不详，未计入）`:''}</span>
    <span class="spacer"></span>
    <div class="seg" id="calViewSeg">
      <button data-v="year" class="${calView==='year'?'on':''}">按年</button>
      <button data-v="month" class="${calView==='month'?'on':''}">按月</button></div>
    <div class="cal-year">
      <button id="calPrev" ${prevDis?'disabled':''}>‹</button><b>${navLabel}</b>
      <button id="calNext" ${nextDis?'disabled':''}>›</button></div></div>
    <div class="card cal-card">${body}
    <div class="cal-foot"><span>${range}共读 <b style="color:var(--txt)">${logged}</b> 篇 · 有阅读的天数 ${days} 天${best.n?` · 单日最多 ${best.n} 篇（${best.date}）`:''}</span>
      <span class="cal-scale">少 <i style="background:var(--track)"></i><i style="background:${mix(30)}"></i><i style="background:${mix(55)}"></i><i style="background:${mix(80)}"></i><i style="background:var(--read)"></i> 多</span></div>
    </div></div>`;
}
// 把每个日格的论文标签裁到最多 3 行，超出的收成「还有 N 篇」（在布局后按实际换行计算）
const MAX_CAL_ROWS=3;
function capCalRows(){
  document.querySelectorAll('.bmc-chips').forEach(box=>{
    const chips=[...box.querySelectorAll('.bmc-chip')];
    if(!chips.length)return;
    const old=box.querySelector('.bmc-more'); if(old)old.remove();
    chips.forEach(c=>c.style.display='');
    const total=+box.dataset.total||chips.length;
    let tops=[...new Set(chips.map(c=>c.offsetTop))].sort((a,b)=>a-b);
    if(tops.length<=MAX_CAL_ROWS && total<=chips.length)return; // 3 行内且无未渲染的，直接放过
    let maxTop=tops[Math.min(MAX_CAL_ROWS,tops.length)-1];
    chips.forEach(c=>{if(c.offsetTop>maxTop)c.style.display='none';});
    const more=document.createElement('span'); more.className='bmc-more'; box.appendChild(more);
    const shown=()=>chips.filter(c=>c.style.display!=='none').length;
    more.textContent=`+${total-shown()}`;
    // 若「+N」把行数顶到第 4 行，逐个再收起最后一个可见标签
    let guard=0;
    while(more.offsetTop>maxTop && guard++<chips.length){
      const vis=chips.filter(c=>c.style.display!=='none');
      if(!vis.length)break;
      vis[vis.length-1].style.display='none';
      more.textContent=`+${total-shown()}`;
    }
  });
}
function bindCal(){
  const step=dir=>{
    if(calView==='year')calYear+=dir;
    else{
      calMonth+=dir;
      if(calMonth<0){calMonth=11;calYear--;}
      if(calMonth>11){calMonth=0;calYear++;}
    }
    render();
  };
  const p=$('#calPrev'), n=$('#calNext');
  if(p)p.addEventListener('click',()=>step(-1));
  if(n)n.addEventListener('click',()=>step(1));
  const seg=$('#calViewSeg');
  if(seg)seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{calView=b.dataset.v;render();}));
}

/* categories */
// 书单：选中一个，就只看它里面的论文，并按它的顺序标出名次
const rankIn=(p,list)=>(p.ranks||{})[list];
function catRankKey(){return catListView==='all'?null:catListView;}
function catViewModel(){
  const rankKey=catRankKey();
  const base=rankKey?DATA.papers.filter(p=>rankIn(p,rankKey)):DATA.papers.slice();
  const q=catQ.trim().toLowerCase();
  const papers=q?base.filter(p=>{
    const hay=[p.title_en,p.title_zh,p.label,p.cat_disp,p.sub_disp,p.venue].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }):base;
  let cats=DATA.categories.map((c,i)=>{
    const cp=papers.filter(p=>p.cat_disp===c.disp);
    const subs=c.subs.map(s=>{
      const sp=cp.filter(p=>p.sub_disp===s.disp);
      if(rankKey)sp.sort((a,b)=>rankIn(a,rankKey)-rankIn(b,rankKey));
      return {...s,total:sp.length,read:sp.filter(p=>p.done).length,papers:sp};
    }).filter(s=>s.total>0);
    return {...c,_i:i,total:cp.length,read:cp.filter(p=>p.done).length,subs};
  }).filter(c=>c.total>0);
  if(sortMode==='pct')cats.sort((a,b)=>pctOf(b.read,b.total)-pctOf(a.read,a.total));
  else if(sortMode==='unread')cats.sort((a,b)=>(b.total-b.read)-(a.total-a.read));
  const subTotal=cats.reduce((n,c)=>n+c.subs.length,0);
  const subDone=cats.reduce((n,c)=>n+c.subs.filter(s=>s.total>0&&s.read===s.total).length,0);
  return {rankKey,base,papers,cats,subTotal,subDone};
}
function catMetaHTML(m){
  if(catListView==='all'){
    return `${m.cats.length} 个大类 · ${m.subTotal} 个子类 · 已读完 <span class="done-count">${m.subDone} 个（${pctOf(m.subDone,m.subTotal)}%）</span>（展开子类后，点击论文先预览笔记）`;
  }
  const who='「'+esc(catListView)+'」';
  const read=m.base.filter(p=>p.done).length;
  const hit=catQ.trim()?` · 搜索命中 <span class="done-count">${m.papers.length}</span> 篇`:'';
  return `${who} ${m.base.length} 篇 · 已读 <span class="done-count">${read} 篇（${pctOf(read,m.base.length)}%）</span> · ${m.cats.length} 个大类 · ${m.subTotal} 个子类${hit}`;
}
function catRowsHTML(m){
  if(!m.cats.length)return '<div class="empty">没有匹配的论文</div>';
  return m.cats.map(c=>{
    const col=RAW_COLORS[c._i%8], pct=pctOf(c.read,c.total);
    const subs=c.subs.map(s=>{
      const papers=s.papers.map(p=>paperMini(p,m.rankKey?rankIn(p,m.rankKey):null)).join('')||'<div class="vp">（无）</div>';
      return `<div class="sub-row click sub-toggle"><span class="chev">▶</span>
        <div class="sub-name">${esc(s.disp)}</div>
        <div class="sub-bar"><i data-w="${pctOf(s.read,s.total)}" style="background:${col}"></i></div>
        <div class="sub-frac">${s.read}/${s.total}</div></div>
        <div class="venue-papers">${papers}</div>`;
    }).join('');
    return `<div><div class="brow click" data-cat><div class="btop">
        <span class="swatch" style="color:${col};background:${col}"></span>
        <span class="bname">${esc(c.disp)}<span class="chev">▶</span></span><span class="bspacer"></span>
        <span class="bfrac"><b>${c.read}</b> / ${c.total}</span><span class="bpct" style="color:${col}">${pct}%</span></div>
      <div class="bar"><i data-w="${pct}" style="background:linear-gradient(90deg,${col}aa,${col})"></i></div></div>
      <div class="subs">${subs}</div></div>`;
  }).join('');
}
function catsHTML(){
  const m=catViewModel();
  const search=catListView==='all'?'':`<input id="catQ" class="cat-search" type="search" placeholder="在这个书单里搜索…" value="${esc(catQ)}">`;
  return `<div class="section" id="catSection"><div class="section-head"><h2>按知识类别</h2>
    <span class="sub" id="catMeta">${catMetaHTML(m)}</span><span class="spacer"></span>
    <div class="seg" id="catSort">
      <button data-s="order" class="${sortMode==='order'?'on':''}">默认顺序</button>
      <button data-s="pct" class="${sortMode==='pct'?'on':''}">完成度</button>
      <button data-s="unread" class="${sortMode==='unread'?'on':''}">未读最多</button></div></div>
    ${DATA.lists.length?`<div class="cat-toolbar"><div class="cat-tags" id="catListTabs">${DATA.lists.map((l,i)=>
      `<button type="button" class="cat-tag ${i%2?'claude':'codex'} ${catListView===l.name?'on':''}" data-v="${esc(l.name)}" title="${esc((l.note?l.note+' · ':'')+'再次点击返回全部论文')}">${esc(l.name)}</button>`).join('')}</div>${search}</div>`:''}
    <div class="card row-card" id="catRows">${catRowsHTML(m)}</div></div>`;
}

/* venues / CCF */
const BADGE={'A':'#f6c453','B':'#8fb3ff','C':'#7ee0a0'};
function papersOf(venue){return DATA.papers.filter(p=>p.venue===venue);}
function paperMini(p,recRank=null){
  return `<button type="button" class="vp link paper-preview" data-paper-index="${paperIndex(p)}"
    aria-label="${esc('预览 '+(p.label||p.title_en)+' 的笔记')}"><span class="d ${p.done?'done':'todo'}"></span>
    ${recRank?`<span class="rec-rank">#${recRank}</span>`:''}
    <span class="pt">${esc(p.title_en)}${p.label&&p.label!==p.title_en?`（${esc(p.label)}）`:''}</span>
    <span class="vpy">${p.year??'—'}</span><span class="popen" title="先预览笔记">›</span></button>`;
}
function venueRow(v,col){
  const tag=`<span class="vtag">${esc(v.vtype||'')}</span>`;
  const badge=BADGE[v.rank]?`<span class="vbadge" style="background:${BADGE[v.rank]}">${v.rank}</span>`:'';
  if(v.uncovered) return `<div class="vrow dim"><span class="chev" style="visibility:hidden">▶</span>
    <span class="vn">${esc(v.name)}</span>${tag}${badge}<span class="vbar"></span><span class="vf">未覆盖</span></div>`;
  const pct=v.total?Math.round(v.read/v.total*100):0;
  const papers=papersOf(v.name).map(paperMini).join('')||'<div class="vp">（无）</div>';
  return `<div class="vrow click venue-row"><span class="chev">▶</span>
      <span class="vn">${esc(v.name)}</span>${tag}${badge}
      <span class="vbar"><i style="width:${pct}%;background:${col}"></i></span>
      <span class="vf">${v.read}/${v.total}</span></div>
    <div class="venue-papers">${papers}</div>`;
}
function donutHTML(ccf){
  const total=DATA.totals.total||1, R=70, C=2*Math.PI*R; let off=0;
  const segs=ccf.map(c=>{
    const len=c.total/total*C, col=CCF_COLORS[c.name]||'#9aa6c4';
    const dash=Math.max(len-2.5,0);
    const s=`<circle cx="90" cy="90" r="${R}" fill="none" stroke="${col}" stroke-width="19"
      stroke-dasharray="0 ${C}" data-dash="${dash} ${C-dash}" stroke-dashoffset="${-off}"
      transform="rotate(-90 90 90)" style="transition:stroke-dasharray 1.1s cubic-bezier(.2,.8,.2,1)"
      data-tip="${esc(c.name)}：${c.total} 篇（占 ${pctOf(c.total,total)}%）· 已读 ${c.read}"/>`;
    off+=len; return s;
  }).join('');
  const a=ccf.find(c=>c.name==='CCF-A')||{total:0};
  return `<div class="donut-wrap"><div class="donut">
    <svg width="180" height="180" viewBox="0 0 180 180">${segs}</svg>
    <div class="donut-center"><div class="da" style="color:${CCF_COLORS['CCF-A']}">${pctOf(a.total,total)}%</div>
    <div class="db">为 CCF-A</div></div></div></div>`;
}
function venuesHTML(){
  const ccf=DATA.ccf.filter(c=>c.total>0);
  const ccfRows=ccf.map((c,ci)=>{
    const col=CCF_COLORS[c.name]||'#9aa6c4', pct=pctOf(c.read,c.total), open=ci===0;
    const venueList=(c.venues||[]).map(v=>venueRow(v,col)).join('');
    return `<div class="brow click ccf-bucket ${open?'open':''}"><div class="btop">
        <span class="swatch" style="color:${col};background:${col}"></span>
        <span class="bname">${esc(c.name)}<span class="chev">▶</span></span><span class="bspacer"></span>
        <span class="bfrac"><b>${c.read}</b> / ${c.total}</span><span class="bpct" style="color:${col}">${pct}%</span></div>
      <div class="bar"><i data-w="${pct}" style="background:linear-gradient(90deg,${col}aa,${col})"></i></div></div>
      <div class="bucket-body ${open?'open':''}">${venueList}</div>`;
  }).join('');

  const typeIcon={'会议':'🎤','期刊':'📰','预印本':'📄','未知':'❓'};
  const typeBoxes=DATA.vtypes.filter(c=>c.total>0).map(c=>
    `<div class="typebox click ${venueTypeFilter===c.name?'on':''}" data-type="${esc(c.name)}">
      <div class="t">${typeIcon[c.name]||''} ${esc(c.name)}</div><div class="v">${c.total}</div>
      <div class="s">已读 ${c.read} · ${pctOf(c.read,c.total)}%</div></div>`).join('');

  let vlist=DATA.venuesAll.slice();
  if(venueTypeFilter) vlist=vlist.filter(v=>v.vtype===venueTypeFilter);
  else vlist=vlist.filter(v=>v.name!=='arXiv');
  vlist=vlist.slice(0,12);
  const tv=vlist.map((v,i)=>{
    const badge=BADGE[v.rank]?`<span class="vbadge" style="background:${BADGE[v.rank]}">${v.rank}</span>`:'';
    const papers=papersOf(v.name).map(paperMini).join('')||'<div class="vp">（无）</div>';
    return `<div class="tv venue-row" data-venue="${esc(v.name)}"><span class="rank">${i+1}</span><span class="chev">▶</span><span class="vn">${esc(v.name)}</span>
      <span class="vtag">${esc(v.vtype)}</span>${badge}
      <span class="vbar"><i data-w="${pctOf(v.read,v.total)}" style="background:var(--accent)"></i></span>
      <span class="vf">${v.read}/${v.total}</span></div>
      <div class="venue-papers">${papers}</div>`;
  }).join('')||'<div class="empty">该类型暂无渠道</div>';
  const listTitle=venueTypeFilter?`热门${venueTypeFilter} Top ${vlist.length}`:`热门发表渠道 Top ${vlist.length}`;

  return `<div class="section"><div class="section-head"><h2>按发表渠道与 CCF 等级</h2>
    <span class="sub">依 CCF 2026 第七版（ICLR 已升 A）；Nature / COLM / TMLR 等未列入目录，归为「无CCF评级」</span></div>
    <div class="vgrid">
      <div class="card vcard"><h3>CCF 等级分布<span class="hint">点击等级展开渠道，再点论文预览笔记</span></h3>${donutHTML(ccf)}${ccfRows}</div>
      <div class="card vcard"><h3>发表类型<span class="hint">点击可筛选下方渠道</span></h3>
        <div class="typestat">${typeBoxes}</div>
        <h3>${listTitle}<span class="hint">蓝条 = 已读占比</span></h3><div class="tvlist">${tv}</div></div>
    </div></div>`;
}

/* years */
function yearsHTML(){
  const ys=DATA.years, max=Math.max(...ys.map(y=>y.total),1);
  const cols=ys.map(y=>{
    const h=Math.round(y.total/max*100), inner=y.total?Math.round(y.read/y.total*100):0;
    const lab=(y.year==='未知')?'未知':y.year, full=y.read===y.total&&y.total>0;
    return `<div class="ycol" data-tip="${lab}年：已读 ${y.read} / 共 ${y.total}（${pctOf(y.read,y.total)}%）">
      <div class="ystack ${full?'full':''}" style="height:max(${h}%,10px)"><span class="ynum">${y.total}</span><i data-h="${inner}"></i></div><div class="ylab">${lab}</div></div>`;
  }).join('');
  return `<div class="section"><div class="section-head"><h2>按年份分布</h2>
    <span class="sub">柱高=该年论文数，亮色填充=已读</span></div>
    <div class="card year-card"><div class="chart">${cols}</div>
      <div class="legend"><span><i style="background:var(--track-hover)"></i>该年总数</span>
        <span><i style="background:linear-gradient(180deg,var(--read2),var(--read))"></i>已读</span>
        <span><i style="background:var(--c3)"></i>该年已读完 🎉</span></div></div></div>`;
}

/* explorer —— 各筛选支持多选 */
function venueBucketMap(){
  const m={}; (DATA.ccf||[]).forEach(c=>(c.venues||[]).forEach(v=>{if(!v.uncovered)m[v.name]=c.name;})); return m;
}
function venueTypeMap(){const m={};DATA.venuesAll.forEach(v=>m[v.name]=v.vtype);return m;}
function venueAllowed(name){ // 渠道是否符合当前已选的 CCF 等级 + 发表类型
  const bm=venueBucketMap(), tm=venueTypeMap();
  return (!fState.ccf.length||fState.ccf.includes(bm[name])) &&
         (!fState.vtype.length||fState.vtype.includes(tm[name]));
}
function pruneVenue(){ fState.venue=fState.venue.filter(venueAllowed); }
function venueOpts(){ // 渠道选项，受已选 CCF 等级 + 发表类型联动
  return DATA.venuesAll.filter(v=>venueAllowed(v.name))
    .map(v=>({value:v.name, text:`${v.name}（${v.vtype}·${v.total}）`}));
}
// 各多选筛选器的配置（venue 的选项动态生成）
function filterDefs(){
  return [
    {key:'status', all:'全部状态', base:'状态',
      opts:[{value:'done',text:'已读'},{value:'todo',text:'未读'}]},
    {key:'ccf', all:'全部CCF等级', base:'CCF',
      opts:DATA.ccf.filter(c=>c.total>0).map(c=>({value:c.name,text:`${c.name}（${c.total}）`}))},
    {key:'vtype', all:'全部类型', base:'类型',
      opts:DATA.vtypes.filter(c=>c.total>0).map(c=>({value:c.name,text:`${c.name}（${c.total}）`}))},
    {key:'venue', all:'全部渠道', base:'渠道', opts:venueOpts()},
    {key:'cat', all:'全部类别', base:'类别',
      opts:DATA.categories.map(c=>({value:c.disp,text:`${c.disp}（${c.total}）`}))},
    {key:'year', all:'全部年份', base:'年份',
      opts:DATA.years.map(y=>({value:String(y.year),text:(y.year==='未知'?'未知':y.year+'年')}))},
  ];
}
function msSummary(def){
  const sel=fState[def.key];
  if(!sel.length) return def.all;
  if(sel.length===1){const o=def.opts.find(o=>o.value===sel[0]); return o?o.text.replace(/（.*）/,''):sel[0];}
  return `${def.base} · ${sel.length}`;
}
function msWidget(def){
  const sel=fState[def.key];
  const opts=def.opts.map(o=>`<div class="ms-opt ${sel.includes(o.value)?'sel':''}" data-value="${esc(o.value)}"><span class="ms-check">✓</span><span>${esc(o.text)}</span></div>`).join('');
  return `<div class="ms ${sel.length?'active':''}" data-key="${def.key}">
    <button type="button" class="ms-btn"><span class="ms-lbl">${esc(msSummary(def))}</span><span class="caret">▾</span></button>
    <div class="ms-panel"><div class="ms-actions"><span class="lbl">可多选</span><button type="button" class="ms-clear">清空</button></div>${opts}</div></div>`;
}
function explorerHTML(){
  const widgets=filterDefs().map(msWidget).join('');
  return `<div class="section"><div class="section-head"><h2>论文浏览器</h2><span class="sub">搜索 / 多选筛选并点开伴读笔记</span></div>
    <div class="card exp-card"><div class="filters">
      <input id="fq" type="text" placeholder="🔍 搜索标题、简称或渠道（如 LSTM、NeurIPS）…" value="${esc(fState.q)}">
      ${widgets}
    </div><div class="exp-count" id="expCount"></div><div class="plist" id="plist"></div></div></div>`;
}
function renderList(){
  const list=DATA.papers.filter(p=>{
    if(fState.status.length&&!fState.status.includes(p.done?'done':'todo'))return false;
    if(fState.ccf.length&&!fState.ccf.includes(p.ccfBucket))return false;
    if(fState.vtype.length&&!fState.vtype.includes(p.vtype))return false;
    if(fState.venue.length&&!fState.venue.includes(p.venue))return false;
    if(fState.cat.length&&!fState.cat.includes(p.cat_disp))return false;
    if(fState.year.length&&!fState.year.includes(String(p.year??'未知')))return false;
    if(fState.q){const q=fState.q.toLowerCase();
      const hay=(p.title_en+' '+p.title_zh+' '+(p.label||'')+' '+(p.venue||'')+' '+(p.ccfBucket||'')).toLowerCase();
      if(!hay.includes(q))return false;}
    return true;
  });
  const done=list.filter(p=>p.done).length;
  $('#expCount').innerHTML=`匹配 <b style="color:var(--txt)">${list.length}</b> 篇 · 其中已读 ${done} 篇`;
  const ci=name=>{const i=DATA.categories.findIndex(c=>c.disp===name);return i<0?'var(--txt-faint)':RAW_COLORS[i%8];};
  $('#plist').innerHTML=list.map((p,i)=>{
    const vc=CCF_COLORS[p.ccfBucket]||'#9aa6c4';
    const vlabel=esc(p.venue)+(['A','B','C'].includes(p.ccf)?'·'+p.ccf:'');
    const jump=p.note?`<button type="button" class="popen note-jump" data-open="${esc(p.note)}" title="在页间里打开">↗</button>`:'<span class="popen"></span>';
    return `<div class="prow link" data-pi="${i}"><span class="pstatus ${p.done?'done':'todo'}"></span>
      <div class="pmain"><div class="pen">${esc(p.title_en)}${p.label&&p.label!==p.title_en?`<span class="plabel">（${esc(p.label)}）</span>`:''}</div>${p.title_zh?`<div class="pzh">${esc(p.title_zh)}</div>`:''}</div>
      <div class="pmeta"><span class="vchip" style="background:${vc}22;color:${vc}">${vlabel}</span>
        <span class="chip cat" style="color:${ci(p.cat_disp)}">${esc(p.cat_disp||'—')}</span>
        <span class="pyear">${p.year??'—'}</span>${jump}</div></div>`;
  }).join('')||'<div class="empty">没有符合条件的论文</div>';
  document.querySelectorAll('#plist .prow').forEach(r=>r.addEventListener('click',e=>{
    if(e.target.closest('.note-jump'))return; // ↗ 直接打开，不弹窗
    openPaper(list[+r.dataset.pi]);
  }));
}

/* paper detail modal */
function notesUL(nodes){
  return `<ul class="pd-notes">${nodes.map(n=>`<li>${n.t?esc(n.t):''}${n.img?`<img src="${n.img}" loading="lazy">`:''}${n.kids?notesUL(n.kids):''}</li>`).join('')}</ul>`;
}
let openId=null;
function openPaper(p){
  const vc=CCF_COLORS[p.ccfBucket]||'#9aa6c4';
  const sum=(p.summary&&p.summary.length)?`<div class="pd-sec"><h4>💡 一句话总结</h4>
    <div class="pd-sum">${p.summary.map(esc).join('<br><br>')}</div></div>`:'';
  const notes=(p.notes&&p.notes.length)?`<div class="pd-sec"><h4>✍️ 我的笔记</h4>${notesUL(p.notes)}</div>`:'';
  const files=(p.files||[]).map(f=>`<button type="button" class="iconbtn" data-open="${esc(f)}" title="在页间里打开 ${esc(f)}">📖 ${esc(f.split('/').pop())}</button>`).join('');
  $('#pmodalCard').innerHTML=`
    <div class="pd-top"><div><div class="pd-title">${esc(p.title_en)}</div>
      ${p.title_zh?`<div class="pd-zh">${esc(p.title_zh)}</div>`:''}</div>
      <button class="pd-close" id="pdClose">✕</button></div>
    <div class="pd-meta">
      <span class="pstatus ${p.done?'done':'todo'}"></span><span class="chip">${p.done?'已读'+(p.read_date?' · '+p.read_date:''):p.reading?'在读':'未读'}</span>
      ${p.label&&p.label!==p.title_en?`<span class="chip">${esc(p.label)}</span>`:''}
      <span class="vchip" style="background:${vc}22;color:${vc}">${esc(p.venue)}${['A','B','C'].includes(p.ccf)?'·'+p.ccf:''}</span>
      <span class="chip">${esc(p.cat_disp||'—')} · ${esc(p.sub_disp||'—')}</span>
      <span class="chip">${p.year??'—'}</span></div>
    ${p.authors?`<div class="pd-authors">${esc(p.authors)}</div>`:''}
    ${sum}${notes}<div id="pdMarks"></div>
    <div class="pd-actions">${files}
      <button type="button" class="iconbtn" id="pdToggle">${p.done?'↩︎ 改回未读':'✅ 标为已读'}</button>
      ${p.link?`<button type="button" class="iconbtn" data-external="${esc(p.link)}">🔗 论文主页</button>`:''}</div>`;
  $('#pmodal').classList.add('open');
  $('#pdClose').addEventListener('click',closePaper);
  $('#pdToggle').addEventListener('click',()=>
    folio.library.update(p.id,{status:p.done?'unread':'done'}).then(closePaper,err=>toast(err.message)));
  document.body.style.overflow='hidden';
  // 在页间里读这篇时划的重点和写的文档笔记，读到了再补进来
  openId=p.id;
  folio.library.get(p.id).then(d=>{
    const box=$('#pdMarks'); if(!box||openId!==p.id)return;
    let html='';
    (d.documents||[]).forEach(doc=>{
      const hl=(doc.highlights||[]).filter(x=>x.text);
      if(hl.length)html+=`<div class="pd-sec"><h4>🖍️ 划的重点（${hl.length}）</h4><ul class="pd-notes">${hl.slice(0,40).map(x=>
        `<li>${esc(x.text)}${x.note?`<ul class="pd-notes"><li>${esc(x.note)}</li></ul>`:''}</li>`).join('')}</ul></div>`;
      if(doc.note&&doc.note.trim())html+=`<div class="pd-sec"><h4>📝 文档笔记</h4><div class="pd-sum pd-pre">${esc(doc.note.trim().slice(0,3000))}</div></div>`;
    });
    if(!html&&!sum&&!notes)html='<div class="pd-sec pd-empty">这篇还没有总结和笔记。在页间里读它时划的重点、写的笔记会显示在这里。</div>';
    box.innerHTML=html;
  }).catch(()=>{});
}
function closePaper(){openId=null;$('#pmodal').classList.remove('open');document.body.style.overflow='';}

/* interactions */
function bindCatRows(root=document){
  root.querySelectorAll('[data-cat]').forEach(r=>r.addEventListener('click',()=>r.classList.toggle('open')));
  root.querySelectorAll('.sub-toggle').forEach(r=>r.addEventListener('click',()=>{
    r.classList.toggle('open'); const b=r.nextElementSibling; if(b)b.classList.toggle('open');}));
}
function refreshCatContent(){
  const rows=$('#catRows'), meta=$('#catMeta'); if(!rows||!meta)return;
  const m=catViewModel(); meta.innerHTML=catMetaHTML(m); rows.innerHTML=catRowsHTML(m);
  bindCatRows(rows); bindPaperPreviews(rows);
  requestAnimationFrame(()=>rows.querySelectorAll('[data-w]').forEach(i=>i.style.width=i.dataset.w+'%'));
}
function bindCats(){
  bindCatRows($('#catRows')||document);
  const tabs=$('#catListTabs');
  if(tabs)tabs.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    catListView=catListView===b.dataset.v?'all':b.dataset.v; catQ='';
    prefs.list=catListView; savePrefs(); render();
  }));
  const seg=$('#catSort');
  if(seg)seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    sortMode=b.dataset.s; seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b)); refreshCatContent();
  }));
  const q=$('#catQ');
  if(q)q.addEventListener('input',e=>{catQ=e.target.value;refreshCatContent();});
}
function bindWall(){
  const seg=$('#wallSortSeg');
  if(seg)seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{wallSort=b.dataset.s;render();}));
  const q=$('#wallQ');
  if(q)q.addEventListener('input',e=>{wallQ=e.target.value;applyWallSearch();});
  applyWallSearch();
}
function bindPaperPreviews(root=document){
  root.querySelectorAll('[data-paper-index]').forEach(el=>el.addEventListener('click',()=>{
    const p=DATA.papers[Number(el.dataset.paperIndex)];
    if(p)openPaper(p);
  }));
}
function applyWallSearch(){
  const wall=document.querySelector('.wall'); if(!wall)return;
  const q=wallQ.trim().toLowerCase();
  wall.classList.toggle('searching',!!q);
  let hits=0;
  wall.querySelectorAll('.cell').forEach(c=>{
    const hit=!!q&&(c.dataset.q||'').includes(q);
    c.classList.toggle('hit',hit); if(hit)hits++;
  });
  const cnt=$('#wallQCount');
  if(cnt)cnt.textContent=q?(hits?`命中 ${hits} 篇`:'无命中'):'';
}
function bindVenues(){
  document.querySelectorAll('.ccf-bucket').forEach(r=>r.addEventListener('click',()=>{
    r.classList.toggle('open'); const b=r.nextElementSibling; if(b)b.classList.toggle('open');}));
  document.querySelectorAll('.venue-row').forEach(r=>r.addEventListener('click',()=>{
    r.classList.toggle('open'); const b=r.nextElementSibling; if(b)b.classList.toggle('open');}));
  document.querySelectorAll('.typebox.click').forEach(b=>b.addEventListener('click',()=>{
    venueTypeFilter=(venueTypeFilter===b.dataset.type)?null:b.dataset.type; render();}));
}
function refreshMs(key){ // 重画某个多选器的汇总文字与高亮（不重建整块，保持面板开着）
  const def=filterDefs().find(d=>d.key===key); if(!def)return;
  const el=document.querySelector(`.ms[data-key="${key}"]`); if(!el)return;
  el.querySelector('.ms-lbl').textContent=msSummary(def);
  el.classList.toggle('active', fState[key].length>0);
}
function rebuildVenueMs(){ // CCF 变化后，重建渠道多选器的可选项
  const el=document.querySelector('.ms[data-key="venue"]'); if(!el)return;
  const def=filterDefs().find(d=>d.key==='venue');
  const wasOpen=el.classList.contains('open');
  el.outerHTML=msWidget(def);
  const fresh=document.querySelector('.ms[data-key="venue"]');
  if(wasOpen)fresh.classList.add('open');
  bindMs(fresh);
}
function bindMs(el){
  const key=el.dataset.key;
  el.querySelector('.ms-btn').addEventListener('click',ev=>{
    ev.stopPropagation();
    const wasOpen=el.classList.contains('open');
    document.querySelectorAll('.ms.open').forEach(o=>o.classList.remove('open'));
    if(!wasOpen)el.classList.add('open');
  });
  el.querySelector('.ms-panel').addEventListener('click',ev=>ev.stopPropagation());
  el.querySelectorAll('.ms-opt').forEach(opt=>opt.addEventListener('click',()=>{
    const val=opt.dataset.value, i=fState[key].indexOf(val);
    if(i>=0){fState[key].splice(i,1); opt.classList.remove('sel');}
    else{fState[key].push(val); opt.classList.add('sel');}
    refreshMs(key);
    if(key==='ccf'||key==='vtype'){ // 联动：等级/类型变了，裁剪并重建渠道选项
      pruneVenue(); rebuildVenueMs();
    }
    renderList();
  }));
  el.querySelector('.ms-clear').addEventListener('click',()=>{
    fState[key]=[];
    el.querySelectorAll('.ms-opt.sel').forEach(o=>o.classList.remove('sel'));
    refreshMs(key);
    if(key==='ccf'||key==='vtype'){pruneVenue(); rebuildVenueMs();}
    renderList();
  });
}
function bindFilters(){
  const q=$('#fq'); if(!q)return;
  q.addEventListener('input',e=>{fState.q=e.target.value;renderList();});
  document.querySelectorAll('.filters .ms').forEach(bindMs);
  renderList();
}
function animate(){
  const arc=$('#ringArc'); if(arc)arc.setAttribute('stroke-dasharray',arc.dataset.target+' '+(2*Math.PI*86));
  document.querySelectorAll('[data-w]').forEach(i=>i.style.width=i.dataset.w+'%');
  document.querySelectorAll('.ystack>i[data-h]').forEach(i=>i.style.height=i.dataset.h+'%');
  document.querySelectorAll('[data-dash]').forEach(s=>s.setAttribute('stroke-dasharray',s.dataset.dash));
  document.querySelectorAll('[data-count]').forEach(countUp);
}
function countUp(el){
  const target=parseFloat(el.dataset.count),suffix=el.dataset.suffix||'',dur=900,t0=performance.now(),dec=target%1!==0;
  (function step(t){const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3),v=target*e;
    el.textContent=(dec?v.toFixed(1):Math.round(v))+suffix; if(k<1)requestAnimationFrame(step);})(t0);
}
let toastT;
function toast(m){const el=$('#toast');el.textContent='🔄 '+m;el.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),2600);}

// 即时悬浮提示（替代原生 title 的延迟）。事件委托，re-render 后无需重新绑定。
(function(){
  const tip=$('#chartTip');
  document.addEventListener('mouseover',e=>{
    const el=e.target.closest('[data-tip]'); if(!el)return;
    tip.textContent=el.dataset.tip; tip.classList.add('show');
  });
  document.addEventListener('mousemove',e=>{
    if(!tip.classList.contains('show'))return;
    const x=Math.min(e.clientX+13, innerWidth-tip.offsetWidth-8), y=Math.max(8, e.clientY-36);
    tip.style.left=x+'px'; tip.style.top=y+'px';
  });
  document.addEventListener('mouseout',e=>{ if(e.target.closest('[data-tip]')) tip.classList.remove('show'); });
  // 点击空白处关闭所有多选面板（只绑定一次）
  document.addEventListener('click',()=>document.querySelectorAll('.ms.open').forEach(o=>o.classList.remove('open')));
  // 窗口尺寸变化时，重新计算日历标签的 3 行裁剪（列宽变了）
  let rzT; addEventListener('resize',()=>{clearTimeout(rzT);rzT=setTimeout(capCalRows,150);});
  // 论文详情弹窗：点遮罩或按 Esc 关闭
  $('#pmodal').addEventListener('click',e=>{if(e.target.id==='pmodal')closePaper();});
  // 笔记图片：双击放大（灯箱），点灯箱任意处或 Esc 关闭
  document.addEventListener('dblclick',e=>{
    const img=e.target.closest('.pd-notes img'); if(!img)return;
    $('#imgboxImg').src=img.src; $('#imgbox').classList.add('open');
  });
  $('#imgbox').addEventListener('click',()=>$('#imgbox').classList.remove('open'));
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;
    const box=$('#imgbox');
    if(box.classList.contains('open'))box.classList.remove('open');
    else closePaper();
  });
})();
$('#refreshBtn').addEventListener('click',()=>load(true));
// 带 data-open 的地方：在页间的阅读区打开那篇文档；带 data-external 的：用浏览器打开网页
document.addEventListener('click',e=>{
  const doc=e.target.closest('[data-open]'), web=e.target.closest('[data-external]');
  if(!doc&&!web)return;
  e.preventDefault();
  (doc?folio.open(doc.dataset.open):folio.openExternal(web.dataset.external)).catch(err=>toast(err.message));
});
// 文献库一变（标了已读、加了论文），页间会告诉这里
folio.on('library',()=>load(false));
folio.storage.get().then(v=>{if(v&&typeof v==='object')prefs={...prefs,...v}; catListView=prefs.list||'all';},()=>{})
  .then(()=>{applyTheme(); document.documentElement.setAttribute('data-ready',''); load(true);});
