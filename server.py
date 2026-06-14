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
        db.execute("DROP TABLE IF EXISTS prompts")
        db.execute("""
            CREATE TABLE IF NOT EXISTS steps (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id  TEXT NOT NULL DEFAULT 'lens01',
                step_type  TEXT NOT NULL,
                text       TEXT NOT NULL,
                order_idx  INTEGER DEFAULT 0
            )
        """)

        cur = db.execute("SELECT COUNT(*) FROM steps")
        if cur.fetchone()[0] == 0:
            defaults = [
                # pair
                ("lens01", "camera", "Is sugar bad\nfor your teeth?", 0),
                ("lens01", "audio",  "Why do you\nthink that?",       1),
                # series: 3 cameras then 1 audio
                ("lens01", "camera", "Find something\nSTRANGE",       2),
                ("lens01", "camera", "Find something\nOLD",           3),
                ("lens01", "camera", "Find something\nBROKEN",        4),
                ("lens01", "audio",  "Tell us about\nall three",      5),
            ]
            db.executemany(
                "INSERT INTO steps (device_id, step_type, text, order_idx) "
                "VALUES (?, ?, ?, ?)", defaults
            )
        db.commit()

init_db()

# ---------------------------------------------------------------------------
# Demo script — fixed narrative for parent page
# ---------------------------------------------------------------------------
DEMO_SCRIPT = {
    "demo": {
        "topic": "Aesthetics",
        "child": "Ethan",
        "routes": [
            {
                "title": "Is it beautiful to you?",
                "dot": "var(--yellow)",
                "nodes": [
                    {
                        "medium": "cam",
                        "challenge": False,
                        "prompt": "Find the most beautiful thing in this room",
                        "opener": "He chose this above everything else. Ask: <b>“What made this the most beautiful — out of everything in the room?”</b>",
                        "moves": [
                            "Ask: “Would your friend have picked the same thing?”",
                            "Try: “Is it beautiful, or just your favourite? Are those different?”",
                        ],
                    },
                    {
                        "medium": "aud",
                        "challenge": False,
                        "prompt": "What’s something most people call ugly that you secretly like?",
                        "opener": "Listen back together first, then ask: <b>“Why do you think other people don’t see it the way you do?”</b>",
                        "moves": [
                            "Ask: “Does it being ‘ugly’ to others change how you feel about it?”",
                            "Turn it round: “Is there something everyone loves that you don’t?”",
                        ],
                    },
                    {
                        "medium": "play",
                        "challenge": False,
                        "prompt": "Look at one thing up close, then far away — does it change?",
                        "activity": "Ethan studied a leaf with the lens — up close, then from across the room.",
                        "opener": "<b>“Was it more beautiful close up or far away — and why?”</b>",
                        "moves": [
                            "Ask: “Can how you look at something change whether it’s beautiful?”",
                            "Ask: “Is the beauty in the leaf, or in how you’re seeing it?”",
                        ],
                    },
                    {
                        "medium": "cam",
                        "challenge": True,
                        "prompt": "Photograph something beautiful that isn’t pretty",
                        "opener": "A tricky one — beauty without prettiness. Ask: <b>“What’s the difference between beautiful and pretty?”</b>",
                        "moves": [
                            "Ask: “Can something sad or broken still be beautiful?”",
                            "Ask: “Is a storm beautiful? A scar?”",
                        ],
                    },
                ],
            },
            {
                "title": "Does everyone agree?",
                "dot": "var(--blue)",
                "nodes": [
                    {
                        "medium": "cam",
                        "challenge": False,
                        "prompt": "Photograph a colour you could look at forever",
                        "opener": "<b>“Why this colour and not another — can you say what it is about it?”</b>",
                        "moves": [
                            "Ask: “Could a colour ever be ugly? Which one, and to who?”",
                            "Ask: “Do you think I’d choose the same colour?”",
                        ],
                    },
                    {
                        "medium": "aud",
                        "challenge": True,
                        "prompt": "Argue your favourite song is the best ever — then argue it isn’t",
                        "opener": "He had to take both sides. Ask: <b>“If people disagree, can a song still be ‘the best’?”</b>",
                        "moves": [
                            "Ask: “Is there a best song, or just your best song?”",
                            "Ask: “Did arguing the other side change anything?”",
                        ],
                    },
                ],
            },
        ],
    }
}


