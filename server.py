"""
Loci Lens backend — production-ready
"""

import os
import uuid
import time
import struct
import sqlite3
from pathlib import Path
from flask import (Flask, request, jsonify, send_from_directory,
                   abort, Response, stream_with_context)

BASE_DIR   = Path(__file__).parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", str(BASE_DIR / "uploads")))
DB_PATH    = Path(os.environ.get("DB_PATH",    str(BASE_DIR / "loci.db")))
PHOTOS_DIR = UPLOAD_DIR / "photos"
AUDIO_DIR  = UPLOAD_DIR / "audio"
PORT       = int(os.environ.get("PORT", 5000))

for d in [PHOTOS_DIR, AUDIO_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS captures (
                id          TEXT PRIMARY KEY,
                device_id   TEXT,
                prompt      TEXT,
                timestamp   TEXT,
                photo_path  TEXT,
                audio_path  TEXT,
                created_at  REAL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS prompts (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                text      TEXT NOT NULL,
                active    INTEGER DEFAULT 1,
                order_idx INTEGER DEFAULT 0
            )
        """)

        # Seed defaults if table is empty
        cur = db.execute("SELECT COUNT(*) FROM prompts")
        if cur.fetchone()[0] == 0:
            defaults = [
                ("Is sugar bad\nfor your teeth?", 0),
                ("Is school\nimportant?", 1),
                ("Are screens\nbad for you?", 2),
                ("Find something\nSTRANGE", 3),
                ("Find something\nOLD", 4),
                ("Find something\nBROKEN", 5),
            ]
            db.executemany(
                "INSERT INTO prompts (text, active, order_idx) VALUES (?, 1, ?)",
                defaults
            )
        db.commit()

init_db()

def capture_to_dict(row):
    d = dict(row)
    if d.get("photo_path"):
        d["photo_url"] = f"/uploads/photos/{Path(d['photo_path']).name}"
    if d.get("audio_path"):
        d["audio_url"] = f"/uploads/audio/{Path(d['audio_path']).name}"
    return d

def fix_wav_header(path: Path):
    size = path.stat().st_size
    if size < 44:
        return
    pcm_bytes = size - 44
    with open(str(path), "r+b") as f:
        f.seek(4);  f.write(struct.pack("<I", 36 + pcm_bytes))
        f.seek(40); f.write(struct.pack("<I", pcm_bytes))

def range_response(path: Path, mimetype: str):
    if not path.exists():
        abort(404)
    file_size    = path.stat().st_size
    range_header = request.headers.get("Range")
    if not range_header:
        response = Response(open(str(path), "rb").read(), status=200, mimetype=mimetype)
        response.headers["Content-Length"] = file_size
        response.headers["Accept-Ranges"]  = "bytes"
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
    try:
        byte_range         = range_header.replace("bytes=", "").strip()
        start_str, end_str = byte_range.split("-")
        start = int(start_str)
        end   = int(end_str) if end_str else file_size - 1
        end   = min(end, file_size - 1)
    except (ValueError, AttributeError):
        abort(416)
    if start > end or start >= file_size:
        abort(416)
    length = end - start + 1
    def generate():
        with open(str(path), "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(8192, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
    response = Response(stream_with_context(generate()), status=206, mimetype=mimetype)
    response.headers["Content-Range"]  = f"bytes {start}-{end}/{file_size}"
    response.headers["Content-Length"] = length
    response.headers["Accept-Ranges"]  = "bytes"
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response

@app.route("/api/captures", methods=["POST"])
def create_capture():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file field"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "Empty filename"}), 400
    capture_id = str(uuid.uuid4())
    photo_path = PHOTOS_DIR / f"{capture_id}.jpg"
    f.save(str(photo_path))
    prompt    = request.form.get("prompt", "")
    device_id = request.form.get("device_id", "unknown")
    timestamp = request.form.get("timestamp", str(int(time.time() * 1000)))
    with get_db() as db:
        db.execute(
            "INSERT INTO captures (id, device_id, prompt, timestamp, photo_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (capture_id, device_id, prompt, timestamp, str(photo_path), time.time())
        )
        db.commit()
    print(f"[photo] {capture_id}  '{prompt}'  {device_id}")
    return jsonify({"ok": True, "capture_id": capture_id}), 200

@app.route("/api/captures/<capture_id>/audio", methods=["POST"])
def attach_audio(capture_id):
    with get_db() as db:
        row = db.execute("SELECT id FROM captures WHERE id=?", (capture_id,)).fetchone()
    if row is None:
        return jsonify({"ok": False, "error": "capture not found"}), 404
    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio field"}), 400
    audio_path = AUDIO_DIR / f"{capture_id}.wav"
    request.files["audio"].save(str(audio_path))
    fix_wav_header(audio_path)
    size = audio_path.stat().st_size
    print(f"[audio] {capture_id}  {size} bytes  ({size/1024:.1f} KB)")
    with get_db() as db:
        db.execute("UPDATE captures SET audio_path=? WHERE id=?",
                   (str(audio_path), capture_id))
        db.commit()
    return jsonify({"ok": True, "bytes": size}), 200

@app.route("/api/captures", methods=["GET"])
def list_captures():
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM captures ORDER BY created_at DESC LIMIT 100"
        ).fetchall()
    return jsonify([capture_to_dict(r) for r in rows]), 200

@app.route("/api/captures/<capture_id>", methods=["GET"])
def get_capture(capture_id):
    with get_db() as db:
        row = db.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone()
    if row is None:
        abort(404)
    return jsonify(capture_to_dict(row)), 200

@app.route("/uploads/photos/<filename>")
def serve_photo(filename):
    return send_from_directory(str(PHOTOS_DIR), filename)

@app.route("/uploads/audio/<filename>")
def serve_audio(filename):
    return range_response(AUDIO_DIR / filename, "audio/wav")

VIEWER_HTML = open(str(BASE_DIR / "viewer.html")).read()

@app.route("/")
def viewer():
    return VIEWER_HTML, 200, {"Content-Type": "text/html"}

# GET /api/prompts — device fetches this on boot
@app.route("/api/prompts", methods=["GET"])
def get_prompts():
    with get_db() as db:
        rows = db.execute(
            "SELECT text FROM prompts WHERE active=1 ORDER BY order_idx ASC"
        ).fetchall()
    return jsonify({"prompts": [r["text"] for r in rows]})

# POST /api/prompts — you call this to replace the full list remotely
# Body: { "prompts": ["text one", "text two\nline two", ...] }
@app.route("/api/prompts", methods=["POST"])
def set_prompts():
    data = request.get_json(force=True)
    if not data or "prompts" not in data:
        return jsonify({"error": "missing prompts array"}), 400
    with get_db() as db:
        db.execute("DELETE FROM prompts")
        for i, text in enumerate(data["prompts"]):
            db.execute(
                "INSERT INTO prompts (text, active, order_idx) VALUES (?, 1, ?)",
                (text, i)
            )
        db.commit()
    return jsonify({"ok": True, "count": len(data["prompts"])})

ADMIN_HTML = open(str(BASE_DIR / "admin.html")).read()

@app.route("/admin")
def admin():
    return ADMIN_HTML, 200, {"Content-Type": "text/html"}

if __name__ == "__main__":
    print(f"Loci Lens server → http://0.0.0.0:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
