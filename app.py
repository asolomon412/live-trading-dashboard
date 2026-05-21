# Author: Antonella Solomon
"""
Flask backend — serves the dashboard and bridges data sources to the browser
over a single WebSocket connection per tab.
"""

import json
import threading
import time
from dotenv import load_dotenv
load_dotenv()  # loads .env before data_source reads os.environ

from flask import Flask, render_template, jsonify, request
from flask_sock import Sock
from flask_cors import CORS

from data_source import get_source, SOURCES

app = Flask(__name__)
app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 25}
sock = Sock(app)
CORS(app)

# active subscriptions per websocket connection
# { ws_id -> { sub_key: (source_name, unsub_fn) } }
_connections: dict[int, dict] = {}
_conn_lock = threading.Lock()


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/sources")
def list_sources():
    return jsonify(list(SOURCES.keys()))


@app.route("/api/history")
def history():
    symbol = request.args.get("symbol", "AAPL").upper()
    tf     = request.args.get("tf", "1h")
    source = request.args.get("source", "yfinance")
    limit  = int(request.args.get("limit", 200))
    try:
        bars = get_source(source).historical(symbol, tf, limit)
        return jsonify(bars)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@sock.route("/ws")
def ws_handler(ws):
    ws_id = id(ws)
    with _conn_lock:
        _connections[ws_id] = {}

    def send_safe(payload: dict):
        try:
            ws.send(json.dumps(payload))
        except Exception:
            pass  # connection already closed

    try:
        while True:
            raw = ws.receive(timeout=60)
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            action = msg.get("action")

            if action == "subscribe":
                pane_id    = msg.get("pane_id")
                symbol     = msg.get("symbol", "BTC").upper()
                tf         = msg.get("tf", "1h")
                source_name = msg.get("source", "hyperliquid")
                sub_key    = f"{pane_id}:{symbol}:{tf}:{source_name}"

                # Unsubscribe any previous sub for this pane
                with _conn_lock:
                    prev = _connections[ws_id].get(pane_id)
                if prev:
                    try:
                        get_source(prev["source"]).unsubscribe(prev["key"])
                    except Exception:
                        pass

                def make_cb(sk=sub_key, pid=pane_id, sym=symbol):
                    def cb(data: dict):
                        data["pane_id"] = pid
                        data["symbol"]  = sym
                        send_safe(data)
                    return cb

                try:
                    src = get_source(source_name)
                    key = src.subscribe(symbol, tf, make_cb())
                    with _conn_lock:
                        _connections[ws_id][pane_id] = {
                            "key": key,
                            "source": source_name,
                        }
                    send_safe({"type": "subscribed", "pane_id": pane_id,
                               "symbol": symbol, "tf": tf, "source": source_name})
                except Exception as e:
                    send_safe({"type": "error", "pane_id": pane_id, "message": str(e)})

            elif action == "unsubscribe":
                pane_id = msg.get("pane_id")
                with _conn_lock:
                    sub = _connections[ws_id].pop(pane_id, None)
                if sub:
                    try:
                        get_source(sub["source"]).unsubscribe(sub["key"])
                    except Exception:
                        pass

            elif action == "ping":
                send_safe({"type": "pong"})

    except Exception:
        pass
    finally:
        # Clean up all subscriptions for this connection
        with _conn_lock:
            subs = _connections.pop(ws_id, {})
        for sub in subs.values():
            try:
                get_source(sub["source"]).unsubscribe(sub["key"])
            except Exception:
                pass


if __name__ == "__main__":
    app.run(debug=True, port=5001, threaded=True, use_reloader=False)
