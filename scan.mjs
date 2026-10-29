#!/usr/bin/env node
// ======================================================================
// ชุดสแกนเหรียญสำหรับ GitHub Actions
// ATR Trailing Stop (ceyhun) + HAMA Candles (NSDT) → แจ้งเตือนทาง Telegram
// อ่านค่าตั้งจาก config.json · จำผลรอบก่อนใน state.json เพื่อแจ้งเฉพาะเหรียญใหม่
// ส่วนคำนวณ (ระหว่าง ==CORE== กับ ==END CORE==) คัดลอกมาจากไฟล์ crypto-scanner.html ทุกตัวอักษร
// ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ใช้ Node.js 18 ขึ้นไป (GitHub Actions ใช้ Node 22)
// ======================================================================
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// ==CORE==
// ---- indicators (port จาก Pine Script: ATR Trailing Stop by ceyhun + NSDT HAMA Candles) ----
function rmaArr(v, n) {
  const out = new Array(v.length).fill(NaN);
  if (v.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  out[n - 1] = s / n;
  for (let i = n; i < v.length; i++) out[i] = (out[i - 1] * (n - 1) + v[i]) / n;
  return out;
}
function atrArr(h, l, c, n) {
  const tr = h.map((_, i) => i === 0 ? h[i] - l[i]
    : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  return rmaArr(tr, n);
}
function emaArr(x, n) {
  const a = 2 / (n + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) { out[i] = NaN; continue; }
    prev = Number.isNaN(prev) ? x[i] : a * x[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}
function wmaArr(x, n) {
  const out = new Array(x.length).fill(NaN);
  const wsum = n * (n + 1) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let s = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const v = x[i - n + 1 + k];
      if (Number.isNaN(v)) { ok = false; break; }
      s += v * (k + 1);
    }
    out[i] = ok ? s / wsum : NaN;
  }
  return out;
}
function trailStop(src, d) {
  const n = src.length;
  const tr = new Array(n).fill(NaN);
  let start = d.findIndex(v => !Number.isNaN(v));
  if (start < 0) start = n;
  let prev = 0;
  for (let i = start; i < n; i++) {
    const sc = src[i], scp = i > 0 ? src[i - 1] : NaN;
    const iff1 = sc > prev ? sc - d[i] : sc + d[i];
    const iff2 = (sc < prev && scp < prev) ? Math.min(prev, sc + d[i]) : iff1;
    const cur = (sc > prev && scp > prev) ? Math.max(prev, sc - d[i]) : iff2;
    tr[i] = cur;
    prev = cur;
  }
  return tr;
}
function hamaStrength(c, steps) {
  const g = wmaArr(c, 55);
  const center = emaArr(g, 3);
  const out = new Array(c.length).fill(0);
  let q = 0;
  for (let i = 1; i < c.length; i++) {
    if ([g[i], center[i], g[i - 1], center[i - 1]].some(Number.isNaN)) { out[i] = 0; continue; }
    const chg = g[i] - g[i - 1];
    const up = chg > 0, dn = chg < 0;
    const bull = g[i] > center[i], bear = g[i] < center[i];
    const xUp = g[i] > center[i] && g[i - 1] <= center[i - 1];
    const xDn = g[i] < center[i] && g[i - 1] >= center[i - 1];
    if (bull) {
      q = xUp ? 1 : up ? Math.min(steps, q + 1) : dn ? Math.max(1, q - 1) : q;
      out[i] = q;
    } else if (bear) {
      q = xDn ? 1 : dn ? Math.min(steps, q + 1) : up ? Math.max(1, q - 1) : q;
      out[i] = -q;
    } else {
      out[i] = out[i - 1];
    }
  }
  return out;
}
// candles: [{t,o,h,l,c}] เรียงเก่า -> ใหม่ ; ตรวจที่แท่งรองสุดท้าย (แท่งที่ปิดแล้ว)
function evaluate(candles, opts) {
  const n = candles.length;
  if (n < (opts.minBars || 200)) return null;
  const o = candles.map(x => x.o), h = candles.map(x => x.h), l = candles.map(x => x.l), c = candles.map(x => x.c);
  const t1 = trailStop(c, atrArr(h, l, c, 5).map(v => v * 0.5));
  const t2 = trailStop(c, atrArr(h, l, c, 10).map(v => v * 3.0));
  const maLine = wmaArr(h.map((v, i) => (v + l[i]) / 2), 55);
  const strength = hamaStrength(c, 5);
  // ค่าเริ่มต้น: แท่งรองสุดท้าย (แท่งสุดท้ายยังวิ่งอยู่) · opts.at ใช้ระบุแท่งเองได้ (สคริปต์บน GitHub ใช้เลือกแท่งที่ปิดแล้วตามเวลาจริง)
  const i = opts.at != null ? opts.at : n - 2;
  if (!(i >= 0 && i < n)) return null;
  if (Number.isNaN(t2[i]) || Number.isNaN(maLine[i])) return null;
  const green = t1[i] > t2[i] && c[i] > t2[i] && l[i] > t2[i];   // Pine: Green
  const red = t2[i] > t1[i] && c[i] < t2[i] && h[i] < t2[i];     // Pine: Red (ภาพสะท้อนของ Green)
  return {
    atrGreen: green, atrRed: red,
    aboveMa: c[i] > maLine[i], belowMa: c[i] < maLine[i],
    hamaOk: strength[i] >= opts.hamaMinStep, hamaBear: strength[i] <= -opts.hamaMinStep,
    close: c[i],
    dist: (c[i] - t2[i]) / t2[i] * 100,
    distShort: (t2[i] - c[i]) / t2[i] * 100,
    step: strength[i],
    medRange: medianRangePct(candles.slice(Math.max(0, i - 99), i + 1)),
    barTime: candles[i].t,
  };
}
function medianRangePct(cs) {
  const r = cs.map(x => (x.h - x.l) / x.c * 100).sort((a, b) => a - b);
  if (!r.length) return 0;
  const m = r.length >> 1;
  return r.length % 2 ? r[m] : (r[m - 1] + r[m]) / 2;
}
// ---- กรองรายชื่อเหรียญ ----
const STABLES = new Set(["USDT","USDC","FDUSD","TUSD","BUSD","DAI","USDP","USDD","EUR","AEUR","PYUSD","USD1","USDE","XUSD"]);
const REAL_R_COINS = new Set(["RENDER","RNDR","RUNE","RAY","RSR","RVN","RPL","RLC","ROSE","RDNT","RARE","REZ","RED",
  "REQ","RIF","RAD","REEF","RACA","REI","RLB","RAIL","RBN","RFOX","RON","RONIN","RWA","RIO","RATS","RAVE","RSS3",
  "RAI","RLUSD","RUN","RSC","RAT","RBTC","RETH"]);
function isLeveraged(b) {
  return /(3L|3S|5L|5S|BULL|BEAR)$/.test(b) || /^(BTC|ETH|BNB|XRP|ADA|LTC|EOS|TRX|LINK|DOT|SXP|BCH)(UP|DOWN)$/.test(b);
}
function isTokenizedStock(b) { return b.startsWith("R") && !REAL_R_COINS.has(b); }
// แปลงข้อความที่พิมพ์ (BTC, eth/usdt, SOLUSDT, bnb-usdt ...) เป็นรายชื่อ base ที่ไม่ซ้ำ
function parseCoins(text) {
  const out = [];
  for (let t of String(text || "").toUpperCase().split(/[\s,;|]+/)) {
    t = t.replace(/^[A-Z]+:/, "");              // ตัด prefix แบบ BINANCE:BTCUSDT ที่ได้จาก watchlist ของ TradingView
    t = t.replace(/[\/\-_]USDT$/, "");
    if (t.length > 4 && t.endsWith("USDT")) t = t.slice(0, -4);
    t = t.replace(/[^A-Z0-9]/g, "");
    if (t === "USDT") continue;                  // ไม่ใช่เหรียญที่จะสแกน
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
// ==END CORE==

// ======================================================================
// ส่วนที่เหลือ: ตัวดึงข้อมูล exchange, อ่าน config, เทียบกับรอบก่อน, ส่ง Telegram
// ======================================================================
const TFS = {
  "1h": { hours: 1,  tv: "60",  minBars: 200 },
  "4h": { hours: 4,  tv: "240", minBars: 200 },
  "1d": { hours: 24, tv: "D",   minBars: 120 },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => parseFloat(v);
const asc = arr => arr.sort((a, b) => a.t - b.t);

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let k = 0; k < tries; k++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (r.status === 429 || r.status === 418) { await sleep(1500 * (k + 1)); lastErr = new Error("HTTP " + r.status); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { clearTimeout(to); lastErr = e; await sleep(300 * (k + 1)); }
  }
  throw lastErr;
}

// ---- exchange (ข้อมูลสาธารณะ ไม่ต้องใช้ API key) ----
const EX = {
  binance: {
    tvPrefix: "BINANCE", conc: 5, iv: { "1h": "1h", "4h": "4h", "1d": "1d" },
    async tickers() {
      let d;
      try { d = await getJSON("https://api.binance.com/api/v3/ticker/24hr", 1); this.mirror = false; }
      catch (e) { d = await getJSON("https://data-api.binance.vision/api/v3/ticker/24hr"); this.mirror = true; }
      return d.filter(x => x.symbol.endsWith("USDT")).map(x => ({ id: x.symbol, base: x.symbol.slice(0, -4), qv: num(x.quoteVolume) }));
    },
    async candles(id, tf) {
      const host = this.mirror ? "data-api.binance.vision" : "api.binance.com";
      const d = await getJSON(`https://${host}/api/v3/klines?symbol=${id}&interval=${this.iv[tf]}&limit=500`);
      return d.map(k => ({ t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]) }));
    },
    tv: id => id,
  },
  bybit: {
    tvPrefix: "BYBIT", conc: 4, iv: { "1h": "60", "4h": "240", "1d": "D" },
    async tickers() {
      const d = await getJSON("https://api.bybit.com/v5/market/tickers?category=spot");
      return d.result.list.filter(x => x.symbol.endsWith("USDT")).map(x => ({ id: x.symbol, base: x.symbol.slice(0, -4), qv: num(x.turnover24h) }));
    },
    async candles(id, tf) {
      const d = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${id}&interval=${this.iv[tf]}&limit=500`);
      return asc(d.result.list.map(k => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]) })));
    },
    tv: id => id,
  },
  okx: {
    tvPrefix: "OKX", conc: 3, iv: { "1h": "1H", "4h": "4H", "1d": "1D" },
    async tickers() {
      const d = await getJSON("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
      return d.data.filter(x => x.instId.endsWith("-USDT")).map(x => ({ id: x.instId, base: x.instId.split("-")[0], qv: num(x.volCcy24h) }));
    },
    async candles(id, tf) {
      const d = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${id}&bar=${this.iv[tf]}&limit=300`);
      return asc(d.data.map(k => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]) })));
    },
    tv: id => id.replace("-", ""),
  },
  bitget: {
    tvPrefix: "BITGET", conc: 5, iv: { "1h": "1h", "4h": "4h", "1d": "1Dutc" },
    async tickers() {
      const d = await getJSON("https://api.bitget.com/api/v2/spot/market/tickers");
      return d.data.filter(x => x.symbol.endsWith("USDT")).map(x => ({ id: x.symbol, base: x.symbol.slice(0, -4), qv: num(x.usdtVolume || x.quoteVolume) }));
    },
    async candles(id, tf) {
      const d = await getJSON(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${id}&granularity=${this.iv[tf]}&limit=500`);
      return asc(d.data.map(k => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]) })));
    },
    tv: id => id,
  },
};

// ---- config ----
function toList(v) { return Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]); }
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json ต้องเป็นออบเจ็กต์ JSON ({ ... })");
  const errs = [];
  const cfg = { timezone: raw.timezone || "Asia/Bangkok", notify: raw.notify || "new", scans: [] };
  if (!["new", "all"].includes(cfg.notify)) errs.push(`notify ต้องเป็น "new" หรือ "all" (ตอนนี้: ${JSON.stringify(raw.notify)})`);
  try { new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone }); } catch (e) { errs.push(`timezone ไม่ถูกต้อง: ${cfg.timezone}`); }
  if (!Array.isArray(raw.scans) || !raw.scans.length) errs.push("ต้องมี scans อย่างน้อย 1 รายการ");
  const names = new Set();
  (Array.isArray(raw.scans) ? raw.scans : []).forEach((s, i) => {
    const tag = `scans[${i + 1}]`;
    if (!s || typeof s !== "object") { errs.push(`${tag}: ต้องเป็นออบเจ็กต์`); return; }
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name) { errs.push(`${tag}: ต้องมี "name"`); return; }
    if (names.has(name)) { errs.push(`${tag}: ชื่อ "${name}" ซ้ำกับรายการอื่น`); return; }
    names.add(name);
    const enabled = s.enabled !== false;
    const type = s.type === undefined ? "trend" : String(s.type).toLowerCase();
    if (!["trend", "rsi"].includes(type)) errs.push(`${tag} "${name}": type ต้องเป็น "trend" (ATR+HAMA) หรือ "rsi" (ตอนนี้: ${s.type})`);
    const isRsi = type === "rsi";
    const exchange = String(s.exchange || "bitget").toLowerCase();
    if (!EX[exchange]) errs.push(`${tag} "${name}": exchange ต้องเป็น ${Object.keys(EX).join(" / ")} (ตอนนี้: ${s.exchange})`);
    let sides = s.sides === "both" ? ["long", "short"] : toList(s.sides === undefined ? ["long", "short"] : s.sides).map(x => String(x).toLowerCase());
    if (!isRsi && (!sides.length || sides.some(x => !["long", "short"].includes(x)))) errs.push(`${tag} "${name}": sides ต้องเป็น "long" และ/หรือ "short"`);
    sides = isRsi ? [] : [...new Set(sides)];
    let tfs = toList(s.tfs === undefined ? ["1h"] : s.tfs).map(x => String(x).toLowerCase());
    if (!tfs.length || tfs.some(x => !TFS[x])) errs.push(`${tag} "${name}": tfs ต้องเป็น "1h", "4h", "1d" (เลือกได้หลายอัน)`);
    tfs = [...new Set(tfs)].filter(x => TFS[x]).sort((a, b) => TFS[a].hours - TFS[b].hours);
    const coins = parseCoins(Array.isArray(s.coins) ? s.coins.join(" ") : s.coins);
    if (enabled && !coins.length) errs.push(`${tag} "${name}": ยังไม่ได้ใส่รายชื่อเหรียญใน "coins"`);
    const hamaMinStep = s.hama_min_step === undefined ? 3 : Number(s.hama_min_step);
    if (!isRsi && !(hamaMinStep >= 1 && hamaMinStep <= 5)) errs.push(`${tag} "${name}": hama_min_step ต้องอยู่ระหว่าง 1–5`);
    const minVolume = s.min_volume === undefined ? 0 : Number(s.min_volume);
    const minRange = s.min_range === undefined ? 0 : Number(s.min_range);
    const maxCoins = s.max_coins === undefined ? 200 : Number(s.max_coins);
    if (!(minVolume >= 0)) errs.push(`${tag} "${name}": min_volume ต้องเป็นตัวเลข ≥ 0`);
    if (!(minRange >= 0)) errs.push(`${tag} "${name}": min_range ต้องเป็นตัวเลข ≥ 0`);
    if (!(maxCoins >= 1)) errs.push(`${tag} "${name}": max_coins ต้องเป็นตัวเลข ≥ 1`);
    const rsiLength = s.rsi_length === undefined ? 14 : Number(s.rsi_length);
    const overbought = s.overbought === undefined ? 70 : Number(s.overbought);
    const oversold = s.oversold === undefined ? 30 : Number(s.oversold);
    if (isRsi) {
      if (!(Number.isInteger(rsiLength) && rsiLength >= 2 && rsiLength <= 100)) errs.push(`${tag} "${name}": rsi_length ต้องเป็นจำนวนเต็ม 2–100`);
      if (!(oversold > 0 && oversold < overbought && overbought < 100)) errs.push(`${tag} "${name}": ต้องมี 0 < oversold < overbought < 100 (ตอนนี้: ${s.oversold}/${s.overbought})`);
    }
    cfg.scans.push({ name, type, enabled, exchange, sides, tfs, coins, hamaMinStep, minVolume, minRange, maxCoins,
                     rsiLength, overbought, oversold, excludeStocks: s.exclude_tokenized_stocks === true });
  });
  if (errs.length) throw new Error(errs.join("\n"));
  return cfg;
}

// ---- สแกน 1 ชุด ----
// หาแท่งที่ "ปิดแล้ว" ล่าสุดจากเวลาจริง (ไม่เดาว่าแท่งสุดท้ายคือแท่งที่ยังวิ่งอยู่ เพราะเหรียญที่ไม่มีการซื้อขายอาจยังไม่มีแท่งใหม่)
export function lastClosedIndex(cs, hours, nowMs) {
  const ms = hours * 3600e3;
  for (let i = cs.length - 1; i >= 0; i--) if (cs[i].t + ms <= nowMs) return i;
  return -1;
}
async function prepareList(scan) {
  const ex = EX[scan.exchange];
  const tickers = await ex.tickers();
  const byBase = new Map(tickers.map(x => [x.base, x]));
  const missing = [], dropped = [], keep = [];
  for (const b of scan.coins) {
    const x = byBase.get(b);
    if (!x) { missing.push(b); continue; }
    if (x.qv < scan.minVolume) dropped.push(`${b} (วอลุ่มต่ำ)`);
    else if (scan.excludeStocks && isTokenizedStock(b)) dropped.push(`${b} (หุ้น/ETF โทเคน)`);
    else keep.push(x);
  }
  keep.sort((a, b) => b.qv - a.qv);
  const list = keep.slice(0, scan.maxCoins);
  keep.slice(scan.maxCoins).forEach(x => dropped.push(`${x.base} (เกินจำนวนสูงสุด)`));
  if (!list.length) throw new Error(`ไม่มีเหรียญเหลือให้สแกน (ไม่พบใน ${scan.exchange}: ${missing.join(", ") || "-"} · ถูกตัวกรองตัด: ${dropped.join(", ") || "-"})`);
  return { ex, list, missing, dropped };
}
export async function scanOne(scan, now = Date.now()) {
  if (scan.type === "rsi") return scanRsi(scan, now);
  const { ex, list, missing, dropped } = await prepareList(scan);
  const out = { long: [], short: [] }, flat = [], failed = [], failedBases = [];
  let idx = 0, lastErr = "";
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= list.length) return;
      const it = list[my];
      try {
        const per = {};
        let isFlat = false, lacking = null;
        for (const tf of scan.tfs) {
          const cs = (await ex.candles(it.id, tf)).filter(x => !Number.isNaN(x.c));
          const at = lastClosedIndex(cs, TFS[tf].hours, now);
          const r = evaluate(cs, { hamaMinStep: scan.hamaMinStep, minBars: TFS[tf].minBars, at });
          if (!r) { lacking = tf; break; }
          if (r.medRange / Math.sqrt(TFS[tf].hours) < scan.minRange) { isFlat = true; break; }
          per[tf] = r;
        }
        if (lacking) { failed.push(`${it.base}(ข้อมูล ${lacking} ไม่พอ)`); failedBases.push(it.base); }
        else if (isFlat) flat.push(it.base);
        else {
          for (const side of scan.sides) {
            const flags = r => side === "long" ? [r.atrGreen, r.aboveMa, r.hamaOk] : [r.atrRed, r.belowMa, r.hamaBear];
            if (scan.tfs.every(tf => flags(per[tf]).every(Boolean))) {
              const p = per[scan.tfs[0]];                       // TF เล็กสุด: ใช้แสดงราคา/ระยะห่าง/HAMA
              out[side].push({ base: it.base, tv: ex.tvPrefix + ":" + ex.tv(it.id), tvInterval: TFS[scan.tfs[0]].tv,
                               close: p.close, dist: side === "long" ? p.dist : p.distShort, step: p.step, qv: it.qv });
            }
          }
        }
      } catch (e) { failed.push(it.base); failedBases.push(it.base); lastErr = String(e && e.message || e); }
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ex.conc, list.length) }, worker));
  if (list.length >= 3 && failed.length >= list.length / 2)
    throw new Error(`ดึงข้อมูลแท่งเทียนจาก ${scan.exchange} ไม่สำเร็จ ${failed.length}/${list.length} ตัว (ล่าสุด: ${lastErr || "ข้อมูลไม่พอ"})`);
  for (const side of scan.sides) out[side].sort((a, b) => a.dist - b.dist);
  return { out, flat, failed, failedBases, missing, dropped, total: list.length };
}

// ---- RSI (Wilder / ta.rsi ของ TradingView: ใช้ RMA ของส่วนต่างราคาปิด เริ่มจากค่าเฉลี่ยธรรมดา n ค่าแรก) ----
export function rsiArr(c, n) {
  const out = new Array(c.length).fill(NaN);
  if (c.length <= n) return out;
  let up = 0, dn = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; up += Math.max(d, 0); dn += Math.max(-d, 0); }
  up /= n; dn /= n;
  const val = () => dn === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / dn);
  out[n] = val();
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    up = (up * (n - 1) + Math.max(d, 0)) / n;
    dn = (dn * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
export async function scanRsi(scan, now = Date.now()) {
  const { ex, list, missing, dropped } = await prepareList(scan);
  const out = { ob: {}, os: {} };
  for (const tf of scan.tfs) { out.ob[tf] = []; out.os[tf] = []; }
  const failed = [], failedKeys = [];                   // failedKeys = "BASE|tf" เพื่อคงสถานะเดิมของ TF ที่ดึงไม่ได้
  const failedCoins = new Set();
  let idx = 0, lastErr = "";
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= list.length) return;
      const it = list[my];
      for (const tf of scan.tfs) {
        try {
          const cs = (await ex.candles(it.id, tf)).filter(x => !Number.isNaN(x.c));
          const at = lastClosedIndex(cs, TFS[tf].hours, now);
          if (at < scan.rsiLength * 4) { failedKeys.push(`${it.base}|${tf}`); if (!failedCoins.has(it.base)) failed.push(`${it.base}(ข้อมูล ${tf} ไม่พอ)`); failedCoins.add(it.base); continue; }
          const v = rsiArr(cs.slice(0, at + 1).map(x => x.c), scan.rsiLength)[at];
          if (Number.isNaN(v)) { failedKeys.push(`${it.base}|${tf}`); continue; }
          const row = { base: it.base, tf, rsi: v, close: cs[at].c, tv: ex.tvPrefix + ":" + ex.tv(it.id), tvInterval: TFS[tf].tv };
          if (v >= scan.overbought) out.ob[tf].push(row);
          else if (v <= scan.oversold) out.os[tf].push(row);
        } catch (e) { failedKeys.push(`${it.base}|${tf}`); if (!failedCoins.has(it.base)) failed.push(it.base); failedCoins.add(it.base); lastErr = String(e && e.message || e); }
      }
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ex.conc, list.length) }, worker));
  if (list.length >= 3 && failedCoins.size >= list.length / 2)
    throw new Error(`ดึงข้อมูลแท่งเทียนจาก ${scan.exchange} ไม่สำเร็จ ${failedCoins.size}/${list.length} ตัว (ล่าสุด: ${lastErr || "ข้อมูลไม่พอ"})`);
  for (const tf of scan.tfs) { out.ob[tf].sort((a, b) => b.rsi - a.rsi); out.os[tf].sort((a, b) => a.rsi - b.rsi); }
  return { out, flat: [], failed, failedKeys, missing, dropped, total: list.length };
}
export function diffAndFormatRsi(scan, res, prev, cfg, opts = {}) {
  const showAll = cfg.notify === "all" || !!opts.forceAll;
  const next = { ob: {}, os: {} };
  const blocks = [];
  const zones = [["ob", "🔥", `OVERBOUGHT (RSI ≥ ${scan.overbought})`], ["os", "🧊", `OVERSOLD (RSI ≤ ${scan.oversold})`]];
  for (const [z, icon, title] of zones) {
    const lines = [];
    for (const tf of scan.tfs) {
      const rows = res.out[z][tf];
      const before = new Set((prev && prev[z] && prev[z][tf]) || []);
      const fresh = rows.filter(r => !before.has(r.base));
      const keepPrev = [...before].filter(b => (res.failedKeys || []).includes(`${b}|${tf}`));   // TF ที่ดึงไม่ได้รอบนี้ คงสถานะเดิม
      next[z][tf] = [...new Set([...rows.map(r => r.base), ...keepPrev])].sort();
      const shown = showAll ? rows : fresh;
      if (!shown.length) continue;
      const freshSet = new Set(fresh.map(r => r.base));
      lines.push(`<b>${tf.toUpperCase()}</b> — ใหม่ ${fresh.length} · อยู่ในโซน ${rows.length}`);
      for (const r of shown) {
        const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.tv)}&interval=${r.tvInterval}`;
        lines.push(`${freshSet.has(r.base) ? "🆕" : "▫️"} <a href="${h(url)}">${h(r.base)}/USDT</a>  RSI ${r.rsi.toFixed(1)} · ราคา ${fmtPrice(r.close)}`);
      }
      if (!showAll) {
        const still = rows.filter(r => !freshSet.has(r.base)).map(r => r.base);
        if (still.length) lines.push(`<i>ยังอยู่ในโซน: ${h(still.join(", "))}</i>`);
      }
    }
    if (lines.length) blocks.push(`${icon} <b>${title}</b>\n` + lines.join("\n"));
  }
  let text = null;
  if (blocks.length) {
    const head = `📊 <b>${h(scan.name)}</b>\n${scan.exchange.toUpperCase()} · RSI(${scan.rsiLength}) · ${fmtTime(opts.now ?? Date.now(), cfg.timezone)}`;
    const foot = [];
    if (res.missing.length) foot.push(`ไม่พบคู่ USDT: ${res.missing.join(", ")}`);
    if (res.dropped.length) foot.push(`ถูกตัวกรองตัด: ${res.dropped.join(", ")}`);
    if (res.failed.length) foot.push(`ดึงข้อมูลไม่ได้: ${res.failed.join(", ")}`);
    text = [head, ...blocks, ...(foot.length ? [`<i>${h(foot.join(" · "))}</i>`] : [])].join("\n\n");
  }
  return { text, next };
}

