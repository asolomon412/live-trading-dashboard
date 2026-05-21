# MyTradingView

A local multi-pane live trading dashboard built with [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) and a Flask backend. View up to 8 charts simultaneously with real-time price updates, technical indicators, and drag-to-resize panes.

![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![Flask](https://img.shields.io/badge/flask-3.0%2B-lightgrey)

---

## Features

- **Multi-pane layout** — 1, 2, 3, 4, 6, or 8 charts at once, resizable by dragging
- **3 data sources** — Alpaca (real-time US stocks), yFinance (US stocks/ETFs), Hyperliquid (crypto perpetuals)
- **Technical indicators** — SMA 20/50/200, EMA 9/21/50, Bollinger Bands, VWAP
- **Live price ticks** with green/red flash animations
- **Persistent layout** — symbol, timeframe, indicator, and grid size choices are saved across reloads

---

## Prerequisites

- Python 3.10 or newer
- pip

---

## Installation

**1. Clone the repository**

```bash
git clone https://github.com/your-username/mytradingview.git
cd mytradingview
```

**2. Create and activate a virtual environment** *(recommended)*

```bash
python3 -m venv .venv
source .venv/bin/activate      # macOS / Linux
.venv\Scripts\activate         # Windows
```

**3. Install dependencies**

```bash
pip install -r requirements.txt
```

---

## Configuration

Alpaca and yFinance work without any setup. Alpaca real-time data requires free API keys.

**Get free Alpaca keys** at [alpaca.markets](https://alpaca.markets) — no credit card needed.

Create a `.env` file in the project root (use the template below):

```bash
cp .env.example .env
```

Then open `.env` and fill in your keys:

```
ALPACA_KEY=your_key_here
ALPACA_SECRET=your_secret_here
```

> If you skip this step, Alpaca charts will show an error. yFinance and Hyperliquid work without any keys.

---

## Running

```bash
python app.py
```

Then open [http://localhost:5001](http://localhost:5001) in your browser.

> **Note:** Port 5000 is reserved by macOS AirPlay Receiver, so the app runs on **5001**.

---

## Data Sources

| Source | Asset class | Requires keys | Notes |
|---|---|---|---|
| **Alpaca** | US stocks & ETFs | Yes (free) | Real-time trades via IEX feed |
| **yFinance** | US stocks, ETFs, indices | No | Polled ~every 5–15 s |
| **Hyperliquid** | Crypto perpetuals | No | Live WebSocket candles |

Supported timeframes vary by source — the UI automatically disables unavailable options when you switch sources.

---

## Project Structure

```
mytradingview/
├── app.py              # Flask server — HTTP routes + /ws WebSocket endpoint
├── data_source.py      # Pluggable broker interface — add new sources here
├── requirements.txt
├── .env.example        # API key template (safe to commit)
├── static/
│   ├── css/styles.css
│   └── js/
│       ├── app.js          # Dashboard logic, grid, pane controls
│       ├── charts.js       # Lightweight Charts wrapper
│       └── indicators.js   # Indicator math (SMA, EMA, BB, VWAP)
└── templates/
    └── index.html
```

---

## Adding a New Data Source

Edit only `data_source.py`. Subclass `DataSource`, implement `historical()`, `subscribe()`, and `unsubscribe()`, then register the instance in the `SOURCES` dict at the bottom of the file. No other file needs to change.
