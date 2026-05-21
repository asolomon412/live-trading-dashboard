# Author: Antonella Solomon
"""
Pluggable data-source interface.

To add a new broker (Alpaca, Binance, Charles Schwab, etc.):
  1. Create a class that inherits DataSource and implements the three methods.
  2. Add it to the SOURCES dict at the bottom.
  3. No other file needs to change.
"""

import os
import threading
import time
import json
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Callable, Optional

import requests
import yfinance as yf
import pandas as pd
import websockets
import asyncio


class DataSource(ABC):
    @abstractmethod
    def historical(self, symbol: str, tf: str, limit: int = 200) -> list[dict]:
        """Return up to `limit` closed OHLCV bars as list of {time, open, high, low, close, volume}."""

    @abstractmethod
    def subscribe(self, symbol: str, tf: str, callback: Callable[[dict], None]) -> str:
        """Start streaming ticks. Returns a subscription key."""

    @abstractmethod
    def unsubscribe(self, key: str) -> None:
        """Stop the stream identified by `key`."""


# ---------------------------------------------------------------------------
# yFinance source  (US stocks, ETFs, indices)
# ---------------------------------------------------------------------------

_TF_MAP = {
    "1m": ("1m",  "1d"),
    "2m": ("2m",  "5d"),
    "5m": ("5m",  "5d"),
    "15m": ("15m", "5d"),
    "30m": ("30m", "5d"),
    "1h": ("1h",  "30d"),
    "4h": ("60m", "60d"),
    "1d": ("1d",  "1y"),
    "1w": ("1wk", "5y"),
}

def _yf_interval_period(tf: str):
    return _TF_MAP.get(tf, ("1d", "1y"))


def _bar_to_dict(row, ts_col="Datetime") -> dict:
    ts = row.name
    if hasattr(ts, "timestamp"):
        t = int(ts.timestamp())
    else:
        t = int(pd.Timestamp(ts).timestamp())
    return {
        "time": t,
        "open": round(float(row["Open"]), 6),
        "high": round(float(row["High"]), 6),
        "low": round(float(row["Low"]), 6),
        "close": round(float(row["Close"]), 6),
        "volume": int(row["Volume"]) if "Volume" in row else 0,
    }


class YFinanceSource(DataSource):
    def __init__(self):
        self._subs: dict[str, threading.Event] = {}

    def historical(self, symbol: str, tf: str, limit: int = 200) -> list[dict]:
        interval, period = _yf_interval_period(tf)
        try:
            df = yf.download(symbol, period=period, interval=interval,
                             progress=False, auto_adjust=True)
            if df.empty:
                return []
            # Flatten multi-index columns if present
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            bars = [_bar_to_dict(row) for _, row in df.tail(limit).iterrows()]
            return bars
        except Exception as e:
            print(f"[yfinance] historical error for {symbol}: {e}")
            return []

    def subscribe(self, symbol: str, tf: str, callback: Callable[[dict], None]) -> str:
        key = f"yf:{symbol}:{tf}:{id(callback)}"
        stop = threading.Event()
        self._subs[key] = stop

        interval, _ = _yf_interval_period(tf)
        poll_seconds = self._poll_interval(tf)

        def _poll():
            last_price = None
            while not stop.is_set():
                try:
                    ticker = yf.Ticker(symbol)
                    info = ticker.fast_info
                    price = getattr(info, "last_price", None)
                    if price is None:
                        # fallback: fetch latest 1m bar
                        df = yf.download(symbol, period="1d", interval="1m",
                                         progress=False, auto_adjust=True)
                        if not df.empty:
                            if isinstance(df.columns, pd.MultiIndex):
                                df.columns = df.columns.get_level_values(0)
                            price = float(df["Close"].iloc[-1])
                    if price is not None and price != last_price:
                        last_price = price
                        callback({
                            "type": "tick",
                            "symbol": symbol,
                            "price": round(float(price), 6),
                            "time": int(time.time()),
                        })
                except Exception as e:
                    print(f"[yfinance] poll error for {symbol}: {e}")
                stop.wait(poll_seconds)

        t = threading.Thread(target=_poll, daemon=True)
        t.start()
        return key

    def unsubscribe(self, key: str) -> None:
        if key in self._subs:
            self._subs[key].set()
            del self._subs[key]

    @staticmethod
    def _poll_interval(tf: str) -> int:
        if tf in ("1m", "5m"):
            return 5
        if tf in ("15m", "30m", "1h"):
            return 15
        return 60


# ---------------------------------------------------------------------------
# Hyperliquid source  (crypto perpetuals)
# ---------------------------------------------------------------------------

_HL_WS = "wss://api.hyperliquid.xyz/ws"