// ---- เทียบกับรอบก่อน + สร้างข้อความ ----
const h = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtPrice = p => p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);
export function fmtTime(ms, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
}
export function diffAndFormat(scan, res, prev, cfg, opts = {}) {
  const showAll = cfg.notify === "all" || !!opts.forceAll;
  const next = {};
  const blocks = [];
  for (const side of scan.sides) {
    const rows = res.out[side];
    const before = new Set((prev && prev[side]) || []);
    const fresh = rows.filter(r => !before.has(r.base));
    // เหรียญที่ดึงข้อมูลไม่ได้รอบนี้ คงสถานะเดิมไว้ ไม่ให้ถูกแจ้งเป็น "ใหม่" ซ้ำเมื่อกลับมา
    const keepPrev = [...before].filter(b => (res.failedBases || []).includes(b));
    next[side] = [...new Set([...rows.map(r => r.base), ...keepPrev])].sort();
    const shown = showAll ? rows : fresh;
    if (!shown.length) continue;
    const freshSet = new Set(fresh.map(r => r.base));
    const icon = side === "long" ? "🟢" : "🔴";
    const lines = [`${icon} <b>${side.toUpperCase()}</b> — ใหม่ ${fresh.length} · อยู่ในรายการ ${rows.length}`];
    for (const r of shown) {
      const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.tv)}&interval=${r.tvInterval}`;
      lines.push(`${freshSet.has(r.base) ? "🆕" : "▫️"} <a href="${h(url)}">${h(r.base)}/USDT</a>  ${fmtPrice(r.close)} · ห่างเส้น ${r.dist.toFixed(2)}% · HAMA ${r.step}`);
    }
    if (!showAll) {
      const still = rows.filter(r => !freshSet.has(r.base)).map(r => r.base);
      if (still.length) lines.push(`<i>ยังอยู่ในรายการ: ${h(still.join(", "))}</i>`);
    }
    blocks.push(lines.join("\n"));
  }
  let text = null;
  if (blocks.length) {
    const head = `📡 <b>${h(scan.name)}</b>\n${scan.exchange.toUpperCase()} · TF ${scan.tfs.join("+")} · ${fmtTime(opts.now ?? Date.now(), cfg.timezone)}`;
    const foot = [];
    if (res.missing.length) foot.push(`ไม่พบคู่ USDT: ${res.missing.join(", ")}`);
    if (res.dropped.length) foot.push(`ถูกตัวกรองตัด: ${res.dropped.join(", ")}`);
    if (res.flat.length) foot.push(`ราคานิ่งเกินไป: ${res.flat.join(", ")}`);
    if (res.failed.length) foot.push(`ดึงข้อมูลไม่ได้: ${res.failed.join(", ")}`);
    text = [head, ...blocks, ...(foot.length ? [`<i>${h(foot.join(" · "))}</i>`] : [])].join("\n\n");
  }
  return { text, next };
}
export function splitMessage(text, max = 3800) {
  const chunks = [];
  let cur = "";
  const push = () => { if (cur) { chunks.push(cur); cur = ""; } };
  for (let line of text.split("\n")) {
    while (line.length > max) { push(); chunks.push(line.slice(0, max)); line = line.slice(max); }
    if (cur && cur.length + 1 + line.length > max) push();
    cur = cur ? cur + "\n" + line : line;
  }
  push();
  return chunks;
}

// ---- state (จำว่ารอบก่อนมีเหรียญอะไรอยู่ในรายการ เพื่อแจ้งเฉพาะเหรียญใหม่) ----
function loadState(path) {
  try { const s = JSON.parse(fs.readFileSync(path, "utf8")); if (s && typeof s === "object" && s.scans) return s; } catch (e) {}
  return { version: 1, scans: {} };
}
function saveState(path, st) {
  const body = JSON.stringify(st, null, 2) + "\n";
  let old = null;
  try { old = fs.readFileSync(path, "utf8"); } catch (e) {}
  if (old !== body) fs.writeFileSync(path, body);       // ไม่แก้ไฟล์ถ้าไม่มีอะไรเปลี่ยน จะได้ไม่เกิด commit รัวๆ
}

// ---- Telegram ----
function makeSender(env) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  const scrub = s => (token ? String(s).split(token).join("***") : String(s));
  return async function send(text) {
    if (env.DRY_RUN === "1") { console.log("----- [DRY RUN] ข้อความที่จะส่ง -----\n" + text + "\n-----"); return true; }
    for (const chunk of splitMessage(text)) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: chunk, parse_mode: "HTML", disable_web_page_preview: true }),
        });
        if (!r.ok) {
          const b = await r.text().catch(() => "");
          console.error(scrub(`ส่ง Telegram ไม่สำเร็จ: HTTP ${r.status} ${b.slice(0, 300)}`));
          return false;
        }
      } catch (e) { console.error(scrub("ส่ง Telegram ไม่สำเร็จ: " + (e && e.message || e))); return false; }
    }
    return true;
  };
}

// ---- main ----
export async function main(env = process.env) {
  const cfgPath = env.CONFIG_PATH || "config.json", statePath = env.STATE_PATH || "state.json";
  const dry = env.DRY_RUN === "1";
  if (!dry && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    console.error("ยังไม่ได้ตั้งค่า Secrets: TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID (Settings → Secrets and variables → Actions)");
    return 1;
  }
  const send = makeSender(env);
  const state = loadState(statePath);
  const now = Date.now();
  let code = 0;

  let cfg;
  try { cfg = normalizeConfig(JSON.parse(fs.readFileSync(cfgPath, "utf8"))); }
  catch (e) {
    const msg = e instanceof SyntaxError ? `อ่าน ${cfgPath} ไม่ได้ (รูปแบบ JSON ผิด): ${e.message}` : String(e.message || e);
    console.error("CONFIG ERROR:\n" + msg);
    if (state.configError !== msg) { await send(`⚠️ <b>config.json ใช้ไม่ได้</b>\n${h(msg)}`); }
    state.configError = msg; saveState(statePath, state);
    return 1;
  }
  if (state.configError) { delete state.configError; }

  if (env.SEND_TEST === "1") {
    const ok = await send("✅ <b>ทดสอบการแจ้งเตือน</b>\nตั้งค่า Telegram สำเร็จ ชุดสแกนจะส่งข้อความมาที่นี่เมื่อเจอเหรียญใหม่");
    if (!ok) code = 1;
  }

  const active = cfg.scans.filter(s => s.enabled);
  console.log(`สแกน ${active.length} ชุด (${cfg.scans.length - active.length} ชุดปิดอยู่) เวลา ${fmtTime(now, cfg.timezone)} (${cfg.timezone})`);
  for (const scan of active) {
    const prev = state.scans[scan.name] || {};
    let res;
    try { res = await scanOne(scan, now); }
    catch (e) {
      const msg = String(e && e.message || e);
      console.error(`[${scan.name}] ERROR: ${msg}`);
      const hint = /HTTP (451|403|401)|fetch failed|ไม่สำเร็จ/.test(msg)
        ? "\nถ้าเป็น HTTP 451/403 หรือต่อไม่ได้ แปลว่า exchange อาจบล็อกเซิร์ฟเวอร์ของ GitHub ให้ลองเปลี่ยน \"exchange\" ใน config.json (เช่น okx, bybit, bitget)" : "";
      if (prev.error !== msg) await send(`⚠️ <b>${h(scan.name)}</b> สแกนไม่สำเร็จ\n${h(msg)}${h(hint)}\n<i>จะแจ้งอีกครั้งเมื่อกลับมาใช้งานได้</i>`);
      state.scans[scan.name] = { ...prev, error: msg };
      continue;
    }
    const { text, next } = (scan.type === "rsi" ? diffAndFormatRsi : diffAndFormat)(scan, res, prev, cfg, { now, forceAll: env.FORCE_ALL === "1" });
    let ok = true;
    if (prev.error) ok = await send(`✅ <b>${h(scan.name)}</b> กลับมาสแกนได้ปกติแล้ว`);
    if (ok && text) ok = await send(text);
    if (scan.type === "rsi") for (const z of ["ob", "os"]) for (const tf of scan.tfs)
      console.log(`[${scan.name}] RSI ${z === "ob" ? "OB" : "OS"} ${tf}: ${res.out[z][tf].map(r => r.base + " " + r.rsi.toFixed(1)).join(", ") || "-"} · ตรวจ ${res.total} ตัว`
        + (res.failed.length ? ` · ดึงไม่ได้ ${res.failed.join(", ")}` : ""));
    else for (const side of scan.sides)
      console.log(`[${scan.name}] ${side}: ${res.out[side].length} เหรียญ (${res.out[side].map(r => r.base).join(", ") || "-"}) · ตรวจ ${res.total} ตัว`
        + (res.failed.length ? ` · ดึงไม่ได้ ${res.failed.join(", ")}` : ""));
    if (!ok) { console.error(`[${scan.name}] ส่ง Telegram ไม่สำเร็จ จะลองใหม่รอบหน้า`); code = 1; state.scans[scan.name] = { ...prev }; continue; }
    state.scans[scan.name] = next;
  }
  for (const name of Object.keys(state.scans)) if (!cfg.scans.some(s => s.name === name)) delete state.scans[name];   // ลบสถานะของชุดที่ไม่มีใน config แล้ว
  for (const s of Object.values(state.scans)) if (!s.error) delete s.error;
  saveState(statePath, state);
  return code;
}

export { TFS, EX, evaluate, parseCoins, isTokenizedStock };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}
