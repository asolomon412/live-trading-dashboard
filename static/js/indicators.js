/**
 * Author: Antonella Solomon
 * indicators.js — definitions and calculation functions for chart overlays.
 *
 * INDICATOR_GROUPS drives the UI panel (order + grouping).
 * INDICATORS is a flat key→definition lookup used by charts.js.
 * Each definition has: key, label, color, calc(bars) → data, optional type:'band'.
 */

const INDICATOR_GROUPS = [
  {
    label: "Moving Averages",
    items: [
      { key: "SMA_20",  label: "SMA 20",  color: "#f0883e" },
      { key: "SMA_50",  label: "SMA 50",  color: "#58a6ff" },
      { key: "SMA_200", label: "SMA 200", color: "#ff7b72" },
      { key: "EMA_9",   label: "EMA 9",   color: "#7ee787" },
      { key: "EMA_21",  label: "EMA 21",  color: "#d2a8ff" },
      { key: "EMA_50",  label: "EMA 50",  color: "#ffa657" },
    ],
  },
  {
    label: "Bands",
    items: [
      { key: "BB_20", label: "BB 20", color: "#79c0ff", type: "band" },
    ],
  },
  {
    label: "Other",
    items: [
      { key: "VWAP", label: "VWAP", color: "#e3b341" },
    ],
  },
];

// Flat lookup — populated below
const INDICATORS = {};
for (const group of INDICATOR_GROUPS)
  for (const item of group.items)
    INDICATORS[item.key] = { ...item };

// ── Calculation functions ──────────────────────────────────────────────────

function _sma(bars, period) {
  const out = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += bars[i - j].close;
    out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

function _ema(bars, period) {
  if (bars.length === 0) return [];
  const k = 2 / (period + 1);
  let ema = bars[0].close;
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    if (i >= period - 1) out.push({ time: bars[i].time, value: ema });
  }
  return out;
}

function _bb(bars, period, mult) {
  const upper = [], middle = [], lower = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += bars[i - j].close;
    const avg = sum / period;
    let variance = 0;
    for (let j = 0; j < period; j++) variance += (bars[i - j].close - avg) ** 2;
    const sd = Math.sqrt(variance / period);
    upper.push({ time: bars[i].time, value: avg + mult * sd });
    middle.push({ time: bars[i].time, value: avg });
    lower.push({ time: bars[i].time, value: avg - mult * sd });
  }
  return { upper, middle, lower };
}

function _vwap(bars) {
  const out = [];
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const vol = b.volume || 0;
    cumTPV += ((b.high + b.low + b.close) / 3) * vol;
    cumVol += vol;
    if (cumVol > 0) out.push({ time: b.time, value: cumTPV / cumVol });
  }
  return out;
}

// Attach calc functions to definitions
INDICATORS.SMA_20.calc  = b => _sma(b, 20);
INDICATORS.SMA_50.calc  = b => _sma(b, 50);
INDICATORS.SMA_200.calc = b => _sma(b, 200);
INDICATORS.EMA_9.calc   = b => _ema(b, 9);
INDICATORS.EMA_21.calc  = b => _ema(b, 21);
INDICATORS.EMA_50.calc  = b => _ema(b, 50);
INDICATORS.BB_20.calc   = b => _bb(b, 20, 2);
INDICATORS.VWAP.calc    = b => _vwap(b);