_HL_TF_MAP = {
    "1m":  "1m",
    # 2m is not supported by Hyperliquid (jumps 1m → 3m); omitted intentionally
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "4h":  "4h",
    "1d":  "1d",
}

_HL_REST = "https://api.hyperliquid.xyz/info"


def _hl_tf(tf: str) -> str:
    result = _HL_TF_MAP.get(tf)
    if result is None:
        supported = list(_HL_TF_MAP.keys())
        raise ValueError(f"Hyperliquid does not support the '{tf}' timeframe. Supported: {supported}")
    return result


def _hl_historical(symbol: str, tf: str, limit: int = 200) -> list[dict]:
    interval = _hl_tf(tf)
    end_ms = int(time.time() * 1000)

    interval_ms = {
        "1m": 60_000, "2m": 120_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
        "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
    }.get(interval, 3_600_000)

    start_ms = end_ms - limit * interval_ms

    payload = {
        "type": "candleSnapshot",
        "req": {
            "coin": symbol,
            "interval": interval,
            "startTime": start_ms,
            "endTime": end_ms,
        }
    }
    try:
        r = requests.post(_HL_REST, json=payload, timeout=10)
        data = r.json()
        bars = []
        for c in data:
            bars.append({
                "time": int(c["t"]) // 1000,
                "open": float(c["o"]),
                "high": float(c["h"]),
                "low":  float(c["l"]),
                "close": float(c["c"]),
                "volume": float(c["v"]),
            })
        return bars[-limit:]
    except Exception as e:
        print(f"[hyperliquid] historical error for {symbol}: {e}")
        return []


class HyperliquidSource(DataSource):
    def __init__(self):
        self._subs: dict[str, threading.Event] = {}

    def historical(self, symbol: str, tf: str, limit: int = 200) -> list[dict]:
        return _hl_historical(symbol, tf, limit)

    def subscribe(self, symbol: str, tf: str, callback: Callable[[dict], None]) -> str:
        key = f"hl:{symbol}:{tf}:{id(callback)}"
        stop = threading.Event()
        self._subs[key] = stop

        def _run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(self._stream(symbol, tf, callback, stop))
            loop.close()

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        return key

    async def _stream(self, symbol: str, tf: str, callback, stop: threading.Event):
        interval = _hl_tf(tf)
        sub_msg = json.dumps({
            "method": "subscribe",
            "subscription": {"type": "candle", "coin": symbol, "interval": interval}
        })
        while not stop.is_set():
            try:
                async with websockets.connect(_HL_WS, ping_interval=20) as ws:
                    await ws.send(sub_msg)
                    while not stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=30)
                            msg = json.loads(raw)
                            if msg.get("channel") == "error":
                                err = msg.get("data", "unknown error")
                                print(f"[hyperliquid] subscription error for {symbol}: {err}")
                                callback({"type": "error", "message": f"Hyperliquid: {err}"})
                                return  # invalid subscription — don't reconnect
                            if msg.get("channel") == "candle":
                                c = msg["data"]
                                callback({
                                    "type": "bar",
                                    "symbol": symbol,
                                    "time":   int(c["t"]) // 1000,
                                    "open":   float(c["o"]),
                                    "high":   float(c["h"]),
                                    "low":    float(c["l"]),
                                    "close":  float(c["c"]),
                                    "volume": float(c["v"]),
                                })
                                callback({
                                    "type":   "tick",
                                    "symbol": symbol,
                                    "price":  float(c["c"]),
                                    "time":   int(time.time()),
                                })
                        except asyncio.TimeoutError:
                            continue
            except Exception as e:
                print(f"[hyperliquid] ws error for {symbol}: {e}")
                if not stop.is_set():
                    await asyncio.sleep(3)

    def unsubscribe(self, key: str) -> None:
        if key in self._subs:
            self._subs[key].set()
            del self._subs[key]


# ---------------------------------------------------------------------------
# Alpaca source  (real-time US stocks via IEX feed — free tier)
#
# Requires env vars:  ALPACA_KEY   and  ALPACA_SECRET
# Get free keys at:   https://alpaca.markets  (no credit card needed)
# ---------------------------------------------------------------------------

_ALPACA_KEY    = os.environ.get("ALPACA_KEY", "")
_ALPACA_SECRET = os.environ.get("ALPACA_SECRET", "")
_ALPACA_WS     = "wss://stream.data.alpaca.markets/v2/iex"
_ALPACA_REST   = "https://data.alpaca.markets/v2/stocks"

_ALPACA_TF_MAP = {
    "1m": "1Min",  "2m": "2Min",  "5m": "5Min",
    "15m": "15Min", "30m": "30Min",
    "1h": "1Hour", "4h": "4Hour",
    "1d": "1Day",  "1w": "1Week",
}

