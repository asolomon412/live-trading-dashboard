/**
 * Author: Antonella Solomon
 * charts.js — Lightweight Charts wrapper
 *
 * PaneChart manages one LWC instance per pane plus any indicator overlay series.
 * Indicator math lives in indicators.js; this file only handles series lifecycle.
 */

class PaneChart {
  constructor(container) {
    this._container  = container;
    this._series     = null;
    this._lastBar    = null;
    this._firstPrice = null;
    this._bars       = [];
    this._indicatorSeries = new Map(); // key → { type:'line'|'band', series|upper/middle/lower }

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);

    this._chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: "#161b22" },
        textColor:  "#8b949e",
      },
      grid: {
        vertLines: { color: "#21262d" },
        horzLines: { color: "#21262d" },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#30363d" },
      timeScale: {
        borderColor:    "#30363d",
        timeVisible:    true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale:  true,
    });

    this._series = this._chart.addCandlestickSeries({
      upColor:         "#3fb950",
      downColor:       "#f85149",
      borderUpColor:   "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor:     "#3fb950",
      wickDownColor:   "#f85149",
    });
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  setData(bars) {
    if (!bars || bars.length === 0) return;
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    this._series.setData(sorted);
    this._lastBar    = sorted[sorted.length - 1];
    this._firstPrice = sorted[0].close;
    this._bars       = sorted;
    this._chart.timeScale().fitContent();
    this._refreshAllIndicators(false);
  }

  // Live update from WebSocket — uses series.update() for efficiency
  update(data) {
    if (!this._series) return;

    if (data.type === "bar") {
      const bar = {
        time:   data.time,
        open:   data.open,
        high:   data.high,
        low:    data.low,
        close:  data.close,
        volume: data.volume || 0,
      };
      this._series.update(bar);
      this._lastBar = bar;
      // Append or replace last bar in _bars
      const last = this._bars[this._bars.length - 1];
      if (last && last.time === bar.time) {
        this._bars[this._bars.length - 1] = bar;
      } else {
        this._bars.push(bar);
      }
    } else if (data.type === "tick" && this._lastBar) {
      const price = data.price;
      const updated = {
        time:   this._lastBar.time,
        open:   this._lastBar.open,
        high:   Math.max(this._lastBar.high, price),
        low:    Math.min(this._lastBar.low,  price),
        close:  price,
        volume: this._lastBar.volume || 0,
      };
      this._series.update(updated);
      this._lastBar = updated;
      if (this._bars.length > 0) {
        this._bars[this._bars.length - 1] = updated;
      }
    }

    // Only update the last indicator point — avoids re-rendering full arrays on every tick
    this._refreshAllIndicators(true);
    return this._lastBar ? this._lastBar.close : null;
  }

  getChange() {
    if (!this._lastBar || this._firstPrice == null) return null;
    const diff = this._lastBar.close - this._firstPrice;
    return { price: this._lastBar.close, pct: (diff / this._firstPrice) * 100 };
  }

  // ── Indicator management ───────────────────────────────────────────────────

  addIndicator(key) {
    if (this._indicatorSeries.has(key)) {
      // Already exists — just recalculate with current bars
      this._refreshIndicator(key, false);
      return;
    }
    const def = INDICATORS[key];
    if (!def) return;

    const baseOpts = {
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    };

    let inst;
    if (def.type === "band") {
      inst = {
        type:   "band",
        upper:  this._chart.addLineSeries({ ...baseOpts, color: def.color, lineWidth: 1, lineStyle: 0 }),
        middle: this._chart.addLineSeries({ ...baseOpts, color: def.color, lineWidth: 1, lineStyle: 2 }),
        lower:  this._chart.addLineSeries({ ...baseOpts, color: def.color, lineWidth: 1, lineStyle: 0 }),
      };
    } else {
      inst = {
        type:   "line",
        series: this._chart.addLineSeries({ ...baseOpts, color: def.color, lineWidth: 1.5, lineStyle: 0 }),
      };
    }

    this._indicatorSeries.set(key, inst);
    if (this._bars.length > 0) this._refreshIndicator(key, false);
  }

  removeIndicator(key) {
    const inst = this._indicatorSeries.get(key);
    if (!inst) return;
    if (inst.type === "band") {
      this._chart.removeSeries(inst.upper);
      this._chart.removeSeries(inst.middle);
      this._chart.removeSeries(inst.lower);
    } else {
      this._chart.removeSeries(inst.series);
    }
    this._indicatorSeries.delete(key);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _refreshAllIndicators(onlyLast) {
    for (const key of this._indicatorSeries.keys()) {
      this._refreshIndicator(key, onlyLast);
    }
  }

  // onlyLast=true → series.update(lastPoint) only; false → series.setData(all)
  _refreshIndicator(key, onlyLast) {
    const def  = INDICATORS[key];
    const inst = this._indicatorSeries.get(key);
    if (!def || !inst || this._bars.length === 0) return;

    const result = def.calc(this._bars);

    if (inst.type === "band") {
      if (onlyLast) {
        if (result.upper.length)  inst.upper.update(result.upper[result.upper.length - 1]);
        if (result.middle.length) inst.middle.update(result.middle[result.middle.length - 1]);
        if (result.lower.length)  inst.lower.update(result.lower[result.lower.length - 1]);
      } else {
        inst.upper.setData(result.upper);
        inst.middle.setData(result.middle);
        inst.lower.setData(result.lower);
      }
    } else {
      if (onlyLast) {
        if (result.length) inst.series.update(result[result.length - 1]);
      } else {
        inst.series.setData(result);
      }
    }
  }

  resize() {
    if (!this._chart) return;
    const { width, height } = this._container.getBoundingClientRect();
    if (width > 0 && height > 0) this._chart.resize(width, height);
  }

  _resize() { this.resize(); }

  destroy() {
    this._ro.disconnect();
    if (this._chart) {
      this._chart.remove();
      this._chart = null;
    }
  }
}
