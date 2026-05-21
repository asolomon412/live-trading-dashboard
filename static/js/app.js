/**
 * Author: Antonella Solomon
 * app.js — dashboard orchestration
 *
 * Responsibilities:
 *   • Manage the chart count selector + grid CSS class
 *   • Create/destroy pane DOM nodes and PaneChart instances
 *   • Maintain a single WebSocket connection to the backend
 *   • Dispatch incoming WS messages to the correct pane
 *   • Drive the ticker bar (price, change, flash animation)
 */

// ── Default symbols per pane index ────────────────────────────────────────
const DEFAULT_CONFIGS = [
  { symbol: "AAPL",  tf: "1h", source: "alpaca" },
  { symbol: "TSLA",  tf: "1h", source: "alpaca" },
  { symbol: "NVDA",  tf: "1h", source: "alpaca" },
  { symbol: "MSFT",  tf: "1h", source: "alpaca" },
  { symbol: "AMZN",  tf: "1h", source: "alpaca" },
  { symbol: "META",  tf: "1h", source: "alpaca" },
  { symbol: "GOOGL", tf: "1h", source: "alpaca" },
  { symbol: "SPY",   tf: "1h", source: "alpaca" },
];

const HL_SYMBOLS = new Set(["BTC","ETH","SOL","AVAX","DOGE","LINK","ARB","OP","XRP","ATOM","BNB","MATIC","LTC","BCH"]);

const LS_COUNT_KEY  = "chartCount";
const LS_CONFIG_KEY = "paneConfigs";

// ── State ──────────────────────────────────────────────────────────────────
let chartCount = parseInt(localStorage.getItem(LS_COUNT_KEY) || "4", 10);
let paneConfigs = JSON.parse(localStorage.getItem(LS_CONFIG_KEY) || "null") || DEFAULT_CONFIGS;

/** @type {Map<number, PaneChart>} pane_id → PaneChart */
const charts = new Map();

/** @type {Map<number, HTMLElement>} pane_id → root pane element */
const paneEls = new Map();

/** Last known price per pane for change calc */
const lastPrices = new Map();

// ── Resize state ───────────────────────────────────────────────────────────
const LAYOUT_COLS    = { 1:1, 2:2, 3:2, 4:2, 6:3, 8:4 };
const LAYOUT_ROWS    = { 1:1, 2:1, 3:2, 4:2, 6:2, 8:2 };
const LS_GRID_SIZES  = "gridSizes";
const RESIZE_MIN_FR  = 0.12;   // minimum fraction any column/row can shrink to

let gridSizes = JSON.parse(localStorage.getItem(LS_GRID_SIZES) || "{}");

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;
let wsReady = false;
const pendingSubscriptions = [];

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // location.host already includes the correct port since Flask serves the page
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  setConnStatus("connecting");

  ws.onopen = () => {
    wsReady = true;
    setConnStatus("connected");
    // Flush any subscriptions that were queued before connect
    while (pendingSubscriptions.length) {
      const msg = pendingSubscriptions.shift();
      ws.send(JSON.stringify(msg));
    }
  };

  ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    handleWsMessage(data);
  };

  ws.onclose = () => {
    wsReady = false;
    setConnStatus("disconnected");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };

  // Keepalive ping every 20 s
  setInterval(() => {
    if (wsReady) ws.send(JSON.stringify({ action: "ping" }));
  }, 20_000);
}

function wsSend(msg) {
  if (wsReady) {
    ws.send(JSON.stringify(msg));
  } else {
    pendingSubscriptions.push(msg);
  }
}

function handleWsMessage(data) {
  const paneId = data.pane_id;
  if (paneId == null) return;

  const chart   = charts.get(paneId);
  const paneEl  = paneEls.get(paneId);
  if (!chart || !paneEl) return;

  if (data.type === "bar" || data.type === "tick") {
    const newPrice = chart.update(data);
    if (newPrice != null) {
      updateTickerBar(paneId, newPrice, data.type);
    }
    removeOverlay(paneEl);
  } else if (data.type === "error") {
    showOverlay(paneEl, `⚠ ${data.message}`);
  }
}

