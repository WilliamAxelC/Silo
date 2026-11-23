"""Silo ticket relay.

Public:   POST /tickets             bug reports / feature requests from the Silo app
Internal: GET  /internal/tickets    (Bearer RELAY_ADMIN_TOKEN) for the dispatcher
          GET  /internal/tickets/{n}
          POST /internal/tickets/{n}/events   append to the ticket log, optionally change status
          POST /internal/tickets/{n}/post     post a follow-up message (with optional buttons) to #silo

Each new ticket is posted to Discord #silo through the Cuangbot gateway with Fix / Reject buttons and a
reply box (reply = "fix with these instructions"). The app holds no secrets; abuse is limited by
validation and per-client rate limits. Screenshots go to Discord as a reply attachment, never to a
public URL.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import closing

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

DB_PATH = os.environ.get("TICKETS_DB", "/data/tickets.db")
CUANGBOT_URL = os.environ.get("CUANGBOT_API_URL", "http://cuangbot:8989").rstrip("/")
CUANGBOT_TOKEN = os.environ.get("WORKER_PING_API_TOKEN", "")
DISCORD_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
CHANNEL_ID = os.environ.get("SILO_CHANNEL_ID", "")
USER_ID = os.environ.get("DISCORD_USER_ID", "")
ADMIN_TOKEN = os.environ.get("RELAY_ADMIN_TOKEN", "")
IP_SALT = os.environ.get("IP_HASH_SALT", "silo")

MAX_BODY = 4 * 1024 * 1024
MAX_SCREENSHOT = 2 * 1024 * 1024
PER_CLIENT_HOUR = int(os.environ.get("PER_CLIENT_HOUR", "5"))
PER_CLIENT_DAY = int(os.environ.get("PER_CLIENT_DAY", "20"))
GLOBAL_DAY = int(os.environ.get("GLOBAL_DAY", "200"))

STATUSES = {
    "awaiting_decision", "rejected", "queued", "in_progress", "merged_to_test",
    "needs_attention", "released", "closed",
}

app = FastAPI(title="Silo tickets", docs_url=None, redoc_url=None, openapi_url=None)
_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with closing(db()) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tickets (
              n INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at INTEGER NOT NULL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              app_version TEXT, version_code INTEGER, device TEXT, os_version TEXT,
              error_log TEXT, has_screenshot INTEGER NOT NULL DEFAULT 0,
              client_hash TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'awaiting_decision',
              ping_id TEXT, message_id TEXT,
              decision TEXT, instructions TEXT, branch TEXT, result TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              n INTEGER NOT NULL REFERENCES tickets(n),
              at INTEGER NOT NULL,
              kind TEXT NOT NULL,
              text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
              n INTEGER NOT NULL,
              message_id TEXT NOT NULL,
              PRIMARY KEY (n, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tickets_client ON tickets(client_hash, created_at);
            CREATE INDEX IF NOT EXISTS idx_events_n ON events(n);
            """
        )


init_db()


def now() -> int:
    return int(time.time())


def remember_message(n: int, message_id: str | None) -> None:
    """Every Discord message posted for a ticket, so deleting the ticket deletes them too."""
    if not message_id:
        return
    with closing(db()) as conn, conn:
        conn.execute("INSERT OR IGNORE INTO messages (n, message_id) VALUES (?, ?)", (n, str(message_id)))


def add_event(conn: sqlite3.Connection, n: int, kind: str, text: str) -> None:
    conn.execute("INSERT INTO events (n, at, kind, text) VALUES (?, ?, ?, ?)", (n, now(), kind, text[:8000]))
    conn.execute("UPDATE tickets SET updated_at = ? WHERE n = ?", (now(), n))


def client_hash(request: Request) -> str:
    ip = (
        request.headers.get("cf-connecting-ip")
        or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        or (request.client.host if request.client else "")
    )
    return hashlib.sha256(f"{IP_SALT}:{ip}".encode()).hexdigest()[:24]


def http_json(method: str, url: str, headers: dict, payload: dict | None = None, timeout: int = 15) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        **headers, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://cuang.dev, 1.0)",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else {}


