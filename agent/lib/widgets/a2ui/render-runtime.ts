/**
 * The parts of the style sheet and of the script A2UI widgets are assembled from.
 *
 * Exports:
 * - `STYLE_PARTS`: CSS by feature, on Telegram's theme variables only.
 * - `RUNTIME_PARTS`: script by feature: tabs, check marks and options kept on the device, countdowns,
 *   the quiz, presses sent to the bot, and the agent's updates applied from the shared state.
 * - `WIDGET_TEXTS`: the Russian texts the script shows.
 *
 * Key constructs:
 * - Values arrive computed (`render.ts`), so the script only switches and sends; each part is the same
 *   for every widget that uses it.
 * - A request to the bot is made only inside a tap handler, synchronously: Telegram refuses one made
 *   later, and a request without a tap would be a paid agent turn nobody asked for.
 * - The script reads its widget's data from `D` (written before it by `render-assets.ts`): `r` the
 *   revision the HTML was built at, `n` the choice bits, `q` the quiz, `f` the quiz's finish action.
 * - Choice bits are packed six per character of the base64url alphabet; `update`-free decoding lives
 *   in `widget-query-data.ts` and must stay in step with `pack` here.
 * - Muted text uses the hint colour, not opacity, which Telegram counts against its paint limit.
 * - Plain ES2023 that QuickJS runs; no library. Compact on purpose: every byte is sent with the widget.
 */

export const WIDGET_TEXTS = {
  busy: "Ещё обрабатываю прошлое нажатие",
  closed: "Виджет больше не принимает нажатия",
  copy: "Нажатия работают в исходном сообщении",
  failed: "Не отправлено, нажмите ещё раз",
  rate: "Слишком часто, подождите пару секунд",
  sending: "Отправляю…",
  sent: "✓ Отправлено",
} as const;

const SEPARATOR = "var(--tg-theme-section-separator-color,#8883)";

export const STYLE_PARTS = {
  base: [
    "body{margin:0;padding:12px 14px;font:15px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color)}",
    ".c,.l{display:flex;flex-direction:column;gap:8px}.r{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
    `.lh{flex-direction:row;flex-wrap:wrap}.l>*+*{border-top:1px solid ${SEPARATOR};padding-top:8px}.lh>*+*{border-top:0;padding-top:0}`,
    ".as{align-items:flex-start}.ac{align-items:center}.ae{align-items:flex-end}.ax{align-items:stretch}",
    ".js{justify-content:flex-start}.jc{justify-content:center}.je{justify-content:flex-end}.jb{justify-content:space-between}.ja{justify-content:space-around}",
    ".k{background:var(--tg-theme-secondary-bg-color);border-radius:12px;padding:10px 12px}",
    ".t1{font-size:18px;font-weight:600}.t2{font-weight:600}.cp{font-size:13px;color:var(--tg-theme-hint-color)}",
    `.dv{height:1px;align-self:stretch;background:${SEPARATOR}}.dvv{width:1px;align-self:stretch;background:${SEPARATOR}}`,
    "button{font:inherit;border:0;border-radius:10px;padding:9px 12px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)}",
    ".bp,.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}.bb{background:none;color:var(--tg-theme-link-color);padding:4px 0}",
  ].join(""),
  badge: ".bd{display:inline-block;padding:2px 9px;border-radius:10px;font-size:13px;background:var(--tg-theme-secondary-bg-color)}.ta{color:var(--tg-theme-button-color)}.tg{color:#2e9d57;background:#2e9d5726}.tw{color:#c77a0a;background:#e0952026}.tx{color:#d14;background:#dd114426}",
  chart: "svg{width:100%;height:auto}svg text{font:10px system-ui;fill:var(--tg-theme-hint-color)}",
  countdown: ".cd{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}",
  inputs: ".x{text-align:left}.x:before{content:'○ '}.x.on:before{content:'✓ '}",
  progress: ".pg{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color)}.pg i{display:block;height:6px;border-radius:3px;background:var(--tg-theme-button-color)}",
  quiz: ".qo{display:flex;flex-direction:column;gap:6px;margin-top:8px}.ok{background:#2e9d57;color:#fff}.no{background:#d14;color:#fff}",
  table: `table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--tg-theme-hint-color);font-weight:500}td,th{padding:4px 6px;border-bottom:1px solid ${SEPARATOR}}`,
  tabs: ".tb{display:flex;gap:6px;flex-wrap:wrap}.hd{display:none}",
} as const;

const T = WIDGET_TEXTS;
const text = (value: string) => JSON.stringify(value);

