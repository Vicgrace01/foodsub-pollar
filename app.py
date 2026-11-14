from __future__ import annotations

import os
import re
import secrets
import sqlite3
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DB_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "foodsub.db"))
POLLAR_PUBLISHABLE_KEY = os.getenv("POLLAR_PUBLISHABLE_KEY", "").strip()
POLLAR_MERCHANT_ADDRESS = os.getenv("POLLAR_MERCHANT_ADDRESS", "").strip()
POLLAR_NETWORK = os.getenv("POLLAR_NETWORK", "testnet").strip().lower()
POLLAR_HORIZON_URL = os.getenv("POLLAR_HORIZON_URL", "https://horizon-testnet.stellar.org").rstrip("/")
DEMO_XLM_PER_USD = Decimal(os.getenv("DEMO_XLM_PER_USD", "1"))

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.getenv("FLASK_SECRET_KEY") or secrets.token_urlsafe(48)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "false").lower() == "true",
    MAX_CONTENT_LENGTH=1 * 1024 * 1024,
)

CORE = ["Rice", "Beans", "Frozen beef", "Frozen chicken", "Eggs", "Spaghetti", "Spices", "Cooking oil", "Beverages", "Mini-processed vegetables"]

def box(**q):
    return [f"{v} {k.replace('_', ' ')}" for k, v in q.items()]

PACKAGES = [
    {"id":"student-male","name":"Campus Fuel (Male)","tag":"students","price":29,"badge":"Best for hostel life","hero":"High-protein, quick-cook","items":box(Rice="5kg",Beans="2kg",Frozen_chicken="2kg",Frozen_beef="1kg",Eggs="30",Spaghetti="2kg",Spices="Stew+curry mix",Cooking_oil="1L",Beverages="Malt drinks x6",Mini_veg="Tomato/pepper/onion blend x2")},
    {"id":"student-female","name":"Campus Glow (Female)","tag":"students","price":29,"badge":"Light & balanced","hero":"Lean proteins, extra veggies","items":box(Rice="4kg",Beans="2kg",Frozen_chicken="2kg",Frozen_fish_beef="500g",Eggs="30",Spaghetti="1.5kg",Spices="Stew+seasoning",Cooking_oil="1L",Beverages="Juice/yoghurt x6",Mini_veg="Veggie mix x3")},
    {"id":"clique4","name":"Squad of 4","tag":"students","price":79,"badge":"Split it 4 ways","hero":"Shared-flat favourite","items":box(Rice="15kg",Beans="6kg",Frozen_chicken="5kg",Frozen_beef="3kg",Eggs="60",Spaghetti="5kg",Spices="Full set",Cooking_oil="3L",Beverages="Mixed x16",Mini_veg="Veggie mix x6")},
    {"id":"single-ladies","name":"Solo Queen","tag":"singles","price":35,"badge":"Portion-smart","hero":"Right-sized, zero waste","items":box(Rice="3kg",Beans="1.5kg",Frozen_chicken="1.5kg",Frozen_beef="500g",Eggs="30",Spaghetti="1kg",Spices="Stew+pepper soup",Cooking_oil="1L",Beverages="Juice x4",Mini_veg="Veggie mix x3")},
    {"id":"family-small","name":"Family Table (Small)","tag":"family","price":69,"badge":"Family of 3–4","hero":"Weekly staples sorted","items":box(Rice="10kg",Beans="4kg",Frozen_chicken="4kg",Frozen_beef="2kg",Eggs="60",Spaghetti="3kg",Spices="Full set",Cooking_oil="2L",Beverages="Mixed x12",Mini_veg="Veggie mix x5")},
    {"id":"family-large","name":"Family Feast (Large)","tag":"family","price":129,"badge":"Family of 6+","hero":"Month-long bulk value","items":box(Rice="25kg",Beans="8kg",Frozen_chicken="8kg",Frozen_beef="5kg",Eggs="120",Spaghetti="6kg",Spices="Full set x2",Cooking_oil="5L",Beverages="Mixed x24",Mini_veg="Veggie mix x10")},
    {"id":"gift","name":"The Gift Hamper","tag":"gift","price":59,"badge":"Gift-wrapped","hero":"Premium picks + card","items":box(Rice="5kg premium",Beans="2kg",Frozen_chicken="2kg",Frozen_beef="1kg",Eggs="30",Spaghetti="2kg",Spices="Gourmet set",Cooking_oil="1L",Beverages="Juice+wine-free bubbly x6",Mini_veg="Veggie mix x3")},
]
CUSTOM_ITEMS = [("Rice (kg)",2),("Beans (kg)",2),("Frozen beef (kg)",7),("Frozen chicken (kg)",5),("Eggs (tray of 30)",5),("Spaghetti (kg)",2),("Spices (pack)",2),("Cooking oil (L)",3),("Beverages (pack of 6)",4),("Mini-processed veg (pack)",3)]
CUSTOM_PRICE = dict(CUSTOM_ITEMS)


