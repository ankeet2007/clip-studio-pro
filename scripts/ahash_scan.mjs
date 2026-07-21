// Standalone 8x8 aHash distinctness scanner — the honest acceptance test.
// Same method as lib/verify/distinctness.ts: 8x8 gray average-hash, similarity = fraction of
// matching bits, window similarity = MAX over frame pairs. Reports every pair >= THRESHOLD.
//
// Two modes:
//   node ahash_scan.mjs windows segs.json      # pre-check: [{id,file,start,end}] proposed beats
//   node ahash_scan.mjs output video.mp4 [step] # acceptance: sample a rendered MP4 every `step`s
//
// Exit 0 = clean (0 pairs >= threshold), exit 2 = violations found.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
const THRESHOLD = 0.85;
const SAME_SRC_GAP = 25;

async function hashFrameAt(file, t, dir, i) {
  const jpg = path.join(dir, `f${i}.jpg`);
  const raw = jpg + ".raw";
  try {
    await exec("ffmpeg", ["-v","error","-ss",String(t),"-i",file,"-vf","scale=8:8,format=gray","-frames:v","1","-f","rawvideo","-y",raw], { timeout: 20000 });
    const b = fs.readFileSync(raw);
    if (b.length < 64) return null;
    const bytes = Array.from(b.subarray(0,64));
    const avg = bytes.reduce((x,y)=>x+y,0)/bytes.length;
    return bytes.map(v => v>avg?1:0);
  } catch { return null; }
}
function sim(a,b){ if(!a||!b||a.length!==b.length) return 0; let s=0; for(let i=0;i<a.length;i++) if(a[i]===b[i]) s++; return s/a.length; }
function winSim(A,B){ let w=0; for(const a of A) for(const b of B){ const s=sim(a,b); if(s>w) w=s; } return w; }

async function hashWindow(file, start, end, frames=3){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"ah_"));
  const out=[]; const span=Math.max(0.1,end-start);
  try { for(let i=0;i<frames;i++){ const t=start+span*(i+0.5)/frames; const h=await hashFrameAt(file,t,dir,i); if(h) out.push(h); } }
  finally { try{ fs.rmSync(dir,{recursive:true,force:true}); }catch{} }
  return out;
}
async function ffdur(file){ try{ const {stdout}=await exec("ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",file],{timeout:15000}); return parseFloat(stdout.trim())||0; }catch{ return 0; } }

const mode = process.argv[2];
if (mode === "windows") {
  const segs = JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
  const W=[];
  for (const s of segs){ const h=await hashWindow(s.file, s.start, s.end); W.push({id:s.id, file:s.file, start:s.start, end:s.end, h}); console.error(`hashed ${s.id} [${s.start}-${s.end}] frames=${h.length}`); }
  const viol=[];
  for(let i=0;i<W.length;i++) for(let j=i+1;j<W.length;j++){
    const a=W[i],b=W[j];
    if(a.file===b.file){ const gap = a.start<b.start ? b.start-a.end : a.start-b.end; if(gap<SAME_SRC_GAP){ viol.push(`${a.id} <-> ${b.id}: SAME SOURCE ${Math.max(0,gap).toFixed(1)}s apart`); continue; } }
    const s=winSim(a.h,b.h); if(s>=THRESHOLD) viol.push(`${a.id} <-> ${b.id}: ${(s*100).toFixed(1)}% similar`);
  }
  console.log(JSON.stringify({pairs:W.length*(W.length-1)/2, violations:viol}, null, 2));
  process.exit(viol.length?2:0);
} else if (mode === "output") {
  const file=process.argv[3]; const step=Number(process.argv[4]||4);
  const dur=await ffdur(file); const times=[]; for(let t=2;t<dur;t+=step) times.push(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ao_")); const hashes=[];
  for(let i=0;i<times.length;i++){ const h=await hashFrameAt(file,times[i],dir,i); hashes.push({t:times[i],h}); }
  try{ fs.rmSync(dir,{recursive:true,force:true}); }catch{}
  let worst=0, worstPair=null; const bad=[];
  let total=0;
  for(let i=0;i<hashes.length;i++) for(let j=i+1;j<hashes.length;j++){
    if(!hashes[i].h||!hashes[j].h) continue; total++;
    const s=sim(hashes[i].h,hashes[j].h);
    if(s>worst){ worst=s; worstPair=[hashes[i].t,hashes[j].t]; }
    if(s>=THRESHOLD) bad.push(`t=${hashes[i].t}s <-> t=${hashes[j].t}s : ${(s*100).toFixed(1)}%`);
  }
  console.log(JSON.stringify({frames:hashes.length, pairs:total, worst:(worst*100).toFixed(1)+"%", worstPair, pairs_ge_85:bad.length, detail:bad}, null, 2));
  process.exit(bad.length?2:0);
} else { console.error("usage: windows segs.json | output video.mp4 [step]"); process.exit(1); }