// ── History fetch ──────────────────────────────────────────────────────────
function loadHistory(paneId) {
  const cfg = paneConfigs[paneId];
  if (!cfg) return;
  const { symbol, tf, source } = cfg;

  showOverlay(paneEls.get(paneId), "Loading…");

  const url = `/api/history?symbol=${encodeURIComponent(symbol)}&tf=${tf}&source=${source}&limit=300`;
  fetch(url)
    .then(r => r.json())
    .then(bars => {
      if (!Array.isArray(bars) || bars.length === 0) {
        showOverlay(paneEls.get(paneId), "No data");
        return;
      }
      const chart = charts.get(paneId);
      if (chart) {
        chart.setData(bars);
        // Re-apply saved indicators (addIndicator is idempotent — safe to call again on reload)
        for (const key of (paneConfigs[paneId]?.indicators || [])) {
          chart.addIndicator(key);
        }
        const change = chart.getChange();
        if (change) updateTickerBar(paneId, change.price, "init");
        removeOverlay(paneEls.get(paneId));
      }
    })
    .catch(err => {
      showOverlay(paneEls.get(paneId), `Error: ${err.message}`);
    });
}

// ── Ticker bar ─────────────────────────────────────────────────────────────
function updateTickerBar(paneId, newPrice, updateType) {
  const paneEl = paneEls.get(paneId);
  if (!paneEl) return;

  const bar      = paneEl.querySelector(".ticker-bar");
  const priceEl  = paneEl.querySelector(".ticker-price");
  const changeEl = paneEl.querySelector(".ticker-change");

  const prevPrice = lastPrices.get(paneId);
  lastPrices.set(paneId, newPrice);

  // Format price
  const formatted = formatPrice(newPrice);
  priceEl.textContent = formatted;

  // Change vs session open (first bar close)
  const chart  = charts.get(paneId);
  const change = chart ? chart.getChange() : null;
  if (change) {
    const sign = change.pct >= 0 ? "+" : "";
    changeEl.textContent = `${sign}${change.pct.toFixed(2)}%`;
    changeEl.className = "ticker-change " + (change.pct >= 0 ? "up" : "down");
  }

  // Flash on live tick
  if (updateType === "tick" || updateType === "bar") {
    if (prevPrice != null) {
      const cls = newPrice >= prevPrice ? "flash-green" : "flash-red";
      bar.classList.remove("flash-green", "flash-red");
      // force reflow so the animation re-triggers
      void bar.offsetWidth;
      bar.classList.add(cls);
      setTimeout(() => bar.classList.remove(cls), 650);
    }
  }
}