def get_db() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            pw TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            package TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created TEXT DEFAULT CURRENT_TIMESTAMP,
            provider TEXT DEFAULT 'pollar',
            tx_hash TEXT UNIQUE,
            payer_address TEXT,
            payment_memo TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )""")
        existing = {row[1] for row in conn.execute("PRAGMA table_info(orders)").fetchall()}
        for name, sql_type in (("provider", "TEXT DEFAULT 'pollar'"), ("tx_hash", "TEXT"), ("payer_address", "TEXT"), ("payment_memo", "TEXT")):
            if name not in existing:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {name} {sql_type}")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tx_hash_unique ON orders(tx_hash) WHERE tx_hash IS NOT NULL")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_memo_unique ON orders(payment_memo) WHERE payment_memo IS NOT NULL")


init_db()


def current_user():
    user_id = session.get("uid")
    if not user_id:
        return None
    with get_db() as conn:
        return conn.execute("SELECT id, name, email FROM users WHERE id = ?", (user_id,)).fetchone()


def json_body() -> dict[str, Any]:
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else {}


def safe_xlm_amount(usd_amount: int) -> str:
    amount = (Decimal(usd_amount) * DEMO_XLM_PER_USD).quantize(Decimal("0.0000001"))
    return format(amount, "f")


def valid_stellar_g_address(value: str) -> bool:
    return bool(re.fullmatch(r"G[A-Z2-7]{55}", value or ""))


@app.get("/health")
def health():
    return jsonify(ok=True, network=POLLAR_NETWORK)


@app.get("/")
def home():
    bundle = (BASE_DIR / "static" / "pollar" / "pollar-widget.js").exists()
    return render_template(
        "index.html",
        pollar_bundle_exists=bundle,
        foodsub_config={
            "pollarPublishableKey": POLLAR_PUBLISHABLE_KEY,
            "pollarMerchantAddress": POLLAR_MERCHANT_ADDRESS,
            "pollarNetwork": POLLAR_NETWORK,
            "demoXlmPerUsd": str(DEMO_XLM_PER_USD),
        },
    )


@app.get("/api/packages")
def packages():
    return jsonify(packages=PACKAGES, custom=CUSTOM_ITEMS, core=CORE)


@app.post("/api/register")
def register():
    data = json_body()
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if not name or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(password) < 6:
        return jsonify(error="Enter a name, valid email and password with at least 6 characters"), 400
    try:
        with get_db() as conn:
            cur = conn.execute("INSERT INTO users(name,email,pw) VALUES(?,?,?)", (name, email, generate_password_hash(password)))
            session.clear()
            session["uid"] = cur.lastrowid
    except sqlite3.IntegrityError:
        return jsonify(error="Email already registered"), 409
    return jsonify(ok=True, name=name)


@app.post("/api/login")
def login():
    data = json_body()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    with get_db() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not user or not check_password_hash(user["pw"], password):
        return jsonify(error="Incorrect email or password"), 401
    session.clear()
    session["uid"] = user["id"]
    return jsonify(ok=True, name=user["name"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def whoami():
    user = current_user()
    return jsonify(user=dict(user) if user else None)


@app.get("/api/orders")
def orders():
    user = current_user()
    if not user:
        return jsonify(error="Login required"), 401
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, package, amount, status, created, provider, tx_hash FROM orders WHERE user_id = ? ORDER BY id DESC",
            (user["id"],),
        ).fetchall()
    return jsonify(orders=[dict(row) for row in rows])


@app.post("/api/checkout")
def checkout():
    user = current_user()
    if not user:
        return jsonify(error="Please create an account or log in before checkout"), 401
    data = json_body()
    if POLLAR_NETWORK != "testnet" or not POLLAR_PUBLISHABLE_KEY.startswith("pub_testnet_"):
        return jsonify(error="FoodSub is not configured with a Pollar testnet publishable key"), 503
    if not valid_stellar_g_address(POLLAR_MERCHANT_ADDRESS):
        return jsonify(error="Set POLLAR_MERCHANT_ADDRESS to a valid Stellar testnet G-address before checkout"), 503

    package_id = data.get("package")
    if package_id == "custom":
        cart = data.get("cart") or {}
        if not isinstance(cart, dict):
            return jsonify(error="Invalid custom package"), 400
        total = 0
        for item_name, quantity in cart.items():
            if item_name not in CUSTOM_PRICE:
                return jsonify(error=f"Unknown custom item: {item_name}"), 400
            try:
                qty = int(quantity)
            except (ValueError, TypeError):
                return jsonify(error="Custom item quantities must be whole numbers"), 400
            if qty < 0 or qty > 100:
                return jsonify(error="Custom item quantities must be between 0 and 100"), 400
            total += CUSTOM_PRICE[item_name] * qty
        if total <= 0:
            return jsonify(error="Add at least one item to your custom package"), 400
        name = "Custom package"
    else:
        package = next((item for item in PACKAGES if item["id"] == package_id), None)
        if not package:
            return jsonify(error="Unknown package"), 404
        total, name = int(package["price"]), package["name"]

    if DEMO_XLM_PER_USD <= 0:
        return jsonify(error="Invalid demo XLM conversion rate in server configuration"), 500
    payment_memo = "FS" + secrets.token_hex(11)
    with get_db() as conn:
        order_id = conn.execute(
            "INSERT INTO orders(user_id,package,amount,status,provider,payment_memo) VALUES(?,?,?,?,?,?)",
            (user["id"], name, total, "pending", "pollar", payment_memo),
        ).lastrowid
    return jsonify(
        order_id=order_id,
        package=name,
        amount_usd=total,
        amount_xlm=safe_xlm_amount(total),
        payment_memo=payment_memo,
        currency="XLM",
        status="pending",
        network=POLLAR_NETWORK,
        merchant_configured=bool(POLLAR_MERCHANT_ADDRESS),
    )


def fetch_horizon_payment(tx_hash: str, expected: dict[str, str]) -> tuple[bool | None, str]:
    if not re.fullmatch(r"[a-fA-F0-9]{64}", tx_hash):
        return False, "Invalid Stellar transaction hash"
    try:
        tx_response = requests.get(f"{POLLAR_HORIZON_URL}/transactions/{tx_hash}", timeout=12)
        if tx_response.status_code == 404:
            return None, "Transaction is not indexed on Stellar testnet yet"
        tx_response.raise_for_status()
        tx_data = tx_response.json()
        if not tx_data.get("successful", False):
            return False, "Stellar reports that this transaction was not successful"
        if tx_data.get("memo_type") != "text" or tx_data.get("memo") != expected["memo"]:
            return False, "Transaction memo does not match this FoodSub order"
        op_response = requests.get(f"{POLLAR_HORIZON_URL}/transactions/{tx_hash}/operations", params={"limit": 200, "order": "asc"}, timeout=12)
        op_response.raise_for_status()
        operations = op_response.json().get("_embedded", {}).get("records", [])
    except requests.RequestException:
        return None, "Unable to confirm the transaction with Stellar Horizon right now"
    for operation in operations:
        if operation.get("type") != "payment" or operation.get("asset_type") != "native":
            continue
        if operation.get("from") != expected["payer"]:
            continue
        if operation.get("to") != expected["merchant"]:
            continue
        try:
            exact_amount = Decimal(str(operation.get("amount"))) == Decimal(expected["amount"])
        except InvalidOperation:
            exact_amount = False
        if exact_amount:
            return True, "Verified native-XLM payment on Stellar testnet"
    return False, "Transaction does not contain the expected payer, receiver and XLM amount"


@app.post("/api/pollar/confirm")
def confirm_pollar_payment():
    user = current_user()
    if not user:
        return jsonify(error="Login required"), 401
    if POLLAR_NETWORK != "testnet":
        return jsonify(error="This build only verifies Stellar testnet payments"), 400
    if not valid_stellar_g_address(POLLAR_MERCHANT_ADDRESS):
        return jsonify(error="FoodSub receiving wallet is not configured with a valid Stellar G-address"), 503
    data = json_body()
    try:
        order_id = int(data.get("order_id"))
    except (ValueError, TypeError):
        return jsonify(error="Invalid order ID"), 400
    tx_hash = str(data.get("tx_hash", "")).strip()
    payer = str(data.get("payer_address", "")).strip()
    if not valid_stellar_g_address(payer):
        return jsonify(error="This checkout currently supports classic Stellar G-address wallets. Use Pollar email/social login or a compatible external Stellar wallet, not a passkey C-address."), 400

    with get_db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ? AND user_id = ?", (order_id, user["id"])).fetchone()
        if not order:
            return jsonify(error="Order not found"), 404
        if order["status"] == "paid" and order["tx_hash"] == tx_hash:
            return jsonify(ok=True, paid=True, message="This order has already been paid"), 200
        if order["status"] != "pending":
            return jsonify(error=f"Order cannot be paid because its status is {order['status']}"), 409
        expected = {
            "payer": payer,
            "merchant": POLLAR_MERCHANT_ADDRESS,
            "amount": safe_xlm_amount(order["amount"]),
            "memo": order["payment_memo"],
        }
        verified, message = fetch_horizon_payment(tx_hash, expected)
        if verified is None:
            return jsonify(ok=False, pending=True, message=message), 202
        if not verified:
            return jsonify(error=message), 400
        try:
            updated = conn.execute(
                "UPDATE orders SET status='paid', provider='pollar', tx_hash=?, payer_address=? WHERE id=? AND user_id=? AND status='pending'",
                (tx_hash, payer, order_id, user["id"]),
            )
            if updated.rowcount != 1:
                return jsonify(error="Order status changed while payment was being verified. Refresh your orders before retrying."), 409
        except sqlite3.IntegrityError:
            return jsonify(error="This transaction hash has already been used for another order"), 409
    return jsonify(ok=True, paid=True, message=message, tx_hash=tx_hash)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")