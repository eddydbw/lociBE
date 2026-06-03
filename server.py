"""
Loci Lens backend — production-ready
-------------------------------------
Local:    python server.py
Railway:  deploys automatically via Procfile

Endpoints
  POST /api/captures                — upload photo + metadata → { capture_id }
  POST /api/captures/<id>/audio     — attach WAV → { ok, bytes }
  GET  /api/captures                — list all (newest first)
  GET  /api/captures/<id>           — single capture
  GET  /uploads/photos/<file>       — serve photo
  GET  /uploads/audio/<file>        — serve audio with range support
  GET  /                            — live viewer UI
"""

import os
import uuid
import time
import struct
import sqlite3
from pathlib import Path
from flask import (Flask, request, jsonify, send_from_directory,
                   abort, Response, stream_with_context)

# ── Configuration ─────────────────────────────────────────────────────────────
# On Railway, files on disk are ephemeral unless you attach a volume.
# Set UPLOAD_DIR and DB_PATH to your Railway volume mount path,
# e.g. /data — configure this in Railway → your service → Variables:
#   UPLOAD_DIR=/data/uploads
#   DB_PATH=/data/loci.db
# Locally these default to ./uploads and ./loci.db

BASE_DIR   = Path(__file__).parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", str(BASE_DIR / "uploads")))
DB_PATH    = Path(os.environ.get("DB_PATH",    str(BASE_DIR / "loci.db")))
PHOTOS_DIR = UPLOAD_DIR / "photos"
AUDIO_DIR  = UPLOAD_DIR / "audio"
PORT       = int(os.environ.get("PORT", 5000))

for d in [PHOTOS_DIR, AUDIO_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB

# ── Database ──────────────────────────────────────────────────────────────────
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
        db.commit()

init_db()

# ── Helpers ───────────────────────────────────────────────────────────────────
def capture_to_dict(row):
    d = dict(row)
    if d.get("photo_path"):
        d["photo_url"] = f"/uploads/photos/{Path(d['photo_path']).name}"
    if d.get("audio_path"):
        d["audio_url"] = f"/uploads/audio/{Path(d['audio_path']).name}"
    return d

def fix_wav_header(path: Path):
    """Patch WAV header with actual file size — corrects any device-side mismatch."""
    size = path.stat().st_size
    if size < 44:
        return
    pcm_bytes = size - 44
    with open(str(path), "r+b") as f:
        f.seek(4);  f.write(struct.pack("<I", 36 + pcm_bytes))
        f.seek(40); f.write(struct.pack("<I", pcm_bytes))

def range_response(path: Path, mimetype: str):
    """
    Serve a file with proper HTTP range request support (RFC 7233).
    Returns 206 Partial Content for range requests, 200 for full requests.
    This is what browsers require for <audio> seeking and duration display.
    """
    if not path.exists():
        abort(404)

    file_size   = path.stat().st_size
    range_header = request.headers.get("Range")

    if not range_header:
        # Full file — no range requested
        response = Response(
            open(str(path), "rb").read(),
            status=200,
            mimetype=mimetype
        )
        response.headers["Content-Length"] = file_size
        response.headers["Accept-Ranges"]  = "bytes"
        return response

    # Parse Range: bytes=start-end
    try:
        byte_range          = range_header.replace("bytes=", "").strip()
        start_str, end_str  = byte_range.split("-")
        start = int(start_str)
        end   = int(end_str) if end_str else file_size - 1
        end   = min(end, file_size - 1)
    except (ValueError, AttributeError):
        abort(416)  # Range Not Satisfiable

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

    response = Response(
        stream_with_context(generate()),
        status=206,
        mimetype=mimetype
    )
    response.headers["Content-Range"]  = f"bytes {start}-{end}/{file_size}"
    response.headers["Content-Length"] = length
    response.headers["Accept-Ranges"]  = "bytes"
    return response

# ── API Routes ────────────────────────────────────────────────────────────────

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
            "INSERT INTO captures "
            "(id, device_id, prompt, timestamp, photo_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (capture_id, device_id, prompt, timestamp, str(photo_path), time.time())
        )
        db.commit()

    print(f"[photo] {capture_id}  '{prompt}'  {device_id}")
    return jsonify({"ok": True, "capture_id": capture_id}), 200


@app.route("/api/captures/<capture_id>/audio", methods=["POST"])
def attach_audio(capture_id):
    with get_db() as db:
        row = db.execute("SELECT id FROM captures WHERE id=?",
                         (capture_id,)).fetchone()
    if row is None:
        return jsonify({"ok": False, "error": "capture not found"}), 404

    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio field"}), 400

    audio_path = AUDIO_DIR / f"{capture_id}.wav"
    request.files["audio"].save(str(audio_path))   # single save
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
        row = db.execute("SELECT * FROM captures WHERE id=?",
                         (capture_id,)).fetchone()
    if row is None:
        abort(404)
    return jsonify(capture_to_dict(row)), 200


# ── File serving ──────────────────────────────────────────────────────────────

@app.route("/uploads/photos/<filename>")
def serve_photo(filename):
    return send_from_directory(str(PHOTOS_DIR), filename)

@app.route("/uploads/audio/<filename>")
def serve_audio(filename):
    return range_response(AUDIO_DIR / filename, "audio/wav")


# ── Viewer UI ─────────────────────────────────────────────────────────────────

@app.route("/")
def viewer():
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Loci Lens</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, sans-serif;
    background: #0f0f0f; color: #e8e8e8;
    padding: 24px;
  }
  h1 { font-size: 1.4rem; color: #ff9900; margin-bottom: 20px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  .card {
    background: #1c1c1c; border-radius: 10px;
    overflow: hidden; border: 1px solid #2a2a2a;
  }
  .card img { width: 100%; display: block; aspect-ratio: 4/3; object-fit: cover; }
  .placeholder { width: 100%; aspect-ratio: 4/3; background: #2a2a2a; }
  .info { padding: 12px; }
  .prompt { font-weight: 600; font-size: .95rem; margin-bottom: 6px; }
  .meta { font-size: .75rem; color: #777; margin-bottom: 10px; }
  audio { width: 100%; height: 36px; }
  .no-audio { font-size: .75rem; color: #444; font-style: italic; }
  .empty { color: #555; }
</style>
</head>
<body>
<h1>Loci Lens</h1>
<div class="grid" id="grid"><p class="empty">Loading...</p></div>
<script>
async function load() {
  const res  = await fetch('/api/captures');
  const data = await res.json();
  const grid = document.getElementById('grid');
  if (!data.length) { grid.innerHTML = '<p class="empty">No captures yet.</p>'; return; }
  grid.innerHTML = data.map(c => `
    <div class="card">
      ${c.photo_url
        ? `<img src="${c.photo_url}" loading="lazy">`
        : '<div class="placeholder"></div>'}
      <div class="info">
        <div class="prompt">${c.prompt || '(no prompt)'}</div>
        <div class="meta">${c.device_id} &nbsp;·&nbsp; ${new Date(c.created_at*1000).toLocaleString()}</div>
        ${c.audio_url
          ? `<audio controls preload="metadata" src="${c.audio_url}"></audio>`
          : '<div class="no-audio">No audio</div>'}
      </div>
    </div>`).join('');
}
load();
setInterval(load, 5000);
</script>
</body>
</html>""", 200, {"Content-Type": "text/html"}


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"Loci Lens server → http://0.0.0.0:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