function formatPrice(p) {
  if (p >= 1000)  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

// ── Pane creation / teardown ───────────────────────────────────────────────
function createPane(paneId) {
  const template = document.getElementById("pane-template");
  const node     = template.content.cloneNode(true);
  const paneEl   = node.querySelector(".chart-pane");
  paneEl.dataset.paneId = paneId;

  const cfg = paneConfigs[paneId] || DEFAULT_CONFIGS[paneId] || DEFAULT_CONFIGS[0];

  // Restore controls
  paneEl.querySelector(".source-select").value = cfg.source;
  paneEl.querySelector(".symbol-input").value  = cfg.symbol;
  paneEl.querySelector(".tf-select").value     = cfg.tf;
  paneEl.querySelector(".ticker-symbol").textContent = cfg.symbol;

  // Wire controls
  const btnLoad    = paneEl.querySelector(".btn-load");
  const srcSel     = paneEl.querySelector(".source-select");
  const symInput   = paneEl.querySelector(".symbol-input");
  const tfSel      = paneEl.querySelector(".tf-select");

  const applyConfig = () => {
    const newCfg = {
      symbol:     symInput.value.trim().toUpperCase() || cfg.symbol,
      tf:         tfSel.value,
      source:     srcSel.value,
      indicators: paneConfigs[paneId]?.indicators || [],  // preserved across reloads
    };
    paneConfigs[paneId] = newCfg;
    saveConfigs();
    paneEl.querySelector(".ticker-symbol").textContent = newCfg.symbol;
    lastPrices.delete(paneId);
    subscribePane(paneId);
  };

  // Sync tf options to source on init and on every source change
  syncTfOptions(srcSel, tfSel);

  btnLoad.addEventListener("click", applyConfig);
  symInput.addEventListener("keydown", e => { if (e.key === "Enter") applyConfig(); });
  tfSel.addEventListener("change", applyConfig);
  srcSel.addEventListener("change", () => {
    syncTfOptions(srcSel, tfSel);
    // Auto-suggest a sensible default symbol when switching source type
    const sym = symInput.value.trim().toUpperCase();
    if (srcSel.value === "hyperliquid" && !HL_SYMBOLS.has(sym)) {
      symInput.value = "BTC";
    } else if (srcSel.value !== "hyperliquid" && HL_SYMBOLS.has(sym)) {
      symInput.value = "AAPL";
    }
    applyConfig();
  });

  // ── Indicator panel ──────────────────────────────────────────────────────
  const btnInd   = paneEl.querySelector(".btn-indicators");
  const indPanel = paneEl.querySelector(".indicator-panel");
  const savedInds = new Set(paneConfigs[paneId]?.indicators || []);

  for (const group of INDICATOR_GROUPS) {
    const groupEl  = document.createElement("div");
    groupEl.className = "ind-group";
    const header   = document.createElement("div");
    header.className = "ind-group-label";
    header.textContent = group.label;
    groupEl.appendChild(header);

    for (const item of group.items) {
      const row = document.createElement("label");
      row.className = "indicator-item";

      const dot = document.createElement("span");
      dot.className = "indicator-dot";
      dot.style.background = item.color;

      const lbl = document.createElement("span");
      lbl.className = "ind-item-label";
      lbl.textContent = item.label;

      const cb = document.createElement("input");
      cb.type    = "checkbox";
      cb.value   = item.key;
      cb.checked = savedInds.has(item.key);

      cb.addEventListener("change", () => {
        const chart = charts.get(paneId);
        if (!chart) return;
        const inds = paneConfigs[paneId].indicators || [];
        if (cb.checked) {
          chart.addIndicator(item.key);
          if (!inds.includes(item.key)) inds.push(item.key);
        } else {
          chart.removeIndicator(item.key);
          paneConfigs[paneId].indicators = inds.filter(k => k !== item.key);
        }
        if (cb.checked) paneConfigs[paneId].indicators = inds;
        saveConfigs();
        _refreshIndBadge(paneEl);
      });

      row.appendChild(dot);
      row.appendChild(lbl);
      row.appendChild(cb);
      groupEl.appendChild(row);
    }
    indPanel.appendChild(groupEl);
  }

  btnInd.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = indPanel.hidden;
    // Close any other open panels
    document.querySelectorAll(".indicator-panel:not([hidden])").forEach(p => { p.hidden = true; });
    indPanel.hidden = !opening;
  });

  _refreshIndBadge(paneEl);

  // Append to grid
  const grid = document.getElementById("chart-grid");
  grid.appendChild(paneEl);
  paneEls.set(paneId, paneEl);

  // Create chart
  const container = paneEl.querySelector(".chart-container");
  const pChart    = new PaneChart(container);
  charts.set(paneId, pChart);

  // Wire drawing toolbar
  const drawBtns = paneEl.querySelectorAll(".btn-draw:not(.btn-draw-clear)");
  drawBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      drawBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      pChart.setDrawingTool(btn.dataset.tool);
    });
  });
  paneEl.querySelector(".btn-draw-clear").addEventListener("click", () => {
    pChart.clearDrawings();
  });

  return paneEl;
}

function destroyPane(paneId) {
  // Unsubscribe
  wsSend({ action: "unsubscribe", pane_id: paneId });

  // Destroy chart
  const chart = charts.get(paneId);
  if (chart) { chart.destroy(); charts.delete(paneId); }

  // Remove DOM
  const el = paneEls.get(paneId);
  if (el) { el.remove(); paneEls.delete(paneId); }

  lastPrices.delete(paneId);
}

// ── Subscribe a pane to live data ──────────────────────────────────────────
function subscribePane(paneId) {
  const cfg = paneConfigs[paneId];
  if (!cfg) return;
  wsSend({
    action:   "subscribe",
    pane_id:  paneId,
    symbol:   cfg.symbol,
    tf:       cfg.tf,
    source:   cfg.source,
  });
  // Also pre-load history immediately (don't wait for "subscribed" message)
  loadHistory(paneId);
}

// ── Grid management ────────────────────────────────────────────────────────
const GRID_CLASSES = ["grid-1","grid-2","grid-3","grid-4","grid-6","grid-8"];

