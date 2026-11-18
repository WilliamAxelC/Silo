#!/usr/bin/env node
// Scores the app's receipt-total heuristic (src/services/ocr/receiptText.ts: buildReceiptRows + pickTotalFromRows,
// falling back to the legacy MlKitEngine heuristic from run A) on cached RapidOCR boxes, and compares total
// policies against the C/C2 LLM runs. Usage: node bench/eval/score_app_heuristic.js (after run_all.sh).
// Scores the NEW app heuristic (src/services/ocr/receiptText.ts) on RapidOCR boxes, all 197 images.
const fs=require('fs'),path=require('path'),Module=require('module');
const R='/home/agent/orca/Silo'; const {transform}=require(R+'/node_modules/sucrase');
const cache=new Map();
function load(p){ if(cache.has(p)) return cache.get(p).exports;
  const m=new Module(p); m.filename=p; m.paths=Module._nodeModulePaths(path.dirname(p)); cache.set(p,m);
  const req=(s)=>{ if(s.startsWith('.')){ let f=path.resolve(path.dirname(p),s); for(const e of ['.ts','.tsx','/index.ts']) if(fs.existsSync(f+e)) return load(f+e);} return {}; };
  new Function('exports','require','module',transform(fs.readFileSync(p,'utf8'),{transforms:['typescript','imports']}).code)(m.exports,req,m); return m.exports; }
const rt=load(R+'/src/services/ocr/receiptText.ts');
const labels=fs.readFileSync(R+'/bench/labels.jsonl','utf8').trim().split('\n').map(JSON.parse);
const S=new Set((JSON.parse(fs.readFileSync(R+'/bench/eval/subsets.json'))).S||[]);
const acc={}, accS={};
for(const g of labels){ if(g.total==null) continue;
  const o=JSON.parse(fs.readFileSync(`${R}/bench/cache/ocr/${g.id}.json`)); const boxes=o.boxes||o.results||o.items||[];
  const lines=boxes.map(b=>{const xs=b.box.map(p=>p[0]),ys=b.box.map(p=>p[1]);return {text:b.text,frame:{left:Math.min(...xs),top:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}}});
  const rows=rt.buildReceiptRows(lines); const t=rt.pickTotalFromRows(rows);
  for(const [a,ok] of [[acc,true],[accS,S.has(g.id)]]){ if(!ok) continue; a[g.source]=a[g.source]||[0,0]; a[g.source][1]++; a[g.source][0]+=(t===g.total);} }
const fmt=a=>{let c=0,n=0;const s=Object.entries(a).map(([k,[x,y]])=>{c+=x;n+=y;return `${k} ${x}/${y}`}).join(', ');return `${c}/${n}=${(100*c/n).toFixed(0)}% (${s})`};
console.log('ALL:',fmt(acc)); console.log('S  :',fmt(accS));
// combined: new pick ?? old heuristic (A_heuristic run)
const A={}; for(const l of fs.readFileSync(R+'/bench/results/runs/A_heuristic.jsonl','utf8').trim().split('\n')){try{const r=JSON.parse(l);A[r.id]=r.total}catch{}}
const c={},cS={}, miss={};
for(const g of labels){ if(g.total==null) continue;
  const o=JSON.parse(fs.readFileSync(`${R}/bench/cache/ocr/${g.id}.json`)); const boxes=o.boxes||o.results||[];
  const lines=boxes.map(b=>{const xs=b.box.map(p=>p[0]),ys=b.box.map(p=>p[1]);return {text:b.text,frame:{left:Math.min(...xs),top:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}}});
  const rows=rt.buildReceiptRows(lines); const t=rt.pickTotalFromRows(rows) ?? A[g.id];
  const grounded = rt.isGrounded(g.total, rows);
  for(const [a,ok] of [[c,true],[cS,S.has(g.id)]]){ if(!ok) continue; a[g.source]=a[g.source]||[0,0]; a[g.source][1]++; a[g.source][0]+=(t===g.total);}
  miss[g.source]=miss[g.source]||[0,0]; miss[g.source][1]++; miss[g.source][0]+=grounded; }
console.log('COMBINED ALL:',fmt(c)); console.log('COMBINED S  :',fmt(cS)); console.log('ceiling (GT total in extractAmounts(rows)):',fmt(miss));
for (const run of ['C_llm_rows_schema_2b','C2_llm_rows_schema_0.8b']) {
  const L={}; for(const l of fs.readFileSync(`${R}/bench/results/runs/${run}.jsonl`,'utf8').trim().split('\n')){try{const r=JSON.parse(l);L[r.id]=r}catch{}}
  const pol={P1_llm_first:[0,0],P2_keyword_first:[0,0]};
  for(const g of labels){ if(g.total==null||!L[g.id]) continue; const r=L[g.id];
    const o=JSON.parse(fs.readFileSync(`${R}/bench/cache/ocr/${g.id}.json`)); const boxes=o.boxes||o.results||[];
    const lines=boxes.map(b=>{const xs=b.box.map(p=>p[0]),ys=b.box.map(p=>p[1]);return {text:b.text,frame:{left:Math.min(...xs),top:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}}});
    const rows=rt.buildReceiptRows(lines); const kw=rt.pickTotalFromRows(rows); const h=kw??A[g.id];
    const raw=r.raw_llm_total; const llm=(raw&&rt.isGrounded(raw,rows))?raw:null;
    const p1=llm??h, p2=kw??llm??A[g.id];
    pol.P1_llm_first[1]++; pol.P1_llm_first[0]+=(p1===g.total); pol.P2_keyword_first[1]++; pol.P2_keyword_first[0]+=(p2===g.total);}
  console.log(run, JSON.stringify(pol));
}