_ALPACA_TF_SECONDS = {
    "1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1_800,
    "1h": 3_600, "4h": 14_400, "1d": 86_400, "1w": 604_800,
}


class AlpacaSource(DataSource):
    def __init__(self):
        self._subs: dict[str, threading.Event] = {}

    def _check_keys(self):
        if not _ALPACA_KEY or not _ALPACA_SECRET:
            raise ValueError(
                "Alpaca keys not set. Export ALPACA_KEY and ALPACA_SECRET, "
                "then restart the server. Free keys: https://alpaca.markets"
            )

    def historical(self, symbol: str, tf: str, limit: int = 200) -> list[dict]:
        self._check_keys()
        timeframe = _ALPACA_TF_MAP.get(tf, "1Hour")
        seconds   = _ALPACA_TF_SECONDS.get(tf, 3_600)
        end   = datetime.utcnow()
        start = end - timedelta(seconds=seconds * (limit + 10))  # small buffer
        params = {
            "timeframe": timeframe,
            "start":     start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end":       end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "feed":      "iex",
            "limit":     limit,
            "sort":      "asc",
        }
        headers = {
            "APCA-API-KEY-ID":     _ALPACA_KEY,
            "APCA-API-SECRET-KEY": _ALPACA_SECRET,
        }
        try:
            r = requests.get(f"{_ALPACA_REST}/{symbol}/bars",
                             params=params, headers=headers, timeout=10)
            r.raise_for_status()
            bars = []
            for b in r.json().get("bars", []):
                ts = pd.Timestamp(b["t"]).timestamp()
                bars.append({
                    "time":   int(ts),
                    "open":   float(b["o"]),
                    "high":   float(b["h"]),
                    "low":    float(b["l"]),
                    "close":  float(b["c"]),
                    "volume": int(b["v"]),
                })
            return bars[-limit:]
        except Exception as e:
            print(f"[alpaca] historical error for {symbol}: {e}")
            return []

    def subscribe(self, symbol: str, tf: str, callback: Callable[[dict], None]) -> str:
        self._check_keys()
        key  = f"alpaca:{symbol}:{tf}:{id(callback)}"
        stop = threading.Event()
        self._subs[key] = stop

        def _run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(self._stream(symbol, callback, stop))
            loop.close()

        threading.Thread(target=_run, daemon=True).start()
        return key

    async def _stream(self, symbol: str, callback, stop: threading.Event):
        while not stop.is_set():
            try:
                async with websockets.connect(_ALPACA_WS, ping_interval=20) as ws:
                    # Authenticate
                    await ws.send(json.dumps({
                        "action": "auth",
                        "key":    _ALPACA_KEY,
                        "secret": _ALPACA_SECRET,
                    }))
                    # Subscribe to per-minute bars + individual trades for real-time ticks
                    await ws.send(json.dumps({
                        "action": "subscribe",
                        "bars":   [symbol],
                        "trades": [symbol],
                    }))
                    while not stop.is_set():
                        try:
                            raw  = await asyncio.wait_for(ws.recv(), timeout=30)
                            msgs = json.loads(raw)
                            if not isinstance(msgs, list):
                                msgs = [msgs]
                            for msg in msgs:
                                t = msg.get("T")
                                if t == "t":  # trade → real-time tick
                                    callback({
                                        "type":   "tick",
                                        "symbol": symbol,
                                        "price":  float(msg["p"]),
                                        "time":   int(time.time()),
                                    })
                                elif t == "b":  # bar close
                                    ts = int(pd.Timestamp(msg["t"]).timestamp())
                                    callback({
                                        "type":   "bar",
                                        "symbol": symbol,
                                        "time":   ts,
                                        "open":   float(msg["o"]),
                                        "high":   float(msg["h"]),
                                        "low":    float(msg["l"]),
                                        "close":  float(msg["c"]),
                                        "volume": int(msg["v"]),
                                    })
                        except asyncio.TimeoutError:
                            continue
            except Exception as e:
                print(f"[alpaca] ws error for {symbol}: {e}")
                if not stop.is_set():
                    await asyncio.sleep(3)

    def unsubscribe(self, key: str) -> None:
        if key in self._subs:
            self._subs[key].set()
            del self._subs[key]


# ---------------------------------------------------------------------------
# Registry  — add new brokers here
# ---------------------------------------------------------------------------

SOURCES: dict[str, DataSource] = {
    "yfinance":    YFinanceSource(),
    "hyperliquid": HyperliquidSource(),
    "alpaca":      AlpacaSource(),
    # "binance":   BinanceSource(),
    # "schwab":    SchwabSource(),
}


def get_source(name: str) -> DataSource:
    src = SOURCES.get(name)
    if src is None:
        raise ValueError(f"Unknown data source '{name}'. Available: {list(SOURCES)}")
    return src