function setChartCount(n) {
  chartCount = n;
  localStorage.setItem(LS_COUNT_KEY, n);

  const grid = document.getElementById("chart-grid");
  GRID_CLASSES.forEach(c => grid.classList.remove(c));
  grid.classList.add(`grid-${n}`);
  applyGridSizes(n);

  // Remove excess panes
  const existing = [...paneEls.keys()];
  existing.forEach(id => { if (id >= n) destroyPane(id); });

  // Add missing panes
  for (let i = 0; i < n; i++) {
    if (!paneEls.has(i)) {
      createPane(i);
      subscribePane(i);
    }
  }
}

// ── Overlay helpers ────────────────────────────────────────────────────────
function showOverlay(paneEl, msg) {
  if (!paneEl) return;
  let ov = paneEl.querySelector(".pane-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "pane-overlay";
    paneEl.appendChild(ov);
  }
  ov.textContent = msg;
  ov.style.display = "flex";
}

function removeOverlay(paneEl) {
  if (!paneEl) return;
  const ov = paneEl.querySelector(".pane-overlay");
  if (ov) ov.style.display = "none";
}

// ── Grid resize ────────────────────────────────────────────────────────────

function _getLayoutSizes(count) {
  if (!gridSizes[count]) {
    gridSizes[count] = {
      cols: Array(LAYOUT_COLS[count]).fill(1),
      rows: Array(LAYOUT_ROWS[count]).fill(1),
    };
  }
  return gridSizes[count];
}

// Full apply: update CSS template + rebuild handle DOM (used on init / count change / reset)
function applyGridSizes(count) {
  _applyGridTemplate(count);
  _rebuildHandles(count);
}

// Lightweight apply: only update CSS + reposition existing handles (used every mouse-move frame)
function _applyGridTemplate(count) {
  const grid = document.getElementById("chart-grid");
  const { cols, rows } = _getLayoutSizes(count);
  grid.style.gridTemplateColumns = cols.map(f => f + "fr").join(" ");
  grid.style.gridTemplateRows    = rows.map(f => f + "fr").join(" ");
  _repositionHandles(count);
}

// Move existing handle elements to reflect current fr values — no DOM creation
function _repositionHandles(count) {
  const grid = document.getElementById("chart-grid");
  const { cols, rows } = _getLayoutSizes(count);

  const colHandles = [...grid.querySelectorAll(".grid-handle-col")];
  const totalCols  = cols.reduce((a, b) => a + b, 0);
  let cumCol = 0;
  colHandles.forEach((h, i) => {
    cumCol += cols[i];
    h.style.left = (cumCol / totalCols * 100) + "%";
  });

  const rowHandles = [...grid.querySelectorAll(".grid-handle-row")];
  const totalRows  = rows.reduce((a, b) => a + b, 0);
  let cumRow = 0;
  rowHandles.forEach((h, j) => {
    cumRow += rows[j];
    h.style.top = (cumRow / totalRows * 100) + "%";
  });
}

// Create handle DOM elements (only called outside of active drag)
function _rebuildHandles(count) {
  const grid = document.getElementById("chart-grid");
  grid.querySelectorAll(".grid-handle").forEach(h => h.remove());

  const { cols, rows } = _getLayoutSizes(count);

  const makeHandle = (axis, idx) => {
    const h = document.createElement("div");
    h.className = `grid-handle grid-handle-${axis}`;
    h.title = "Drag to resize  ·  Double-click to reset";
    h.addEventListener("mousedown", e => _startResize(e, axis, idx, count));
    h.addEventListener("dblclick",  () => _resetSizes(count));
    grid.appendChild(h);
    return h;
  };

  if (cols.length > 1) {
    const total = cols.reduce((a, b) => a + b, 0);
    let cum = 0;
    for (let i = 0; i < cols.length - 1; i++) {
      cum += cols[i];
      makeHandle("col", i).style.left = (cum / total * 100) + "%";
    }
  }
  if (rows.length > 1) {
    const total = rows.reduce((a, b) => a + b, 0);
    let cum = 0;
    for (let j = 0; j < rows.length - 1; j++) {
      cum += rows[j];
      makeHandle("row", j).style.top = (cum / total * 100) + "%";
    }
  }
}

function _saveGridSizes() {
  localStorage.setItem(LS_GRID_SIZES, JSON.stringify(gridSizes));
}

function _resetSizes(count) {
  delete gridSizes[count];
  applyGridSizes(count);
  _saveGridSizes();
  _triggerChartResize();
}