def post_to_silo(task: str, summary: str, options: list[str], allow_reply: bool, status: str = "info") -> dict:
    """Posts through the Cuangbot gateway so button clicks / replies can be awaited by the dispatcher."""
    if not (CUANGBOT_TOKEN and CHANNEL_ID):
        raise RuntimeError("relay not configured")
    return http_json("POST", f"{CUANGBOT_URL}/api/worker-ping/send", {"Authorization": f"Bearer {CUANGBOT_TOKEN}"}, {
        "channelId": CHANNEL_ID,
        "userId": USER_ID,
        "noMention": False,
        "status": status,
        "task": task[:200],
        "summary": summary[:3900],
        "agent": "silo-tickets",
        "repo": "Silo",
        "host": "silo-tickets",
        "options": options,
        "allowReply": allow_reply,
        "multi": False,
        "waiting": bool(options or allow_reply),
    })


def attach_screenshot(message_id: str, image: bytes, ext: str, n: int) -> str:
    """Uploads the screenshot as a Discord reply to the ticket message (bot token stays on the server)."""
    if not (DISCORD_BOT_TOKEN and CHANNEL_ID):
        return ""
    boundary = uuid.uuid4().hex
    payload = json.dumps({
        "content": f"Screenshot for ticket #{n}",
        "message_reference": {"message_id": message_id} if message_id else None,
        "attachments": [{"id": 0, "filename": f"ticket-{n}.{ext}"}],
        "allowed_mentions": {"parse": []},
    })
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"ticket-{n}.{ext}\"\r\n"
        f"Content-Type: image/{'png' if ext == 'png' else 'jpeg'}\r\n\r\n"
    ).encode() + image + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages", data=body, method="POST",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}", "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "User-Agent": "DiscordBot (https://cuang.dev, 1.0)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return str(json.loads(resp.read().decode() or "{}").get("id") or "")


VERSION_RE = re.compile(r"^\d+(\.\d+){0,3}$")


def clean_text(value, max_len: int, field: str, min_len: int = 0) -> str:
    if not isinstance(value, str):
        if min_len == 0 and value is None:
            return ""
        raise HTTPException(400, f"{field} must be text")
    text = value.replace("\x00", "").strip()
    if len(text) < min_len:
        raise HTTPException(400, f"{field} is too short")
    return text[:max_len]


def decode_screenshot(value) -> tuple[bytes, str] | None:
    if not value:
        return None
    if not isinstance(value, str):
        raise HTTPException(400, "screenshot must be base64")
    try:
        raw = base64.b64decode(value.split(",", 1)[-1], validate=True)
    except Exception:
        raise HTTPException(400, "screenshot is not valid base64")
    if len(raw) > MAX_SCREENSHOT:
        raise HTTPException(413, "screenshot is too large (2 MB max)")
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    raise HTTPException(400, "screenshot must be a PNG or JPEG")


def ticket_summary(row: sqlite3.Row) -> str:
    lines = [row["description"]]
    meta = " · ".join(x for x in [
        f"Silo {row['app_version']} (build {row['version_code']})" if row["app_version"] else None,
        row["device"], f"Android {row['os_version']}" if row["os_version"] else None,
    ] if x)
    if meta:
        lines += ["", meta]
    if row["error_log"]:
        lines += ["", "Recent errors:", "```", row["error_log"][-1500:], "```"]
    lines += ["", "Fix = agent fixes it on a ticket branch and merges to test if all tests pass.",
              "Reply = fix with your instructions. Reject = close it."]
    return "\n".join(lines)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/tickets")
async def create_ticket(request: Request):
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_BODY:
        raise HTTPException(413, "report is too large")
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "report is too large")
    try:
        body = json.loads(raw)
    except Exception:
        raise HTTPException(400, "invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "invalid report")
    if body.get("website"):  # honeypot field the app never fills
        return {"ok": True, "ticket": 0}

    kind = body.get("kind")
    if kind not in ("bug", "feature"):
        raise HTTPException(400, "kind must be bug or feature")
    title = clean_text(body.get("title"), 120, "title", 3)
    description = clean_text(body.get("description"), 4000, "description", 10)
    app_version = clean_text(body.get("appVersion"), 20, "appVersion")
    if app_version and not VERSION_RE.match(app_version):
        app_version = ""
    try:
        version_code = int(body.get("versionCode") or 0)
    except (TypeError, ValueError):
        version_code = 0
    device = clean_text(body.get("device"), 80, "device")
    os_version = clean_text(body.get("osVersion"), 20, "osVersion")
    error_log = clean_text(body.get("errorLog"), 20000, "errorLog")
    shot = decode_screenshot(body.get("screenshot"))

    ch = client_hash(request)
    t = now()
    with _lock, closing(db()) as conn, conn:
        hour = conn.execute("SELECT COUNT(*) FROM tickets WHERE client_hash = ? AND created_at > ?", (ch, t - 3600)).fetchone()[0]
        day = conn.execute("SELECT COUNT(*) FROM tickets WHERE client_hash = ? AND created_at > ?", (ch, t - 86400)).fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM tickets WHERE created_at > ?", (t - 86400,)).fetchone()[0]
        if hour >= PER_CLIENT_HOUR or day >= PER_CLIENT_DAY or total >= GLOBAL_DAY:
            return JSONResponse({"ok": False, "error": "Too many reports right now. Please try again later."}, status_code=429)
        cur = conn.execute(
            """INSERT INTO tickets (created_at, kind, title, description, app_version, version_code, device, os_version,
                 error_log, has_screenshot, client_hash, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t, kind, title, description, app_version, version_code, device, os_version, error_log or None,
             1 if shot else 0, ch, t),
        )
        n = cur.lastrowid
        add_event(conn, n, "received", f"{kind}: {title}")
        row = conn.execute("SELECT * FROM tickets WHERE n = ?", (n,)).fetchone()

    label = "Bug" if kind == "bug" else "Feature"
    try:
        res = post_to_silo(f"{label} #{n}: {title}", ticket_summary(row), ["Fix", "Reject"], True,
                           status="failed" if kind == "bug" else "info")
        with closing(db()) as conn, conn:
            conn.execute("UPDATE tickets SET ping_id = ?, message_id = ? WHERE n = ?", (res.get("id"), res.get("messageId"), n))
            add_event(conn, n, "posted", f"Posted to #silo (ping {res.get('id')})")
        remember_message(n, res.get("messageId"))
        if shot:
            try:
                remember_message(n, attach_screenshot(res.get("messageId") or "", shot[0], shot[1], n))
            except Exception as exc:  # noqa: BLE001
                with closing(db()) as conn, conn:
                    add_event(conn, n, "error", f"Screenshot upload failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        with closing(db()) as conn, conn:
            add_event(conn, n, "error", f"Could not post to Discord: {exc}")
        # Still accepted: the dispatcher re-posts tickets that have no ping.
    return {"ok": True, "ticket": n}


def require_admin(authorization: str | None) -> None:
    if not ADMIN_TOKEN or authorization != f"Bearer {ADMIN_TOKEN}":
        raise HTTPException(401, "unauthorized")


def row_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d.pop("client_hash", None)
    return d


@app.get("/internal/tickets")
def list_tickets(status: str | None = None, authorization: str | None = Header(None)):
    require_admin(authorization)
    with closing(db()) as conn:
        if status:
            rows = conn.execute("SELECT * FROM tickets WHERE status = ? ORDER BY n", (status,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM tickets ORDER BY n DESC LIMIT 200").fetchall()
    return {"tickets": [row_dict(r) for r in rows]}


@app.get("/internal/tickets/{n}")
def get_ticket(n: int, authorization: str | None = Header(None)):
    require_admin(authorization)
    with closing(db()) as conn:
        row = conn.execute("SELECT * FROM tickets WHERE n = ?", (n,)).fetchone()
        if not row:
            raise HTTPException(404, "no such ticket")
        events = conn.execute("SELECT at, kind, text FROM events WHERE n = ? ORDER BY id", (n,)).fetchall()
    return {"ticket": row_dict(row), "events": [dict(e) for e in events]}


@app.post("/internal/tickets/{n}/events")
async def ticket_event(n: int, request: Request, authorization: str | None = Header(None)):
    require_admin(authorization)
    body = await request.json()
    kind = str(body.get("kind") or "note")[:40]
    text = str(body.get("text") or "")
    fields = {k: body[k] for k in ("status", "decision", "instructions", "branch", "result", "ping_id") if k in body}
    if "status" in fields and fields["status"] not in STATUSES:
        raise HTTPException(400, "unknown status")
    with closing(db()) as conn, conn:
        if not conn.execute("SELECT 1 FROM tickets WHERE n = ?", (n,)).fetchone():
            raise HTTPException(404, "no such ticket")
        for key, value in fields.items():
            conn.execute(f"UPDATE tickets SET {key} = ? WHERE n = ?", (value, n))  # keys from a fixed allowlist
        add_event(conn, n, kind, text or ", ".join(f"{k}={v}" for k, v in fields.items()))
    return {"ok": True}


@app.post("/internal/tickets/{n}/post")
async def ticket_post(n: int, request: Request, authorization: str | None = Header(None)):
    require_admin(authorization)
    body = await request.json()
    options = [str(o)[:80] for o in (body.get("options") or [])][:5]
    res = post_to_silo(str(body.get("task") or f"Ticket #{n}"), str(body.get("summary") or ""), options,
                       bool(body.get("allowReply")), status=str(body.get("status") or "info"))
    with closing(db()) as conn, conn:
        add_event(conn, n, "posted", f"{body.get('task')}: ping {res.get('id')}")
    remember_message(n, res.get("messageId"))
    return {"ok": True, "id": res.get("id"), "messageId": res.get("messageId")}


# ---------------------------------------------------------------- retention

RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "365"))
CLOSED = ("rejected", "merged_to_test", "released", "closed")


def delete_discord_message(message_id: str) -> bool:
    if not (DISCORD_BOT_TOKEN and CHANNEL_ID):
        return False
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages/{message_id}", method="DELETE",
        headers={"Authorization": f"Bot {DISCORD_BOT_TOKEN}", "User-Agent": "DiscordBot (https://cuang.dev, 1.0)"},
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
        return True
    except urllib.error.HTTPError as exc:
        return exc.code == 404  # already gone


def delete_ticket(n: int) -> dict:
    """Removes a ticket everywhere: its Discord messages (incl. screenshot), events and the ticket row."""
    with closing(db()) as conn:
        ids = [r[0] for r in conn.execute("SELECT message_id FROM messages WHERE n = ?", (n,)).fetchall()]
        legacy = conn.execute("SELECT message_id FROM tickets WHERE n = ?", (n,)).fetchone()
    if legacy and legacy[0] and legacy[0] not in ids:
        ids.append(legacy[0])
    failed = [m for m in ids if not delete_discord_message(m)]
    if failed:
        return {"ok": False, "n": n, "failed_messages": failed}
    with closing(db()) as conn, conn:
        conn.execute("DELETE FROM messages WHERE n = ?", (n,))
        conn.execute("DELETE FROM events WHERE n = ?", (n,))
        conn.execute("DELETE FROM tickets WHERE n = ?", (n,))
    return {"ok": True, "n": n, "deleted_messages": len(ids)}


def purge_expired(now_ts: int | None = None) -> list[int]:
    """Privacy policy: closed reports are deleted within 12 months."""
    cutoff = (now_ts or now()) - RETENTION_DAYS * 86400
    with closing(db()) as conn:
        rows = conn.execute(
            f"SELECT n FROM tickets WHERE status IN ({','.join('?' * len(CLOSED))}) AND updated_at < ?", (*CLOSED, cutoff)
        ).fetchall()
    done = []
    for (n,) in rows:
        if delete_ticket(n).get("ok"):
            done.append(n)
    return done


def _retention_loop() -> None:
    while True:
        try:
            purge_expired()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(24 * 3600)


@app.on_event("startup")
def _start_retention() -> None:
    if os.environ.get("DISABLE_RETENTION_LOOP") != "1":
        threading.Thread(target=_retention_loop, daemon=True).start()


@app.delete("/internal/tickets/{n}")
def remove_ticket(n: int, authorization: str | None = Header(None)):
    """For deletion requests ("please delete report #12")."""
    require_admin(authorization)
    result = delete_ticket(n)
    if not result.get("ok"):
        raise HTTPException(502, f"could not delete Discord messages: {result.get('failed_messages')}")
    return result


@app.get("/internal/wait/{ping_id}")
def wait(ping_id: str, timeout: int = 20, authorization: str | None = Header(None)):
    """Proxies the Cuangbot wait call so the dispatcher only needs the relay token."""
    require_admin(authorization)
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", ping_id):
        raise HTTPException(400, "bad ping id")
    timeout = max(1, min(25, timeout))
    try:
        return http_json("GET", f"{CUANGBOT_URL}/api/worker-ping/wait/{ping_id}?timeout={timeout}",
                         {"Authorization": f"Bearer {CUANGBOT_TOKEN}"}, timeout=timeout + 10)
    except urllib.error.HTTPError as exc:
        raise HTTPException(exc.code, "wait failed")