export const RUNTIME_PARTS = {
  // $ finds by id, Q all by selector, W is TelegramWidget (absent outside Telegram).
  helpers: "const W=window.TelegramWidget,$=i=>document.getElementById(i),Q=s=>[...document.querySelectorAll(s)];",
  core: "let B=D.n,R=D.r;try{const s=localStorage.getItem('s');if(s&&s.length===B.length)B=s}catch(e){}"
    + "const set=(i,v)=>{B=B.slice(0,i)+(v?'1':'0')+B.slice(i+1);try{localStorage.setItem('s',B)}catch(e){}},"
    + "paint=()=>Q('[data-i]').forEach(e=>e.classList.toggle('on',B[+e.dataset.i]==='1')),"
    + "pack=()=>{let o='';for(let i=0;i<B.length;i+=6)o+='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[parseInt(B.slice(i,i+6).padEnd(6,'0'),2)];return o};",
  send: `const say={NOT_ALLOWED:${text(T.copy)},BUSY:${text(T.sending)},RATE_LIMITED:${text(T.rate)}},`
    + "send=(b,d)=>{if(!W||b.dataset.w)return;const l=b.textContent,done=(t,ms)=>{b.textContent=t;setTimeout(()=>{b.textContent=l;delete b.dataset.w},ms)};"
    + `b.dataset.w=1;b.textContent=${text(T.sending)};`
    + `W.request(d).then(a=>{let r={};try{r=JSON.parse(a.result)}catch(e){}r.ok?done(${text(T.sent)},6e4):done(r.err==='busy'?${text(T.busy)}:r.err==='closed'?${text(T.closed)}:${text(T.failed)},4e3)},`
    + `e=>done(say[e.code]||${text(T.failed)},4e3))};`,
  inputs: "Q('[data-g]').forEach(g=>g.onclick=e=>{const o=e.target.closest('[data-i]');if(!o)return;const[s,n,m]=g.dataset.g.split(',').map(Number),i=+o.dataset.i,v=B[i]!=='1';"
    + "if(!m)for(let k=s;k<s+n;k++)set(k,0);set(i,v);paint()});"
    + "Q('.x[data-i]').forEach(e=>e.onclick=()=>{set(+e.dataset.i,B[+e.dataset.i]!=='1');paint()});",
  actions: "Q('[data-a]').forEach(b=>b.onclick=()=>send(b,'a'+b.dataset.a+'.'+R+'.'+pack()));",
  tabs: "Q('[data-t]').forEach(b=>b.onclick=()=>{const p=b.parentNode;Q('#'+p.id+'>button').forEach(x=>x.classList.toggle('on',x===b));"
    + "p.dataset.p.split(',').forEach((id,k)=>$(id).classList.toggle('hd',k!==+b.dataset.t))});",
  links: "Q('[data-u]').forEach(b=>b.onclick=()=>W&&W.openLink(b.dataset.u));Q('[data-c]').forEach(b=>b.onclick=()=>W&&W.copyText(b.dataset.c));",
  countdown: "const tick=()=>Q('[data-e]').forEach(e=>{let s=Math.floor((+e.dataset.e-Date.now())/1e3);if(s<=0){e.textContent=e.dataset.d;return}"
    + "const d=Math.floor(s/86400),p=n=>String(n).padStart(2,'0');e.textContent=(d?d+' д ':'')+p(Math.floor(s/3600)%24)+':'+p(Math.floor(s/60)%60)+':'+p(s%60)});"
    + "tick();setInterval(tick,1000);",
  quiz: "let k=0,ok=0;const z=$('qz'),show=()=>{const q=D.q[k];z.innerHTML='';const h=document.createElement('div');h.className='t2';h.textContent=(k+1)+'/'+D.q.length+'. '+q.q;"
    + "const o=document.createElement('div');o.className='qo';q.o.forEach((t,i)=>{const b=document.createElement('button');b.textContent=t;b.onclick=()=>{if(o.dataset.d)return;o.dataset.d=1;"
    + "if(i===q.a)ok++;b.className=i===q.a?'ok':'no';o.children[q.a].className='ok';k++;if(k<D.q.length){setTimeout(show,900);return}"
    + "const r=document.createElement('div');r.className='t2';r.textContent='Результат: '+ok+' из '+D.q.length;z.append(r);"
    + "if(D.f!==undefined)send(b,'a'+D.f+'.'+R+'.'+pack()+'.'+ok)};o.append(b)});z.append(h,o)};show();",
  // The shared state lists only values that differ from the HTML: a bound element it no longer lists
  // goes back to what the HTML showed, so a value the agent sets back is seen too.
  updates: "const O={};Q('[id^=\"v\"]').forEach(e=>O[e.id]=[e.textContent,e.style.width]);"
    + "const apply=()=>{let s;try{s=JSON.parse(W&&W.publicData)}catch(e){return}if(!s||s.r<R)return;R=s.r;const v=s.v||{},p=s.p||{};"
    + "for(const k in O){const e=$(k);if(!e)continue;if(e.tagName==='I')e.style.width=k in p?p[k]+'%':O[k][1];else e.textContent=k in v?v[k]:O[k][0]}};"
    + "apply();if(W)W.onEvent('publicDataChanged',apply);",
} as const;