def format_audio_duration(audio_path):
    try:
        size = Path(audio_path).stat().st_size
        pcm_bytes = max(0, size - 44)
        seconds = pcm_bytes / (8000 * 2)
        m = int(seconds // 60)
        s = int(seconds % 60)
        return f"{m}:{s:02d}"
    except Exception:
        return "0:00"


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
    device_id = request.args.get("device_id")
    with get_db() as db:
        if device_id:
            rows = db.execute(
                "SELECT * FROM captures WHERE device_id=? ORDER BY created_at DESC LIMIT 100",
                (device_id,)
            ).fetchall()
        else:
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

@app.route("/api/prompts", methods=["GET"])
def get_prompts():
    device_id = request.args.get("device_id", "lens01")
    with get_db() as db:
        rows = db.execute(
            "SELECT step_type, text FROM steps "
            "WHERE device_id=? ORDER BY order_idx ASC", (device_id,)
        ).fetchall()
    return jsonify({"steps": [{"type": r["step_type"], "text": r["text"]} for r in rows]})

@app.route("/api/prompts", methods=["POST"])
def set_prompts():
    data = request.get_json(force=True)
    if not data or "steps" not in data:
        return jsonify({"error": "missing steps array"}), 400
    device_id = data.get("device_id", "lens01")
    with get_db() as db:
        db.execute("DELETE FROM steps WHERE device_id=?", (device_id,))
        for i, step in enumerate(data["steps"]):
            db.execute(
                "INSERT INTO steps (device_id, step_type, text, order_idx) "
                "VALUES (?, ?, ?, ?)",
                (device_id, step.get("type", "camera"), step.get("text", ""), i)
            )
        db.commit()
    return jsonify({"ok": True, "count": len(data["steps"]), "device_id": device_id})

ADMIN_HTML  = open(str(BASE_DIR / "admin.html")).read()
PARENT_HTML = open(str(BASE_DIR / "parent.html")).read()

@app.route("/admin")
@app.route("/admin/<device_id>")
def admin(device_id="lens01"):
    return ADMIN_HTML, 200, {"Content-Type": "text/html"}

@app.route("/parent")
@app.route("/parent/<device_id>")
def parent(device_id="lens01"):
    return PARENT_HTML, 200, {"Content-Type": "text/html"}

@app.route("/api/debug/prompts")
def debug_prompts():
    with get_db() as db:
        rows = db.execute("SELECT * FROM steps").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/parent/<device_id>")
def parent_data(device_id):
    script = DEMO_SCRIPT.get(device_id)
    if not script:
        return jsonify({"error": "unknown device"}), 404

    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM captures WHERE device_id=? ORDER BY created_at ASC",
            (device_id,)
        ).fetchall()
    captures = [dict(r) for r in rows]

    cam_queue = [c for c in captures if c.get("photo_path")]
    aud_queue = [c for c in captures if c.get("audio_path")]
    cam_idx = 0
    aud_idx = 0

    out_routes = []
    for route in script["routes"]:
        out_nodes = []
        for node in route["nodes"]:
            n = {
                "medium":    node["medium"],
                "challenge": node["challenge"],
                "prompt":    node["prompt"],
                "opener":    node["opener"],
                "moves":     node["moves"],
            }
            if node["medium"] == "cam":
                if cam_idx < len(cam_queue):
                    c = cam_queue[cam_idx]
                    n["photo"] = f"/uploads/photos/{Path(c['photo_path']).name}"
                    n["tag"]   = f"{script['child']}’s photo"
                    cam_idx += 1
                else:
                    n["pending"] = True
            elif node["medium"] == "aud":
                if aud_idx < len(aud_queue):
                    c = aud_queue[aud_idx]
                    n["audio"]     = format_audio_duration(c["audio_path"])
                    n["audio_url"] = f"/uploads/audio/{Path(c['audio_path']).name}"
                    aud_idx += 1
                else:
                    n["pending"] = True
            elif node["medium"] == "play":
                n["activity"] = node.get("activity", "")
            out_nodes.append(n)
        out_routes.append({"title": route["title"], "dot": route["dot"], "nodes": out_nodes})

    return jsonify({"topic": script["topic"], "child": script["child"], "routes": out_routes})


@app.route("/api/demo/reset/<device_id>", methods=["POST"])
def demo_reset(device_id):
    with get_db() as db:
        rows = db.execute(
            "SELECT photo_path, audio_path FROM captures WHERE device_id=?",
            (device_id,)
        ).fetchall()
        n = len(rows)
        for row in rows:
            if row["photo_path"]:
                try:
                    Path(row["photo_path"]).unlink(missing_ok=True)
                except Exception:
                    pass
            if row["audio_path"]:
                try:
                    Path(row["audio_path"]).unlink(missing_ok=True)
                except Exception:
                    pass
        db.execute("DELETE FROM captures WHERE device_id=?", (device_id,))
        db.commit()
    return jsonify({"ok": True, "cleared": n})


@app.route("/api/reset-db-once-xyz")
def reset_db_once():
    DB_PATH.unlink(missing_ok=True)
    init_db()
    return jsonify({"ok": True, "message": "database reset"})

if __name__ == "__main__":
    print(f"Loci Lens server → http://0.0.0.0:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
