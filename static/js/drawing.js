// Author: Antonella Solomon
/**
 * drawing.js — SVG overlay drawing tools (trendlines, fibonacci, price lines)
 *
 * DrawingManager attaches an SVG layer and a transparent hit layer to a
 * .chart-container element. Coordinates are in chart-pixel space and are
 * re-projected on every render so drawings stay anchored when the user
 * scrolls or zooms.
 *
 * Tools
 *   cursor    — default; click near a drawing to delete it
 *   trendline — click two points to draw a line
 *   fibonacci — click high then low; draws all standard fib levels
 *   priceline — click once to place a dashed horizontal price level
 *
 * ESC / right-click cancels a drawing in progress.
 */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#c9d1d9", "#f0883e", "#3fb950", "#f0883e", "#3fb950", "#58a6ff", "#c9d1d9"];

class DrawingManager {
  constructor(container, chart, series) {
    this._container = container;
    this._chart     = chart;
    this._series    = series;
    this._tool      = "cursor";
    this._drawings  = [];
    this._anchor    = null;  // first click during 2-point drawing
    this._ghost     = null;  // current cursor position for live preview

    // SVG layer — renders committed drawings and the ghost preview.
    // Root is always pointer-events:none so wheel/drag pass through to LWC.
    // Individual drawing <g> elements opt back in with pointer-events:all.
    const svg = this._svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "absolute", inset: "0",
      width: "100%", height: "100%",
      pointerEvents: "none", zIndex: "10", overflow: "visible",
    });
    container.appendChild(svg);

    // Hit layer — intercepts mouse events when a drawing tool is active
    const hit = this._hit = document.createElement("div");
    Object.assign(hit.style, {
      position: "absolute", inset: "0",
      zIndex: "11", display: "none", cursor: "crosshair",
    });
    hit.addEventListener("click",       e => this._onHitClick(e));
    hit.addEventListener("mousemove",   e => this._onHitMove(e));
    hit.addEventListener("contextmenu", e => { e.preventDefault(); this._cancelAnchor(); });
    container.appendChild(hit);

    // Re-render whenever the chart scrolls or zooms
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.render());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setTool(tool) {
    this._tool = tool;
    this._cancelAnchor();
    this._hit.style.display = tool !== "cursor" ? "block" : "none";
    // SVG root stays pointer-events:none always; <g> elements handle their own clicks
    this.render();
  }

  render() {
    this._svg.innerHTML = "";
    this._drawings.forEach((d, i) => this._renderOne(d, i));
    if (this._anchor && this._ghost) this._renderGhost();
  }

  clearAll() {
    this._drawings = [];
    this._cancelAnchor();
    this.render();
  }

  destroy() {
    this._svg.remove();
    this._hit.remove();
  }

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  // Drawing mode: place anchor or complete the drawing
  _onHitClick(e) {
    const { x, y } = this._rel(e);
    const time  = this._chart.timeScale().coordinateToTime(x);
    const price = this._series.coordinateToPrice(y);
    if (time == null || price == null) return;

    if (this._tool === "priceline") {
      this._drawings.push({ type: "priceline", price });
      this.render();
      return;
    }

    if (!this._anchor) {
      this._anchor = { x, y, time, price };
    } else {
      this._drawings.push({
        type: this._tool,
        time:   this._anchor.time, price:  this._anchor.price,
        time2:  time,              price2: price,
      });
      this._anchor = null;
      this._ghost  = null;
      this.render();
    }
  }

  _onHitMove(e) {
    if (!this._anchor) return;
    this._ghost = this._rel(e);
    this.render();
  }

  _cancelAnchor() {
    this._anchor = null;
    this._ghost  = null;
    this.render();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _renderOne(d, idx) {
    const g = _svgEl("g");
    // In cursor mode each <g> opts into pointer events for click-to-delete.
    // Drawing mode keeps them inert (hit layer is on top anyway).
    if (this._tool === "cursor") {
      g.style.pointerEvents = "all";
      g.style.cursor        = "pointer";
      g.addEventListener("click", () => {
        this._drawings.splice(idx, 1);
        this.render();
      });
    }
    this._svg.appendChild(g);
    if      (d.type === "trendline") this._drawTrendline(d, g);
    else if (d.type === "fibonacci") this._drawFibonacci(d, g);
    else if (d.type === "priceline") this._drawPriceline(d, g);
  }

  _drawTrendline(d, g) {
    const x1 = this._tx(d.time),  y1 = this._py(d.price);
    const x2 = this._tx(d.time2), y2 = this._py(d.price2);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return;
    _svgLine(g, x1, y1, x2, y2, "transparent", 12);  // wide invisible hit area
    _svgLine(g, x1, y1, x2, y2, "#58a6ff", 1.5);
    _svgDot(g, x1, y1, "#58a6ff");
    _svgDot(g, x2, y2, "#58a6ff");
  }

  _drawFibonacci(d, g) {
    const w     = this._container.clientWidth;
    const range = d.price - d.price2;
    FIB_LEVELS.forEach((lv, i) => {
      const price = d.price2 + range * (1 - lv);
      const y = this._py(price);
      if (y == null) return;
      _svgLine(g, 0, y, w, y, FIB_COLORS[i], 1, 0.85);
      _svgText(g, w - 5, y - 3, `${(lv * 100).toFixed(1)}%   ${price.toFixed(2)}`, FIB_COLORS[i]);
    });
    const x1 = this._tx(d.time),  y1 = this._py(d.price);
    const x2 = this._tx(d.time2), y2 = this._py(d.price2);
    if (x1 != null && y1 != null) _svgDot(g, x1, y1, FIB_COLORS[0]);
    if (x2 != null && y2 != null) _svgDot(g, x2, y2, FIB_COLORS[6]);
  }

  _drawPriceline(d, g) {
    const y = this._py(d.price);
    if (y == null) return;
    const w = this._container.clientWidth;
    _svgLine(g, 0, y, w, y, "transparent", 12);  // wide invisible hit area
    _svgLine(g, 0, y, w, y, "#f0883e", 1, 0.9, "5,3");
    _svgText(g, w - 5, y - 3, d.price.toFixed(2), "#f0883e");
  }

  // Ghost preview while placing the second point
  _renderGhost() {
    const { x: ax, y: ay } = this._anchor;
    const { x: gx, y: gy } = this._ghost;

    if (this._tool === "trendline") {
      _svgLine(this._svg, ax, ay, gx, gy, "#58a6ff", 1.5, 0.4);
      _svgDot(this._svg, ax, ay, "#58a6ff", 0.55);

    } else if (this._tool === "fibonacci") {
      const p1 = this._series.coordinateToPrice(ay);
      const p2 = this._series.coordinateToPrice(gy);
      if (p1 == null || p2 == null) return;
      const range = p1 - p2;
      const w = this._container.clientWidth;
      FIB_LEVELS.forEach((lv, i) => {
        const y = this._py(p2 + range * (1 - lv));
        if (y != null) _svgLine(this._svg, 0, y, w, y, FIB_COLORS[i], 1, 0.3);
      });
    }
  }

  // ── Coordinate helpers ─────────────────────────────────────────────────────

  _rel(e) {
    const r = this._container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _tx(time) {
    if (time == null) return null;
    const v = this._chart.timeScale().timeToCoordinate(time);
    return (v == null || !isFinite(v)) ? null : v;
  }

  _py(price) {
    if (price == null) return null;
    const v = this._series.priceToCoordinate(price);
    return (v == null || !isFinite(v)) ? null : v;
  }
}

// ── Module-level SVG helpers ───────────────────────────────────────────────

function _svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function _svgLine(parent, x1, y1, x2, y2, color, width = 1, opacity = 1, dash = null) {
  const el = _svgEl("line", {
    x1, y1, x2, y2,
    stroke: color, "stroke-width": width, "stroke-opacity": opacity,
  });
  if (dash) el.setAttribute("stroke-dasharray", dash);
  parent.appendChild(el);
}

function _svgDot(parent, cx, cy, color, opacity = 1) {
  parent.appendChild(_svgEl("circle", {
    cx, cy, r: 3.5, fill: color, "fill-opacity": opacity,
  }));
}

function _svgText(parent, x, y, text, color) {
  const el = _svgEl("text", {
    x, y, fill: color,
    "font-size": "10",
    "font-family": '"SF Mono","Fira Code",monospace',
    "text-anchor": "end",
  });
  el.textContent = text;
  parent.appendChild(el);
}