function _startResize(e, axis, idx, count) {
  e.preventDefault();
  e.stopPropagation();

  const handle = e.currentTarget;          // capture before event clears currentTarget
  const grid   = document.getElementById("chart-grid");
  const rect   = grid.getBoundingClientRect();
  const sizes  = _getLayoutSizes(count);
  const arr    = axis === "col" ? sizes.cols : sizes.rows;
  const dim    = axis === "col" ? rect.width : rect.height;
  const start  = axis === "col" ? e.clientX : e.clientY;
  const a0     = arr[idx];
  const b0     = arr[idx + 1];
  const total  = arr.reduce((s, v) => s + v, 0);

  handle.classList.add("active");
  document.body.style.cursor     = axis === "col" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";

  function onMove(ev) {
    const deltaFr = ((axis === "col" ? ev.clientX : ev.clientY) - start) / dim * total;
    arr[idx]      = Math.max(RESIZE_MIN_FR, a0 + deltaFr);
    arr[idx + 1]  = Math.max(RESIZE_MIN_FR, b0 - deltaFr);
    // Lightweight update: only CSS + handle positions, no DOM recreation
    _applyGridTemplate(count);
    // Double rAF: first frame kicks off after layout recalc, second reads settled dimensions
    _triggerChartResize();
  }

  function onUp() {
    handle.classList.remove("active");
    document.body.style.cursor     = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup",   onUp);
    _saveGridSizes();
    _triggerChartResize();
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup",   onUp);
}

function _triggerChartResize() {
  requestAnimationFrame(() => charts.forEach(c => c && c.resize()));
}

// ── Timeframe option gating ────────────────────────────────────────────────
// Hides timeframes unsupported by a given source and bumps the current value
// to the nearest valid option if needed.
const TF_UNSUPPORTED = {
  hyperliquid: new Set(["2m"]),
};

function syncTfOptions(srcSel, tfSel) {
  const blocked = TF_UNSUPPORTED[srcSel.value] || new Set();
  for (const opt of tfSel.options) {
    const unsupported = blocked.has(opt.value);
    opt.disabled = unsupported;
    opt.hidden   = unsupported;
  }
  // If the currently selected tf is now blocked, move to the nearest valid one
  if (blocked.has(tfSel.value)) {
    const fallback = [...tfSel.options].find(o => !o.disabled);
    if (fallback) tfSel.value = fallback.value;
  }
}

// ── Indicator badge ────────────────────────────────────────────────────────
function _refreshIndBadge(paneEl) {
  const badge = paneEl.querySelector(".ind-badge");
  const count = paneEl.querySelectorAll(".indicator-panel input:checked").length;
  badge.textContent   = count > 0 ? count : "";
  badge.style.display = count > 0 ? "inline-flex" : "none";
}

// ── Persistence ────────────────────────────────────────────────────────────
function saveConfigs() {
  localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(paneConfigs));
}

// ── Boot ───────────────────────────────────────────────────────────────────
function init() {
  // Restore saved count in the selector
  const sel = document.getElementById("chart-count-select");
  sel.value = String(chartCount);
  sel.addEventListener("change", () => setChartCount(parseInt(sel.value, 10)));

  // Build initial grid
  setChartCount(chartCount);

  // Close any open indicator panel when clicking elsewhere
  document.addEventListener("click", () => {
    document.querySelectorAll(".indicator-panel:not([hidden])").forEach(p => { p.hidden = true; });
  });

  // ESC cancels any in-progress drawing and reverts all panes to cursor tool
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    charts.forEach((chart, paneId) => {
      chart.setDrawingTool("cursor");
      const paneEl = paneEls.get(paneId);
      if (!paneEl) return;
      paneEl.querySelectorAll(".btn-draw:not(.btn-draw-clear)").forEach(b => {
        b.classList.toggle("active", b.dataset.tool === "cursor");
      });
    });
  });

  // Open WebSocket
  connectWS();
}

// ── Connection status indicator ────────────────────────────────────────────
function setConnStatus(status) {
  const el    = document.getElementById("conn-indicator");
  const label = el.querySelector(".conn-label");
  el.className = `conn-indicator ${status}`;
  label.textContent = { connected: "Live", disconnected: "Offline", connecting: "Connecting…" }[status] || status;
}

document.addEventListener("DOMContentLoaded", init);
