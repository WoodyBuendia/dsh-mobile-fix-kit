import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
import { outerBytesForDshFrame } from './exact-outer.mjs';
const MAGIC=Buffer.from([0x28,0xb5,0x2f,0xfd]);
function split(b){const i=[];let f=0;for(;;){const k=b.indexOf(MAGIC,f);if(k<0)break;i.push(k);f=k+1}i.push(b.length);const o=[];for(let k=0;k<i.length-1;k++)o.push(b.subarray(i[k],i[k+1]));return o}
function readAll(f){let t='';for(const fr of split(fs.readFileSync(f))){try{t+=zlib.zstdDecompressSync(fr).toString('utf8')}catch{}}return t}
const M=new Set(['user/message','assistant/message']);
function page(ev,maxMessages,minMessages,minTurns){const end=ev.length;let c=0,t=0,cut=0;
 for(let i=end-1;i>=0;i--){const e=ev[i];
  if(e.type==='turn/start'){t++;if(c>=minMessages&&t>=minTurns){cut=i;break}}
  if(!M.has(e.type))continue;c++;if(c>=maxMessages){cut=i;break}}
 const s=ev.slice(cut,end);let b=0;for(const e of s)b+=Buffer.byteLength(JSON.stringify({type:'event',event:e}));
 return b}
const root=process.env.DSH_SESSIONS_DIR ?? `${process.env.DSH_HOME ?? process.env.HOME + '/.dsh'}/sessions`; const rows=[];
for(const proj of fs.readdirSync(root)){for(const dir of fs.readdirSync(path.join(root,proj))){
 const m=/^session-([0-9a-f-]{36})$/.exec(dir); if(!m)continue;
 const d=path.join(root,proj,dir);
 const f=['session.v4.jsonl.zstd','session.v3.jsonl.zstd'].map(x=>path.join(d,x)).find(x=>fs.existsSync(x));
 if(!f)continue;
 const text=readAll(f); const ev=[]; let first='';
 for(const l of text.split('\n')){if(!l)continue;let o;try{o=JSON.parse(l)}catch{continue}const e=o.event??o;ev.push(e);
   if(!first&&e.type==='user/message'){const t=e.data?.content?.find(c=>c.type==='text')?.text??'';first=t.replace(/\s+/g,' ').slice(0,34)}}
 const L=page(ev,500,50,2); const outer=outerBytesForDshFrame(L).outer;
 rows.push({id:m[1].slice(0,8),proj:proj.replace(/^--|--$/g,'').slice(-5),L,outer,first});
}}
rows.sort((a,b)=>b.outer-a.outer);
console.log('id        DSH帧MiB  外发MiB  判定   对话开头');
for(const r of rows){const fail=r.outer>4*1048576;
 console.log(`${r.id}  ${String((r.L/1048576).toFixed(2)).padStart(7)}  ${String((r.outer/1048576).toFixed(2)).padStart(7)}  ${fail?'❌断开':'✅可载入'}  ${r.first}`)}
