import React, { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import confetti from "canvas-confetti";
import { getDatabase, ref, get, set, onValue, off } from "firebase/database";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from "firebase/auth";
import { PHASES, BASE_PLANS, ACH_DEFS, INFO_DATA, RULES } from "./constants";

// --- FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getDatabase(app);
const auth = getAuth(app);

// --- UTILS ---
const fmtMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  const remMs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(remS).padStart(2, "0")}.${String(remMs).padStart(2, "0")}`;
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtDate = () => new Date().toLocaleDateString("uk-UA");
const fmtTime = () => new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });

function beep(ctx: AudioContext | null, freq = 440, dur = 0.15, vol = 0.3) {
  if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch (e) { }
}
const vib = (p: number | number[]) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { } };

// --- TYPES ---
interface FreedivingDataPoint {
  t: number; // timestamp
  el: number; // elapsed time
  hr?: number;
  depth?: number;
  temp?: number;
  speed?: number;
}

interface FitFileStats {
  hr: { avg: number; max: number; min: number; };
  depth: { max: number; avg: number; };
  temp: { avg: number; max: number; min: number; };
  speed: { max: number; avg: number; };
  diveCount: number;
  diveDurations: number[];
  diveMaxDepths: number[];
  diveMinDepths: number[];
  dur: number; // duration in minutes
  n: number; // number of data points
}

interface FitFileData {
  pts: FreedivingDataPoint[];
  stats: FitFileStats;
}

// --- FIT PARSER ---
const FIT_EPOCH = 631065600;
function parseFitFile(buffer: ArrayBuffer): FitFileData | null {
  try {
    const b = new Uint8Array(buffer), v = new DataView(buffer);
    if (b.length < 14) return null;
    const hSize = b[0];
    if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== '.FIT') return null;
    const dataSize = v.getUint32(4, true);
    const end = Math.min(hSize + dataSize, b.length - 2);
    let off = hSize, defs: any = {}, pts: FreedivingDataPoint[] = [];
    
    let hrSum = 0, hrCount = 0, hrMax = 0, hrMin = 255;
    let depthMax = 0, depthSum = 0, depthCount = 0;
    let tempMax = -100, tempMin = 100, tempSum = 0, tempCount = 0;
    let speedMax = 0, speedSum = 0, speedCount = 0;
    let diveCount = 0;
    let diveDurations: number[] = [];
    let diveMaxDepths: number[] = [];
    let diveMinDepths: number[] = [];
    let currentDiveStartTime: number | null = null;

    while (off < end) {
      if (off >= b.length) break;
      const h = b[off++];
      if (h & 0x80) continue;
      const isDef = !!(h & 0x40), hasDev = !!(h & 0x20), lt = h & 0x0F;
      if (isDef) {
        if (off + 5 > b.length) break;
        off++;
        const le = b[off++] === 0;
        const mn = le ? v.getUint16(off, true) : v.getUint16(off, false); off += 2;
        const nf = b[off++];
        const fields = [];
        for (let i = 0; i < nf && off + 3 <= b.length; i++) { fields.push({ n: b[off], sz: b[off + 1] }); off += 3; }
        if (hasDev && off < b.length) { const nd = b[off++]; off += nd * 3; }
        defs[lt] = { mn, fields, le };
      } else {
        const d = defs[lt]; if (!d) break;
        const sz = d.fields.reduce((a: any, f: any) => a + f.sz, 0);
        if (off + sz > b.length) break;
        const msg: any = {}; let fo = off;
        for (const f of d.fields) {
          try {
            let val: any;
            if (f.sz === 1) val = b[fo];
            else if (f.sz === 2) val = d.le ? v.getUint16(fo, true) : v.getUint16(fo, false);
            else if (f.sz === 4) val = d.le ? v.getUint32(fo, true) : v.getUint32(fo, false);
            
            // Check for invalid values (sentinels)
            const isInvalid = (f.sz === 1 && val === 0xFF) || 
                              (f.sz === 2 && val === 0xFFFF) || 
                              (f.sz === 4 && val === 0xFFFFFFFF);
            
            if (!isInvalid) msg[f.n] = val;
          } catch (e) { }
          fo += f.sz;
        }
        off = fo;
        
        if (d.mn === 20) { // Record
          const ts = msg[253];
          if (ts) {
            const p: FreedivingDataPoint = { t: ts + FIT_EPOCH, el: 0 };
            
            // Heart Rate
            const hr = msg[3] || msg[136];
            if (hr) {
              p.hr = hr;
              hrSum += hr; hrCount++;
              if (hr > hrMax) hrMax = hr;
              if (hr < hrMin) hrMin = hr;
            }
            
            // Depth (Field 88, or altitude fields 2, 72, 78)
            let depth = 0;
            if (msg[88] !== undefined) {
              depth = msg[88] / 1000;
            } else {
              const alt = msg[72] !== undefined ? msg[72] : (msg[78] !== undefined ? msg[78] : (msg[2] !== undefined ? msg[2] : msg[5]));
              if (alt !== undefined) {
                // Garmin altitude scale is 0.2, offset -500
                const realAlt = (alt * 0.2) - 500;
                depth = Math.max(0, -realAlt);
              }
            }
            
            if (depth > 0.3) {
              p.depth = parseFloat(depth.toFixed(2));
              depthSum += depth; depthCount++;
              if (depth > depthMax) depthMax = depth;
            }
            
            // Temperature
            const temp = msg[13];
            if (temp !== undefined) {
              p.temp = temp;
              tempSum += temp; tempCount++;
              if (temp > tempMax) tempMax = temp;
              if (temp < tempMin) tempMin = temp;
            }
            
            // Speed (Field 32 vertical, 6 horizontal)
            const speedRaw = msg[32] !== undefined ? msg[32] : (msg[127] !== undefined ? msg[127] : msg[6]);
            if (speedRaw !== undefined) {
              const s = Math.abs(speedRaw / 1000);
              if (s > 0 && s < 100) { // Filter out insane values
                p.speed = parseFloat(s.toFixed(2));
                speedSum += s; speedCount++;
                if (s > speedMax) speedMax = s;
              }
            }
            
            pts.push(p);
          }
        } else if (d.mn === 19) { // Length (Individual Apnea Dives)
          const dur = msg[7] ? msg[7] / 1000 : 0;
          const mDepth = msg[114] ? msg[114] / 1000 : 0;
          const minDepth = msg[113] ? msg[113] / 1000 : 0;
          
          if (dur > 5) {
            diveCount++;
            diveDurations.push(Math.round(dur));
            diveMaxDepths.push(parseFloat(mDepth.toFixed(2)));
            diveMinDepths.push(parseFloat(minDepth.toFixed(2)));
            if (mDepth > depthMax) depthMax = mDepth;
          }
        }
      }
    }
    
    if (pts.length > 0) {
      const t0 = pts[0].t;
      pts.forEach(p => p.el = p.t - t0);
    }

    return {
      pts,
      stats: {
        hr: { avg: hrCount ? Math.round(hrSum / hrCount) : 0, max: hrMax, min: hrMin === 255 ? 0 : hrMin },
        depth: { max: parseFloat(depthMax.toFixed(1)), avg: depthCount ? parseFloat((depthSum / depthCount).toFixed(1)) : 0 },
        temp: { avg: tempCount ? Math.round(tempSum / tempCount) : 0, max: tempMax === -100 ? 0 : tempMax, min: tempMin === 100 ? 0 : tempMin },
        speed: { max: parseFloat(speedMax.toFixed(2)), avg: speedCount ? parseFloat((speedSum / speedCount).toFixed(2)) : 0 },
        diveCount: diveCount,
        diveDurations: diveDurations,
        diveMaxDepths: diveMaxDepths,
        diveMinDepths: diveMinDepths,
        dur: pts.length > 1 ? Math.round((pts[pts.length - 1].el) / 60) : 0,
        n: pts.length
      }
    };
  } catch (e) { console.error("FIT Parse Error:", e); }
  
  return {
    pts: [],
    stats: {
      hr: { avg: 0, max: 0, min: 0 },
      depth: { max: 0, avg: 0 },
      temp: { avg: 0, max: 0, min: 0 },
      speed: { max: 0, avg: 0 },
      diveCount: 0,
      diveDurations: [],
      diveMaxDepths: [],
      diveMinDepths: [],
      dur: 0,
      n: 0
    }
  };
}

// --- COMPONENTS ---

function CrownSplash({ active, color, x, y }: any) {
  if (!active) return null;
  return (
    <div style={{ position: "fixed", left: x, top: y, pointerEvents: "none", zIndex: 9999, transform: "translate(-50%,-50%)" }}>
      {[...Array(10)].map((_, i) => {
        const angle = (i / 10) * 360;
        const dist = 28 + (i % 2) * 10;
        return (
          <div key={i} style={{
            position: "absolute", left: "50%", top: "50%",
            width: 7, height: 9,
            background: color || "#38bdf8",
            borderRadius: "50% 50% 50% 50% / 40% 40% 60% 60%",
            transformOrigin: "center bottom",
            animation: "crownDrop 0.6s cubic-bezier(.2,.8,.4,1) forwards",
            animationDelay: i * 0.01 + "s",
            // @ts-ignore
            "--a": angle + "deg",
            "--dist": "-" + dist + "px",
          }} />
        );
      })}
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: "absolute", left: "50%", top: "50%",
          border: "2px solid " + (color || "#38bdf8"),
          borderRadius: "50%", transform: "translate(-50%,-50%)",
          animation: "rippleRing 0.65s ease-out forwards",
          animationDelay: i * 0.13 + "s", opacity: 0
        }} />
      ))}
    </div>
  );
}

function DropIntro({ onDone }: any) {
  useEffect(() => { const t = setTimeout(onDone, 1900); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f4c75 100%)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ animation: "dropFall 1s cubic-bezier(.4,0,.6,1) forwards", opacity: 0 }}>
        <svg width="64" height="80" viewBox="0 0 48 64">
          <defs>
            <linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#7dd3fc" /><stop offset="100%" stopColor="#0ea5e9" />
            </linearGradient>
            <radialGradient id="dh" cx="35%" cy="30%">
              <stop offset="0%" stopColor="white" stopOpacity="0.6" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path d="M24 2 C24 2 4 28 4 40 C4 52 13 62 24 62 C35 62 44 52 44 40 C44 28 24 2 24 2Z" fill="url(#dg)" />
          <ellipse cx="17" cy="28" rx="6" ry="10" fill="url(#dh)" />
        </svg>
      </div>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: "absolute", left: "50%", top: "50%",
          border: "3px solid #38bdf8", borderRadius: "50%",
          transform: "translate(-50%,-50%)",
          animation: "introRipple 0.8s ease-out forwards",
          animationDelay: (0.92 + i * 0.18) + "s", opacity: 0
        }} />
      ))}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f4c75 100%)", animation: "introDone .5s ease-in 1.5s forwards", opacity: 1 }} />
    </div>
  );
}

const ManualDepthEntry = ({ week, diveCount, manualData, onSave }: any) => {
  const [entries, setEntries] = useState(manualData || Array(diveCount).fill({ min: 0, max: 0 }));
  const [isSaved, setIsSaved] = useState(!!manualData);
  const [showSuccess, setShowSuccess] = useState(false);

  const update = (idx: number, field: string, val: string) => {
    const next = [...entries];
    // Allow empty string for easier editing
    const numVal = val === "" ? 0 : parseFloat(val);
    next[idx] = { ...next[idx], [field]: numVal };
    setEntries(next);
  };

  const handleSave = () => {
    onSave(entries);
    setIsSaved(true);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  if (isSaved && !showSuccess) {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 mb-6 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] text-emerald-400 font-bold uppercase tracking-wider">Дані глибини зафіксовано</span>
        </div>
        <button 
          onClick={() => setIsSaved(false)}
          className="text-[10px] text-sky-400 hover:text-sky-300 font-bold uppercase underline underline-offset-4"
        >
          Редагувати
        </button>
      </div>
    );
  }

  return (
    <div className="bg-slate-800/50 border border-sky-500/30 rounded-2xl p-4 mb-6 relative overflow-hidden">
      {showSuccess && (
        <div className="absolute inset-0 bg-emerald-500/90 flex items-center justify-center z-20 animate-in fade-in duration-300">
          <div className="text-center">
            <div className="text-white text-2xl mb-1">✓</div>
            <div className="text-white text-[10px] font-bold uppercase tracking-widest">Дані успішно передано</div>
          </div>
        </div>
      )}
      <div className="text-[11px] text-sky-400 uppercase font-bold mb-3 tracking-wider flex justify-between items-center">
        <span>Фактична глибина занурень</span>
        <span className="text-[9px] normal-case font-normal text-slate-400 italic">Введіть реальні дані</span>
      </div>
      <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
        {entries.map((e: any, i: number) => (
          <div key={i} className="flex items-center gap-3 bg-black/20 p-2 rounded-xl border border-white/5">
            <div className="text-[10px] font-bold text-slate-500 w-6">#{i+1}</div>
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div>
                <label className="text-[8px] text-slate-400 uppercase block mb-1">Мін (м)</label>
                <input 
                  type="number" step="0.1"
                  value={e.min || ""}
                  onFocus={(ev) => ev.target.select()}
                  onChange={(ev) => update(i, 'min', ev.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-sky-500/50"
                />
              </div>
              <div>
                <label className="text-[8px] text-slate-400 uppercase block mb-1">Макс (м)</label>
                <input 
                  type="number" step="0.1"
                  value={e.max || ""}
                  onFocus={(ev) => ev.target.select()}
                  onChange={(ev) => update(i, 'max', ev.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-sky-500/50"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button 
        onClick={handleSave}
        className="w-full mt-4 bg-sky-500 hover:bg-sky-400 text-white text-[10px] font-bold py-2 rounded-xl transition-all shadow-lg shadow-sky-500/20 uppercase tracking-widest"
      >
        Зберегти глибини
      </button>
    </div>
  );
};

const DiveMaxDepthChart = ({ depths, manualDepths }: { depths: number[], manualDepths?: {min: number, max: number}[] }) => {
  const displayDepths = manualDepths ? manualDepths.map(d => d.max) : depths;
  if (!displayDepths || displayDepths.length === 0) return null;
  const max = Math.max(...displayDepths, 5);
  return (
    <div className="mb-6 bg-white/5 p-4 rounded-2xl border border-white/5">
      <div className="text-[10px] text-slate-400 uppercase font-bold mb-4 tracking-widest">Фактична макс. глибина (м)</div>
      <div className="h-24 flex items-end gap-1.5 px-1">
        {displayDepths.map((d, i) => (
          <div 
            key={i} 
            className="flex-1 bg-amber-400/40 hover:bg-amber-400/60 transition-colors rounded-t-md relative group"
            style={{ height: `${(d / max) * 100}%` }}
          >
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] text-amber-300 font-bold opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap bg-slate-900 px-1.5 py-0.5 rounded border border-white/10 z-10">
              {d}м
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[8px] text-slate-500 uppercase font-black tracking-tighter">
        <span>#1</span>
        <span>Занурення</span>
        <span>#{displayDepths.length}</span>
      </div>
    </div>
  );
};

function MetricChart({ pts, field, label, unit, color, minVal, maxVal, yTicks }: any) {
  const data = pts.filter((p: any) => p[field] !== undefined);
  if (data.length < 2) return null;
  
  const c = color || "#38bdf8";
  const W = 320, H = 80, pad = 28;
  const maxT = pts[pts.length - 1].el || 1;
  const vals = data.map((p: any) => p[field]);
  
  const actualMin = minVal !== undefined ? minVal : Math.min(...vals);
  const actualMax = maxVal !== undefined ? maxVal : Math.max(...vals);
  const range = Math.max(1, actualMax - actualMin);
  
  const sx = (t: number) => pad + (t / maxT) * (W - pad * 2);
  const sy = (v: number) => H - pad - ((v - actualMin) / range) * (H - pad * 1.5);
  
  const linePath = data.map((p: any, i: number) => (i === 0 ? "M" : "L") + sx(p.el).toFixed(1) + "," + sy(p[field]).toFixed(1)).join(" ");
  const fillPath = linePath + " L" + sx(data[data.length-1].el).toFixed(1) + "," + (H - 4) + " L" + sx(data[0].el).toFixed(1) + "," + (H - 4) + " Z";
  
  const steps = Math.max(1, Math.floor(maxT / 60 / 4));
  const xTicks = [];
  for (let m = 0; m * 60 <= maxT; m += steps) xTicks.push(m);

  const displayTicks = yTicks || [actualMin, (actualMin + actualMax) / 2, actualMax];

  return (
    <div className="mb-6">
      <div className="flex justify-between items-center mb-2 px-2">
        <div className="text-[11px] text-slate-300 uppercase font-bold tracking-wider">{label} ({unit})</div>
        <div className="text-[10px] text-slate-500 font-medium">Max: {actualMax.toFixed(1)}{unit} · Avg: {(vals.reduce((a:number,b:number)=>a+b,0)/vals.length).toFixed(1)}{unit}</div>
      </div>
      <svg width="100%" viewBox={"0 0 " + W + " " + H} style={{ display: "block" }}>
        <defs>
          <linearGradient id={"hg" + field + c.replace("#", "")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity="0.3" />
            <stop offset="100%" stopColor={c} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {displayTicks.map((v: number, i: number) => (
          <g key={i}>
            <line x1={pad} y1={sy(v)} x2={W - pad} y2={sy(v)} stroke="rgba(255,255,255,.06)" strokeWidth="1" />
            <text x={pad - 3} y={sy(v) + 4} textAnchor="end" fill="#475569" fontSize="7">{v.toFixed(0)}</text>
          </g>
        ))}
        {xTicks.map(m => (
          <text key={m} x={sx(m * 60)} y={H - 2} textAnchor="middle" fill="#475569" fontSize="7">{m}м</text>
        ))}
        <path d={fillPath} fill={`url(#hg${field}${c.replace("#", "")})`} />
        <path d={linePath} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function StaticHistoryChart({ records }: any) {
  if (!records || records.length < 2) return null;
  const pts = [...records].reverse(); // chronological
  const W = 320, H = 110, padL = 36, padB = 35, padR = 12, padT = 10;
  const vals = pts.map(p => p.s);
  const minV = Math.max(0, Math.min(...vals) - 10);
  const maxV = Math.max(...vals) + 10;
  const sx = (i: number) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const sy = (v: number) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);
  const linePath = pts.map((p, i) => (i === 0 ? "M" : "L") + sx(i).toFixed(1) + "," + sy(p.s).toFixed(1)).join(" ");
  const fillPath = linePath + " L" + sx(pts.length - 1).toFixed(1) + "," + (H - padB) + " L" + sx(0).toFixed(1) + "," + (H - padB) + " Z";
  const yTicks = [60, 120, 180, 240, 300, 360].filter(v => v >= minV && v <= maxV);
  
  return (
    <svg width="100%" viewBox={"0 0 " + W + " " + H} style={{ display: "block" }}>
      <defs>
        <linearGradient id="shg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {yTicks.map(v => (
        <g key={v}>
          <line x1={padL} y1={sy(v)} x2={W - padR} y2={sy(v)} stroke="rgba(255,255,255,.06)" strokeWidth="1" />
          <text x={padL - 3} y={sy(v) + 3} textAnchor="end" fill="#94a3b8" fontSize="7" fontWeight="bold">{fmt(v)}</text>
        </g>
      ))}
      <path d={fillPath} fill="url(#shg)" />
      <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={sx(i)} cy={sy(p.s)} r={p.rec ? 4 : 2.5}
            fill={p.rec ? "#fbbf24" : "#38bdf8"}
            stroke={p.rec ? "#92400e" : "#0ea5e9"}
            strokeWidth="1" />
          <text x={sx(i)} y={sy(p.s) - 6} textAnchor="middle" fill={p.rec ? "#fbbf24" : "#7dd3fc"} fontSize="6" fontWeight="bold">{fmt(p.s)}</text>
          {/* X Axis Labels */}
          {(i === 0 || i === pts.length - 1 || pts.length < 6) && (
            <g transform={`translate(${sx(i)}, ${H - padB + 10})`}>
              <text textAnchor="middle" fill="#64748b" fontSize="6" fontWeight="bold">{p.date}</text>
              <text y="8" textAnchor="middle" fill="#475569" fontSize="5">{p.time}</text>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}

function SessionHistoryChart({ sessions }: any) {
  const completed = [...Array(12)].map((_, i) => ({ w: i + 1, s: sessions[i + 1] })).filter(x => x.s?.completed && x.s.staticTime);
  if (completed.length < 2) return null;
  const parseTime = (str: string) => {
    if (!str) return 0;
    const m = str.match(/(\d+)[:\.](\d+)/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
  };
  const pts = completed.map(x => ({ w: x.w, s: parseTime(x.s.staticTime), label: x.s.staticTime }));
  const W = 320, H = 90, padL = 36, padB = 20, padR = 12, padT = 8;
  const vals = pts.map(p => p.s).filter(v => v > 0);
  if (vals.length < 2) return null;
  const minV = Math.max(0, Math.min(...vals) - 15), maxV = Math.max(...vals) + 15;
  const sx = (i: number) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const sy = (v: number) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);
  const validPts = pts.filter(p => p.s > 0);
  const linePath = validPts.map((p, i) => (i === 0 ? "M" : "L") + sx(i).toFixed(1) + "," + sy(p.s).toFixed(1)).join(" ");
  const fillPath = linePath + " L" + sx(validPts.length - 1).toFixed(1) + "," + (H - padB) + " L" + sx(0).toFixed(1) + "," + (H - padB) + " Z";
  return (
    <svg width="100%" viewBox={"0 0 " + W + " " + H} style={{ display: "block" }}>
      <defs>
        <linearGradient id="seg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4ade80" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#4ade80" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#seg)" />
      <path d={linePath} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinejoin="round" />
      {validPts.map((p, i) => (
        <g key={i}>
          <circle cx={sx(i)} cy={sy(p.s)} r="3.5" fill="#4ade80" stroke="#166534" strokeWidth="1.5" />
          <text x={sx(i)} y={H - padB + 12} textAnchor="middle" fill="#475569" fontSize="8">T{p.w}</text>
        </g>
      ))}
    </svg>
  );
}

function AchBadge({ def, count, onShowDetails }: any) {
  const earned = count > 0;
  const tiers = [];
  if (count >= 1) tiers.push("🥉");
  if (count >= 11) tiers.push("🥈");
  if (count >= 51) tiers.push("🥇");
  if (count >= 100) tiers.push("🏆");

  return (
    <div
      onClick={() => onShowDetails && onShowDetails(def, count)}
      className={`relative p-3 transition-all duration-500 cursor-pointer min-h-[160px] flex flex-col items-center justify-center border-2 ${earned ? "bg-sky-500/10 border-sky-400/30 rounded-[40%_60%_60%_40%_/_60%_40%_60%_40%] shadow-[inset_0_0_20px_rgba(56,189,248,0.1)]" : "bg-white/5 border-white/5 rounded-3xl grayscale opacity-40"}`}
    >
      <div className="text-3xl mb-2 drop-shadow-lg">{def.icon}</div>
      <div className={`text-[10px] font-bold leading-tight mb-1 ${earned ? "text-sky-300" : "text-slate-500"}`}>{def.name}</div>
      <div className="text-[8px] text-slate-400 mb-1 line-clamp-2 px-1">{def.req}</div>
      <div className={`text-[7px] uppercase font-black tracking-widest mb-2 ${def.tier === "Ізі-Брізі" ? "text-sky-400" : def.tier === "Душніла" ? "text-amber-500" : "text-red-500"}`}>{def.tier}</div>
      {earned ? (
        <div className="mt-auto">
          <div className="flex justify-center gap-1 mb-1">
            {tiers.map((t, i) => <span key={i} className="text-xs">{t}</span>)}
          </div>
          <div className="text-[9px] text-sky-500/60 font-bold">×{count}</div>
        </div>
      ) : (
        <div className="mt-auto text-[8px] text-slate-600 uppercase font-bold tracking-tighter">Заблоковано</div>
      )}
    </div>
  );
}

function InfoCard({ card }: any) {
  const [open, setOpen] = useState(false);
  return (
    <div className="transition-all duration-500" style={{ background: "rgba(255,255,255,.02)", border: `1px solid ${card.color}30`, borderRadius: "24px 40px 24px 40px", marginBottom: 16, overflow: "hidden", backdropFilter: "blur(4px)" }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", padding: "20px 22px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, textAlign: "left" }}>
        <span style={{ fontSize: 32, minWidth: 40, filter: "drop-shadow(0 0 10px rgba(255,255,255,0.1))" }}>{card.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#f0f9ff", fontSize: 15, fontWeight: 600, tracking: "tight" }}>{card.title}</div>
          <div style={{ color: "#64748b", fontSize: 10, marginTop: 2, fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.1em" }}>{open ? "Згорнути" : "Розгорнути деталі"}</div>
        </div>
        <span style={{ color: card.color, transition: "transform .5s cubic-bezier(0.4, 0, 0.2, 1)", display: "block", transform: open ? "rotate(180deg)" : "none", fontSize: 18 }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: "0 22px 20px", animation: "fadeUp .5s ease" }}>
          {card.steps.map((s: string, i: number) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ minWidth: 24, height: 24, borderRadius: "40% 60% 70% 30% / 40% 40% 60% 60%", background: `${card.color}20`, border: `1px solid ${card.color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: card.color, flexShrink: 0, fontWeight: 800 }}>{i + 1}</div>
              <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.6, paddingTop: 2 }}>{s}</div>
            </div>
          ))}
          {card.note && <div style={{ background: `${card.color}10`, border: `1px solid ${card.color}30`, borderRadius: "16px", padding: "12px 14px", fontSize: 12, color: "#94a3b8", marginTop: 12, lineHeight: 1.5, fontStyle: "italic" }}>{card.note}</div>}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState("plan");
  const [phase, setPhase] = useState(1);
  const [week, setWeek] = useState(1);
  const [sessions, setSessions] = useState<any>({});
  const [checks, setChecks] = useState<any>({});
  const [bNotes, setBNotes] = useState<any>({});
  const [fitData, setFitData] = useState<any>({});
  const [aiCache, setAiCache] = useState<any>({});
  const [planAdj, setPlanAdj] = useState<any>({});
  const [achCounts, setAchCounts] = useState<any>({});
  const [achHistory, setAchHistory] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [timeMs, setTimeMs] = useState(0);
  const [running, setRunning] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null);
  const [editW, setEditW] = useState<any>(null);
  const [splash, setSplash] = useState({ active: false, x: 0, y: 0, color: "#38bdf8" });
  const [showIntro, setShowIntro] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [histView, setHistView] = useState("table");
  const [fitLoading, setFitLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [manualDepths, setManualDepths] = useState<Record<number, { min: number, max: number }[]>>({});
  const [lastAnalyzedData, setLastAnalyzedData] = useState<Record<number, string>>({});
  const [celebratingAch, setCelebratingAch] = useState<any>(null);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [showAllAchs, setShowAllAchs] = useState(false);

  const timerRef = useRef<any>(null);
  const startRef = useRef<number>(0);
  const audioRef = useRef<AudioContext | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- PERSISTENCE ---
  const saveToDb = async (key: string, val: any) => {
    if (!user) return;
    try {
      await set(ref(db, `users/${user.uid}/${key}`), val);
    } catch (e) {
      console.error("DB Save Error:", e);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const dataKeys = ["sessions", "checks", "bNotes", "records", "fitData", "aiCache", "planAdj", "achCounts", "achHistory", "manualDepths", "lastAnalyzedData"];
        dataKeys.forEach(key => {
          onValue(ref(db, `users/${u.uid}/${key}`), (snap) => {
            const val = snap.val();
            if (val) {
              if (key === "sessions") setSessions(val);
              if (key === "checks") setChecks(val);
              if (key === "bNotes") setBNotes(val);
              if (key === "records") setRecords(val);
              if (key === "fitData") setFitData(val);
              if (key === "aiCache") setAiCache(val);
              if (key === "planAdj") setPlanAdj(val);
              if (key === "achCounts") setAchCounts(val);
              if (key === "achHistory") setAchHistory(val);
              if (key === "manualDepths") setManualDepths(val);
              if (key === "lastAnalyzedData") setLastAnalyzedData(val);
            }
            setLoaded(true);
          });
        });
      } else {
        setLoaded(true);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (running) {
      startRef.current = Date.now() - timeMs;
      timerRef.current = setInterval(() => setTimeMs(Date.now() - startRef.current), 10);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [running]);

  const triggerSplash = (e: any, color: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    setSplash({ active: false, x, y, color: color || "#38bdf8" });
    setTimeout(() => setSplash({ active: true, x, y, color: color || "#38bdf8" }), 10);
    setTimeout(() => setSplash(s => ({ ...s, active: false })), 700);
  };

  const initAudio = () => {
    if (!audioRef.current) try { audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch (e) { }
    if (audioRef.current?.state === "suspended") audioRef.current.resume();
  };

  const handleLogin = async () => {
    setLoginError(null);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e: any) {
      console.error("Login Error:", e);
      if (e.code === 'auth/unauthorized-domain') {
        setLoginError("Домен не авторизований у Firebase. Будь ласка, додайте домени .run.app у консоль Firebase.");
      } else {
        setLoginError(e.message || "Помилка входу");
      }
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const startTimer = (e: any) => {
    initAudio(); triggerSplash(e, "#38bdf8");
    vib([80, 40, 80]); beep(audioRef.current, 880, .12, .5);
    setRunning(true);
  };

  const stopTimer = () => {
    setRunning(false); vib([150]);
    beep(audioRef.current, 440, .18, .4);
    const finalSecs = Math.floor(timeMs / 1000);
    if (finalSecs < 3) { setTimeMs(0); return; }
    const best = records.length ? Math.max(...records.map(r => r.s)) : 0;
    const isRec = finalSecs > best;
    const rec = { s: finalSecs, ms: timeMs, date: fmtDate(), time: fmtTime(), rec: isRec };
    const upd = [rec, ...records];
    setRecords(upd); saveToDb("records", upd);
    if (isRec) grantAch("pb");
    ACH_DEFS.forEach(a => { if (a.type === "timer" && a.thr && finalSecs >= a.thr) grantAch(a.id); });
    
    // Time-based achievements
    const hour = new Date().getHours();
    if (hour < 8) grantAch("early");
    if (hour >= 22) grantAch("night");
    
    setTimeMs(0);
  };

  const grantAch = (id: string) => {
    const def = ACH_DEFS.find(a => a.id === id);
    if (!def) return;

    // Celebration Overlay
    setCelebratingAch(def);
    setTimeout(() => setCelebratingAch(null), 3000);

    // Celebration Confetti
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#38bdf8', '#4ade80', '#fbbf24', '#f472b6']
    });

    // Mario Level Clear Sound
    if (audioRef.current) {
      const ctx = audioRef.current;
      const playNote = (freq: number, start: number, dur: number) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.connect(g); g.connect(ctx.destination);
        o.frequency.setValueAtTime(freq, ctx.currentTime + start);
        g.gain.setValueAtTime(0.1, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur);
      };
      // Mario-ish Level Clear melody
      const notes = [392, 523, 659, 784, 1046, 1318, 1568]; // G4 C5 E5 G5 C6 E6 G6
      notes.forEach((f, i) => playNote(f, i * 0.08, 0.15));
      playNote(1568, 0.6, 0.4); // Final G6
    }

    setAchCounts((prev: any) => {
      const newC = (prev[id] || 0) + 1;
      const upd = { ...prev, [id]: newC };
      saveToDb("achCounts", upd);
      return upd;
    });

    setAchHistory(prev => {
      const entry = { id, name: def.name, icon: def.icon, date: fmtDate(), time: fmtTime() };
      const upd = [entry, ...prev].slice(0, 50);
      saveToDb("achHistory", upd);
      return upd;
    });
  };

  const handleFitUpload = async (file: File, weekNum: number) => {
    if (!file) return;
    setFitLoading(true);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseFitFile(buf);
      const dataToSave = parsed || {
        pts: [],
        stats: {
          hr: { avg: 0, max: 0, min: 0 },
          depth: { max: 0, avg: 0 },
          temp: { avg: 0, max: 0, min: 0 },
          speed: { max: 0, avg: 0 },
          diveCount: 0,
          diveDurations: [],
          diveMaxDepths: [],
          diveMinDepths: [],
          dur: 0,
          n: 0
        }
      };
      const updated = { ...fitData, [weekNum]: dataToSave };
      setFitData(updated); saveToDb("fitData", updated);
      grantAch("fit");
    } catch (e) { alert("Помилка читання файлу."); }
    setFitLoading(false);
  };

  const deleteFit = async (w: number) => {
    const updatedFit = { ...fitData };
    delete updatedFit[w];
    setFitData(updatedFit);
    await saveToDb("fitData", updatedFit);

    const updatedAi = { ...aiCache };
    delete updatedAi[w];
    setAiCache(updatedAi);
    await saveToDb("aiCache", updatedAi);

    setShowDeleteConfirm(null);
  };

  const runAnalysis = async (w: number) => {
    setAiLoading(true);
    setAiError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error("Користувач не авторизований");

      const plan = getPlan(w);
      const currentDataStr = JSON.stringify({
        session: sessions[w],
        fitStats: fitData[w]?.stats,
        manualDepths: manualDepths[w],
        blockNotes: bNotes
      });

      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`
        },
        body: JSON.stringify({
          week: w,
          session: sessions[w] || {},
          fitStats: fitData[w]?.stats || null,
          manualDepths: manualDepths[w] || null,
          planBlocks: plan.blocks,
          planGoals: plan.goals,
          blockNotes: bNotes,
          timerRecords: records,
          allSessions: sessions
        })
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        let msg = `Помилка сервера (${resp.status})`;
        try {
          const errJson = JSON.parse(text);
          msg = errJson.error || msg;
        } catch (e) {
          if (text.includes("<!doctype html>")) msg = "Сервер тимчасово недоступний (Gateway Timeout). Спробуйте ще раз через хвилину.";
        }
        throw new Error(msg);
      }

      const result = await resp.json();
      const upd = { ...aiCache, [w]: result };
      setAiCache(upd); saveToDb("aiCache", upd);

      const updLastData = { ...lastAnalyzedData, [w]: currentDataStr };
      setLastAnalyzedData(updLastData); saveToDb("lastAnalyzedData", updLastData);

      if (result.suggestions?.length || result.goalSuggestions?.length) setPendingPlan({ week: w, ...result });
    } catch (e: any) {
      console.error("AI Error:", e);
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const acceptPlan = async () => {
    if (!pendingPlan) return;
    const { week: w, suggestions = [], goalSuggestions = [] } = pendingPlan;
    const nextW = w + 1;
    if (nextW > 12) {
      alert("Це був останній тиждень плану!");
      setPendingPlan(null);
      return;
    }
    const base = BASE_PLANS[nextW];
    const newBlocks = base.blocks.map((b: any) => ({ ...b }));
    const newGoals = { ...base.goals };
    suggestions.forEach((s: any) => { if (s.blockIndex >= 0 && s.blockIndex < newBlocks.length) newBlocks[s.blockIndex][s.field] = s.proposed; });
    goalSuggestions.forEach((s: any) => { newGoals[s.field] = s.proposed; });
    const updated = { ...planAdj, [nextW]: { blocks: newBlocks, goals: newGoals } };
    setPlanAdj(updated); saveToDb("planAdj", updated);
    setPendingPlan(null); grantAch("plan");
  };

  const saveSession = async (w: number, data: any) => {
    const oldSession = sessions[w] || {};
    const hasChanged = 
      oldSession.staticTime !== data.staticTime || 
      oldSession.dynamicDist !== data.dynamicDist || 
      oldSession.feeling !== data.feeling ||
      oldSession.notes !== data.notes;

    const u = { ...sessions, [w]: data }; 
    setSessions(u); 
    await saveToDb("sessions", u);
    
    if (hasChanged && aiCache[w]) {
      if (confirm("Ви змінили дані тренування. Бажаєте перегенерувати аналіз AI?")) {
        runAnalysis(w);
      }
    }

    setEditW(null); 
    grantAch("sess");
  };

  const getPlan = (w: number) => {
    const adj = planAdj[w];
    if (!adj) return BASE_PLANS[w] || BASE_PLANS[1];
    return { ...BASE_PLANS[w], ...adj };
  };

  if (!loaded) return <div className="min-h-screen bg-slate-950 flex items-center justify-center text-sky-400">Завантаження...</div>;

  if (!user) {
    return (
      <div className="login-modal">
        <div className="login-content">
          <div className="freediving-icon">🤿</div>
          <div className="login-header">
            <h1>Freediving Tracker</h1>
            <p>Ваш персональний тренер фрідайвінгу</p>
          </div>
          {loginError && <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs">{loginError}</div>}
          <button className="google-signin-btn" onClick={handleLogin}>Увійти через Google</button>
        </div>
      </div>
    );
  }

  const plan = getPlan(week);
  const phaseObj = PHASES.find(p => p.weeks.includes(week)) || PHASES[0];
  const best = records.length ? Math.max(...records.map(r => r.s)) : 0;
  const doneCount = Object.values(sessions).filter((s: any) => s?.completed).length;

  return (
    <div className="app-container authenticated" style={{ display: "block" }}>
      {celebratingAch && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/90 backdrop-blur-md border-2 border-amber-400/50 p-8 rounded-[40px] text-center shadow-2xl animate-ach-pop max-w-[80%]">
            <div className="text-7xl mb-4">{celebratingAch.icon}</div>
            <div className={`text-[8px] font-black uppercase tracking-[0.4em] mb-2 px-3 py-1 rounded-full inline-block ${celebratingAch.tier === "Ізі-Брізі" ? "bg-sky-500/20 text-sky-400 border border-sky-500/30" : celebratingAch.tier === "Душніла" ? "bg-amber-500/20 text-amber-500 border border-amber-500/30" : "bg-red-500/20 text-red-500 border border-red-500/30"}`}>{celebratingAch.tier}</div>
            <div className="text-[10px] text-amber-400 font-bold uppercase tracking-[0.3em] mb-2 mt-2">Нове досягнення!</div>
            <h2 className="text-2xl font-bold text-white mb-2">{celebratingAch.name}</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{celebratingAch.desc}</p>
          </div>
        </div>
      )}

      {showIntro && <DropIntro onDone={() => setShowIntro(false)} />}
      <CrownSplash active={splash.active} color={splash.color} x={splash.x} y={splash.y} />

      {showDeleteConfirm !== null && (
        <div className="fixed inset-0 z-[300] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-red-500/40 rounded-[32px] p-8 max-w-sm w-full text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-lg font-bold text-white mb-4">Ти точно хочеш видалити цей результат? Його неможливо буде повернути</h2>
            <div className="flex flex-col gap-3">
              <button onClick={() => deleteFit(showDeleteConfirm)} className="w-full py-4 bg-red-500 text-white rounded-2xl font-bold">Згоріла хата, гори й сарай</button>
              <button onClick={() => setShowDeleteConfirm(null)} className="w-full py-4 bg-white/5 border border-white/10 text-slate-400 rounded-2xl font-bold">Ні</button>
            </div>
          </div>
        </div>
      )}

      {pendingPlan && (
        <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-sky-500/40 rounded-[32px] p-6 max-w-md w-full max-h-[80vh] overflow-y-auto">
            <div className="text-[10px] tracking-[0.3em] uppercase text-sky-400 font-bold mb-2">Jan Claude One Damn пішов на пенсію, тому GROG, ой тобто GROQ скаже тобі помиляєшся ти де</div>
            <h2 className="text-xl font-bold text-white mb-6">Пропозиція корекції плану</h2>
            {[...(pendingPlan.goalSuggestions || []), ...(pendingPlan.suggestions || [])].map((s, i) => (
              <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-4 mb-3">
                <div className="text-[10px] text-sky-400 mb-1">Тиждень {s.targetWeek || pendingPlan.week}</div>
                <div className="text-xs text-slate-500 line-through">Було: {s.original}</div>
                <div className="text-sm text-emerald-400 font-bold">Буде: {s.proposed}</div>
                <div className="text-[10px] text-slate-400 italic mt-1">{s.reason}</div>
              </div>
            ))}
            <div className="flex gap-3 mt-6">
              <button onClick={() => setPendingPlan(null)} className="flex-1 py-3 bg-white/5 border border-white/10 text-slate-400 rounded-xl text-xs font-bold">Я впораюсь сам</button>
              <button onClick={acceptPlan} className="flex-1 py-3 bg-emerald-500 text-white rounded-xl text-xs font-bold">Так, давай не форсувати</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="settings-modal" onClick={e => e.target === e.currentTarget && setShowSettings(false)}>
          <div className="settings-content">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-xl font-bold text-white">Налаштування</h2>
              <button onClick={() => setShowSettings(false)} className="text-slate-500 text-2xl">✕</button>
            </div>
            <div className="flex items-center gap-4 mb-8 p-4 bg-white/5 rounded-3xl border border-white/10">
              <img src={user.photoURL || ""} className="w-12 h-12 rounded-full border-2 border-sky-500" />
              <div>
                <div className="text-white font-bold">{user.displayName}</div>
                <div className="text-[10px] text-slate-500">{user.email}</div>
              </div>
            </div>
            <button onClick={handleLogout} className="logout-btn">Вийти з акаунта</button>
          </div>
        </div>
      )}

      <header className="p-4 sm:p-6 text-center relative">
        <button onClick={() => setShowSettings(true)} className="absolute right-4 sm:right-6 top-6 sm:top-8 p-2 bg-white/5 border border-white/10 rounded-xl text-slate-400">⚙️</button>
        <div className="text-[10px] tracking-[0.3em] uppercase text-sky-400 font-bold mb-2">Freediving Tracker</div>
        <h1 className="text-2xl font-medium text-white">{user.displayName}</h1>
        <div className="mt-4 h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div className="h-full bg-sky-500 transition-all duration-500" style={{ width: `${(doneCount / 12) * 100}%` }} />
        </div>
        <div className="mt-2 text-xs text-slate-300 uppercase tracking-widest font-medium">{doneCount}/12 тренувань · Рекорд: {best > 0 ? fmt(best) : "—"}</div>
      </header>

      <nav className="px-4 sm:px-6 mb-6 sm:mb-8">
        <div className="bg-white/5 border border-white/10 p-1.5 rounded-[24px] flex gap-1.5 overflow-x-auto scrollbar-hide backdrop-blur-md">
          {["plan", "staticka", "progress", "info", "rules"].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 min-w-[85px] py-2.5 sm:py-3 transition-all duration-500 text-[11px] sm:text-xs font-bold uppercase tracking-wider ${tab === t ? "bg-sky-500/20 text-sky-300 rounded-[30%_70%_70%_30%_/_30%_30%_70%_70%] border border-sky-400/30 shadow-[0_0_15px_rgba(56,189,248,0.15)]" : "text-slate-400 hover:text-slate-200"}`}>
              {t === "plan" ? "📋 План" : t === "staticka" ? "⏱ Статика" : t === "progress" ? "📈 Прогрес" : t === "info" ? "💡 Знання" : "📌 Правила"}
            </button>
          ))}
        </div>
      </nav>

      <main className="px-4 sm:px-6 pb-24">
        {tab === "plan" && (
          <div className="space-y-6">
            <div className="flex gap-2">
              {PHASES.map(p => (
                <button key={p.id} onClick={() => { setPhase(p.id); setWeek(p.weeks[0]); }} className={`flex-1 p-3.5 border-2 transition-all duration-500 text-center ${phase === p.id ? `border-sky-400/40 bg-sky-400/10 text-white rounded-[40%_60%_70%_30%_/_30%_40%_60%_70%]` : "border-white/5 bg-white/5 text-slate-500 rounded-2xl hover:border-white/10"}`}>
                  <div className="text-sm font-bold">{p.name}</div>
                  <div className="text-[11px] font-medium opacity-80 uppercase tracking-wide">{p.subtitle}</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
              {PHASES.find(p => p.id === phase)?.weeks.map(w => (
                <button key={w} onClick={() => setWeek(w)} className={`min-w-[90px] sm:min-w-[110px] h-[44px] sm:h-[52px] border-2 flex items-center justify-center font-bold transition-all duration-500 text-xs sm:text-sm ${week === w ? "border-sky-400/40 bg-sky-400/10 text-white rounded-[70%_30%_30%_70%_/_50%_50%_50%_50%]" : "border-white/5 bg-white/5 text-slate-500 rounded-xl hover:border-white/10"}`}>
                  Тиждень {w}
                </button>
              ))}
            </div>
            <div className="bg-white/5 border-2 border-sky-400/20 rounded-[32px] p-6">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-xl font-bold text-white">Тиждень {week}</h2>
                  <p className="text-xs text-sky-400">{phaseObj.subtitle}</p>
                </div>
                {sessions[week]?.completed && <div className="bg-emerald-400/20 text-emerald-400 px-3 py-1 rounded-full text-[10px] font-bold border border-emerald-400/30">ВИКОНАНО</div>}
              </div>
              <div className="grid grid-cols-3 gap-3 mb-6">
                {Object.entries(plan.goals).map(([k, v]: any) => (
                  <div key={k} className="bg-white/10 p-3 rounded-2xl text-center border border-white/10">
                    <div className="text-[11px] text-slate-300 uppercase font-bold mb-1">{k === 's' ? 'Статика' : k === 'd' ? 'Динаміка' : 'Глибина'}</div>
                    <div className="text-sm font-bold text-sky-300">{v}</div>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                {plan.blocks.map((b: any, i: number) => {
                  const isChecked = !!checks[`${week}-${i}`];
                  return (
                    <div key={i} className={`bg-white/5 p-4 rounded-2xl border transition-all ${isChecked ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-white/5'}`}>
                      <div className="flex items-start gap-3 mb-2">
                        <button 
                          onClick={() => {
                            const newChecks = { ...checks, [`${week}-${i}`]: !isChecked };
                            setChecks(newChecks);
                            saveToDb("checks", newChecks);
                          }}
                          className={`mt-1 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${isChecked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-600'}`}
                        >
                          {isChecked && <span className="text-white text-[10px]">✓</span>}
                        </button>
                        <div className="flex-1">
                          <div className="flex justify-between mb-1">
                            <span className={`text-sm font-bold transition-all ${isChecked ? 'text-emerald-400 line-through' : 'text-white'}`}>{b.n}</span>
                            <span className="text-[11px] text-slate-400 font-medium">{b.t}</span>
                          </div>
                          <p className={`text-xs transition-all ${isChecked ? 'text-emerald-500/60 line-through' : 'text-slate-200'} leading-relaxed`}>{b.d}</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <textarea
                          placeholder="Нотатки до цього пункту..."
                          value={bNotes[`${week}-${i}`] || ""}
                          onChange={(e) => {
                            const newNotes = { ...bNotes, [`${week}-${i}`]: e.target.value };
                            setBNotes(newNotes);
                            saveToDb("bNotes", newNotes);
                          }}
                          className="w-full bg-black/20 border border-white/5 rounded-xl p-3 text-xs text-slate-300 focus:border-sky-500/50 outline-none transition-all min-h-[60px] resize-none"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 p-3 bg-amber-400/10 border border-amber-400/20 rounded-xl text-[10px] text-amber-400 italic">{plan.tip}</div>
            </div>

            {sessions[week]?.completed && (
              <div className="bg-slate-900 border-2 border-sky-500/20 rounded-[32px] p-6">
                <div className="text-[10px] tracking-[0.3em] uppercase text-sky-400 font-bold mb-4">🤖 Jan Claude One Damn пішов на пенсію, тому GROG, ой тобто GROQ скаже тобі помиляєшся ти де</div>
                {fitData[week] && (
                  <div className="mb-6">
                    <div className="flex justify-between items-center mb-4">
                      <div className="text-[11px] text-slate-300 uppercase font-bold tracking-wider">Аналіз тренування</div>
                      <button 
                        onClick={() => setShowDeleteConfirm(week)}
                        className="text-[11px] text-red-400 hover:text-red-300 transition-colors uppercase font-bold underline underline-offset-4"
                      >
                        Видалити .fit
                      </button>
                    </div>
                    
                    <MetricChart pts={fitData[week].pts} field="hr" label="Пульс" unit="bpm" color="#38bdf8" yTicks={[60, 100, 140]} />
                    
                    <ManualDepthEntry 
                      week={week} 
                      diveCount={fitData[week].stats.diveCount} 
                      manualData={manualDepths[week]}
                      onSave={(data: any) => {
                        const next = { ...manualDepths, [week]: data };
                        setManualDepths(next);
                        saveToDb("manualDepths", next);
                      }}
                    />

                    <DiveMaxDepthChart depths={fitData[week].stats.diveMaxDepths} manualDepths={manualDepths[week]} />
                    <MetricChart pts={fitData[week].pts} field="depth" label="Глибина" unit="м" color="#fbbf24" />
                    <MetricChart pts={fitData[week].pts} field="temp" label="Температура" unit="°C" color="#10b981" />
                    <MetricChart pts={fitData[week].pts} field="speed" label="Швидкість" unit="м/с" color="#8b5cf6" />

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                      {[
                        { l: "Avg HR", v: fitData[week].stats.hr.avg },
                        { l: "Глибина басейну", v: fitData[week].stats.depth.max + "м" },
                        { l: "Min Temp", v: fitData[week].stats.temp.min + "°C" },
                        { l: "Max Speed", v: fitData[week].stats.speed.max + "м/с" },
                        { l: "Dives", v: fitData[week].stats.diveCount },
                        { l: "Total Time", v: fitData[week].stats.dur + "хв" }
                      ].map((s, i) => (
                        <div key={i} className="bg-white/10 p-2 rounded-xl text-center border border-white/5">
                          <div className="text-sm font-bold text-white">{s.v}</div>
                          <div className="text-[10px] text-slate-300 uppercase font-medium">{s.l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {aiError && (
                  <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-xs leading-relaxed">
                    Помилка AI: {aiError}
                  </div>
                )}
                {aiCache[week] ? (
                  <div className="space-y-4">
                    {(() => {
                      const currentDataStr = JSON.stringify({
                        session: sessions[week],
                        fitStats: fitData[week]?.stats,
                        manualDepths: manualDepths[week],
                        blockNotes: bNotes
                      });
                      const dataChanged = lastAnalyzedData[week] && lastAnalyzedData[week] !== currentDataStr;
                      
                      return dataChanged && (
                        <div className="p-3 bg-sky-500/10 border border-sky-500/30 rounded-xl flex flex-col sm:flex-row justify-between items-center gap-3 animate-pulse">
                          <span className="text-[10px] text-sky-300 font-bold uppercase tracking-wider">⚠️ Дані змінилися. Оновити аналіз?</span>
                          <button 
                            onClick={() => runAnalysis(week)}
                            disabled={aiLoading}
                            className="px-4 py-2 bg-sky-500 text-white text-[10px] font-bold rounded-lg uppercase tracking-widest hover:bg-sky-400 transition-all"
                          >
                            {aiLoading ? "Оновлюю..." : "Перегенерувати"}
                          </button>
                        </div>
                      );
                    })()}

                    <div className="p-4 bg-white/10 border border-white/10 rounded-2xl text-sm text-slate-100 leading-relaxed shadow-inner">{aiCache[week].analysis}</div>
                    
                    {(aiCache[week].suggestions?.length || aiCache[week].goalSuggestions?.length) && !planAdj[week + 1] && (
                      aiCache[week].rejected ? (
                        <div className="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-xl">
                          <span className="text-[10px] text-slate-400 italic">Ви вирішили не змінювати план</span>
                          <button 
                            onClick={() => {
                              const upd = { ...aiCache, [week]: { ...aiCache[week], rejected: false } };
                              setAiCache(upd); saveToDb("aiCache", upd);
                            }}
                            className="text-[10px] text-sky-400 font-bold uppercase underline underline-offset-4"
                          >
                            Я передумав
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button onClick={() => setPendingPlan({ week, ...aiCache[week] })} className="flex-1 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-600/20 transition-all">Так, давай міняти план</button>
                          <button onClick={() => {
                            const upd = { ...aiCache, [week]: { ...aiCache[week], rejected: true } };
                            setAiCache(upd); saveToDb("aiCache", upd);
                          }} className="flex-1 py-3.5 bg-white/10 border border-white/20 text-slate-200 rounded-xl text-xs font-bold hover:bg-white/20 transition-all">Ні, все гуд</button>
                        </div>
                      )
                    )}
                    {planAdj[week + 1] && (
                      <div className="p-4 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 text-center font-bold">✓ План на наступний тиждень оновлено</div>
                    )}
                  </div>
                ) : (
                  <button onClick={() => runAnalysis(week)} disabled={aiLoading} className="w-full py-4 bg-sky-500/20 border-2 border-sky-500/40 text-sky-300 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-sky-500/30 transition-all">
                    {aiLoading ? "Аналізую..." : "🔍 Запустити AI аналіз"}
                  </button>
                )}
              </div>
            )}

            <button onClick={() => setEditW({ week, ...(sessions[week] || { completed: false, feeling: "😊 Добре" }) })} className="w-full py-4 bg-white/5 border-2 border-white/10 text-white font-bold transition-all duration-500 rounded-[20px_40px_20px_40px] hover:rounded-[40px_20px_40px_20px] hover:bg-white/10">
              {sessions[week]?.completed ? "✏️ Редагувати результат" : "+ Записати результат"}
            </button>
          </div>
        )}

        {tab === "staticka" && (
          <div className="space-y-8">
            <div className="bg-slate-900 border-2 border-sky-500/20 rounded-[40px] p-8 sm:p-12 text-center relative overflow-hidden shadow-2xl">
              <div className="absolute top-0 left-0 w-full h-1 bg-white/5">
                <div className="h-full bg-sky-500 transition-all duration-300" style={{ width: `${Math.min(100, (timeMs / ((best + 1) * 1000)) * 100)}%` }} />
              </div>
              
              <div className="flex justify-between mb-8 px-2">
                <div className="text-left">
                  <div className="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Рекорд</div>
                  <div className="text-sm font-mono text-amber-400 font-bold">{fmt(best)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">До рекорду</div>
                  <div className="text-sm font-mono text-sky-400 font-bold">{timeMs >= best * 1000 ? "НОВИЙ РЕКОРД!" : `-${fmtMs(Math.max(0, (best + 1) * 1000 - timeMs))}`}</div>
                </div>
              </div>

              <div className="text-[11px] tracking-[0.5em] uppercase text-slate-400 mb-4 font-bold">Статична затримка</div>
              <div className={`text-6xl sm:text-8xl font-mono mb-12 transition-colors tabular-nums ${running ? "text-sky-400" : "text-white"}`}>{fmtMs(timeMs)}</div>
              
              <div className="flex justify-center">
                {!running ? (
                  <button onClick={startTimer} className="w-32 h-32 sm:w-40 sm:h-40 bg-sky-500/20 border-2 border-sky-400/30 shadow-[0_0_30px_rgba(56,189,248,0.2)] flex items-center justify-center text-sky-300 font-bold text-xl hover:scale-105 active:scale-95 transition-all duration-500 rounded-[30%_70%_70%_30%_/_30%_30%_70%_70%] hover:rounded-[50%]">СТАРТ</button>
                ) : (
                  <button onClick={stopTimer} className="w-32 h-32 sm:w-40 sm:h-40 bg-red-500/20 border-2 border-red-400/30 shadow-[0_0_30px_rgba(239,68,68,0.2)] flex items-center justify-center text-red-300 font-bold text-xl hover:scale-105 active:scale-95 transition-all duration-500 rounded-[60%_40%_30%_70%_/_60%_30%_70%_40%] hover:rounded-[50%]">СТОП</button>
                )}
              </div>
            </div>

            {records.length >= 2 && (
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-6 shadow-xl">
                <div className="text-[11px] text-sky-400 font-bold uppercase mb-4 tracking-widest">Прогрес статики</div>
                <StaticHistoryChart records={records} />
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Історія спроб</h3>
                {records.length > 3 && (
                  <button onClick={() => setShowAllRecords(!showAllRecords)} className="text-[10px] text-sky-400 font-bold uppercase tracking-tighter underline">
                    {showAllRecords ? "Сховати" : "Дивитись всі"}
                  </button>
                )}
              </div>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 scrollbar-hide">
                {(showAllRecords ? records : records.slice(0, 3)).length > 0 ? (showAllRecords ? records : records.slice(0, 3)).map((r, i) => (
                  <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex justify-between items-center hover:bg-white/10 transition-colors">
                    <div>
                      <div className="text-sm font-bold text-white">{fmtMs(r.ms || r.s * 1000)}</div>
                      <div className="text-[10px] text-slate-400 font-medium">{r.date} · {r.time}</div>
                    </div>
                    {r.rec && <div className="text-[10px] bg-amber-400/20 text-amber-400 px-3 py-1 rounded-full font-bold border border-amber-400/30 shadow-sm shadow-amber-400/10">РЕКОРД</div>}
                  </div>
                )) : (
                  <div className="text-center py-8 text-slate-600 text-xs italic">Тут з'являться ваші спроби</div>
                )}
              </div>
            </div>

            <div className="space-y-6 pt-4">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Досягнення</h3>
                <div className="flex items-center gap-3">
                  <div className="text-[10px] text-slate-400 font-bold bg-white/5 px-2 py-1 rounded-lg">{Object.values(achCounts).length}/{ACH_DEFS.length}</div>
                  <button onClick={() => setShowAllAchs(!showAllAchs)} className="text-[10px] text-sky-400 font-bold uppercase tracking-tighter underline">
                    {showAllAchs ? "Сховати" : "Дивитись всі"}
                  </button>
                </div>
              </div>
              
              {["Ізі-Брізі", "Душніла", "Уффф, НУ ТИ І ЗАДРОТ!1!11!"].map(tier => {
                const tierAchs = ACH_DEFS.filter(a => a.tier === tier);
                const earnedInTier = tierAchs.filter(a => achCounts[a.id] > 0);
                const displayAchs = showAllAchs ? tierAchs : earnedInTier;
                
                if (displayAchs.length === 0) return null;

                return (
                  <div key={tier} className="space-y-3">
                    <div className={`text-[9px] font-black uppercase tracking-[0.2em] px-2 ${tier === "Ізі-Брізі" ? "text-sky-400" : tier === "Душніла" ? "text-amber-500" : "text-red-500"}`}>{tier}</div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {displayAchs.map(a => <AchBadge key={a.id} def={a} count={achCounts[a.id] || 0} />)}
                    </div>
                  </div>
                );
              })}
            </div>

            {achHistory.length > 0 && (
              <div className="space-y-4 pt-4">
                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Історія досягнень</h3>
                  {achHistory.length > 3 && (
                    <button onClick={() => setShowAllAchs(!showAllAchs)} className="text-[10px] text-sky-400 font-bold uppercase tracking-tighter underline">
                      {showAllAchs ? "Сховати" : "Дивитись всі"}
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {(showAllAchs ? achHistory : achHistory.slice(0, 3)).map((h, i) => (
                    <div key={i} className="bg-amber-400/5 border border-amber-400/10 rounded-2xl p-4 flex items-center gap-4 hover:bg-amber-400/10 transition-colors">
                      <div className="text-3xl">{h.icon}</div>
                      <div className="flex-1">
                        <div className="text-sm font-bold text-white">{h.name}</div>
                        <div className="text-[10px] text-slate-400 font-medium">{h.date} · {h.time}</div>
                      </div>
                      <div className="text-[10px] text-amber-400 font-bold uppercase tracking-tighter">Здобуто!</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "progress" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white/5 p-6 rounded-[32px] border border-white/10 text-center">
                <div className="text-[10px] text-slate-500 font-bold uppercase mb-2">Тренувань</div>
                <div className="text-3xl font-bold text-white">{doneCount}/12</div>
              </div>
              <div className="bg-white/5 p-6 rounded-[32px] border border-white/10 text-center">
                <div className="text-[10px] text-slate-500 font-bold uppercase mb-2">Рекорд</div>
                <div className="text-3xl font-bold text-amber-400">{best > 0 ? fmt(best) : "—"}</div>
              </div>
            </div>
            {doneCount >= 2 && (
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-6">
                <div className="text-[10px] text-emerald-400 font-bold uppercase mb-4">Прогрес статики</div>
                <SessionHistoryChart sessions={sessions} />
              </div>
            )}
            <div className="space-y-3">
              {Object.entries(sessions).filter(([_, s]: any) => s.completed).map(([w, s]: any) => (
                <div key={w} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex justify-between items-center">
                  <div>
                    <div className="text-xs font-bold text-white">Тиждень {w}</div>
                    <div className="text-[10px] text-slate-500">{s.date}</div>
                  </div>
                  <div className="text-sm font-mono text-sky-400">{s.staticTime || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "info" && <div className="space-y-4">{INFO_DATA.map((card, idx) => <InfoCard key={idx} card={card} />)}</div>}
        {tab === "rules" && (
          <div className="space-y-6">
            {RULES.map((s, si) => (
              <div key={si}>
                <h3 className="text-[10px] font-bold text-sky-500/60 uppercase tracking-[0.3em] mb-4 px-4">{s.title}</h3>
                <div className="space-y-3">
                  {s.items.map((item, i) => (
                    <div key={i} className="bg-white/5 border border-white/10 p-5 rounded-[20px_40px_20px_40px] text-xs text-slate-300 leading-relaxed backdrop-blur-sm shadow-inner">{item}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {editW && (
        <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl flex items-end sm:items-center justify-center p-4">
          <div className="bg-slate-900 w-full max-w-lg rounded-[32px] sm:rounded-[40px] p-6 sm:p-8 border border-white/10 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6 sm:mb-8">
              <h2 className="text-lg sm:text-xl font-bold text-white">Тиждень {editW.week}</h2>
              <button onClick={() => setEditW(null)} className="text-slate-500 text-2xl">✕</button>
            </div>
            <div className="space-y-6">
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Дата</label>
                <input type="date" value={editW.date || ""} onChange={e => setEditW({ ...editW, date: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Статика</label><input placeholder="2:30" value={editW.staticTime || ""} onChange={e => setEditW({ ...editW, staticTime: e.target.value })} /></div>
                <div><label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Динаміка</label><input placeholder="50м" value={editW.dynamicDist || ""} onChange={e => setEditW({ ...editW, dynamicDist: e.target.value })} /></div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Самопочуття</label>
                <div className="grid grid-cols-2 gap-2">
                  {["😫 Важко", "😐 Нормально", "😊 Добре", "🔥 Відмінно"].map(f => (
                    <button key={f} onClick={() => setEditW({ ...editW, feeling: f })} className={`p-3 rounded-xl text-xs border-2 transition-all ${editW.feeling === f ? "border-sky-500 bg-sky-500/10 text-sky-400" : "border-white/5 bg-white/5 text-slate-500"}`}>{f}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">📊 FIT файл</label>
                <input ref={fileRef} type="file" accept=".fit,.FIT" style={{ display: "none" }} onChange={e => e.target.files?.[0] && handleFitUpload(e.target.files[0], editW.week)} />
                <button onClick={() => fileRef.current?.click()} disabled={fitLoading} className="w-full py-3 bg-sky-500/10 border border-sky-500/30 text-sky-400 rounded-xl text-xs font-bold">
                  {fitLoading ? "Парсинг..." : fitData[editW.week] ? "✓ FIT завантажено" : "📁 Завантажити .fit"}
                </button>
              </div>
              <button onClick={() => saveSession(editW.week, { ...editW, completed: true, date: editW.date || fmtDate() })} className="w-full py-4 bg-sky-500 text-white rounded-2xl font-bold">Зберегти результат</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
