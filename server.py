"""
Loci Lens backend — production-ready
"""

import os
import uuid
import time
import struct
import sqlite3
import mimetypes

mimetypes.add_type("font/woff2", ".woff2")
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

# ---------------------------------------------------------------------------
# The five Loci topics. Slugs travel through the data; display labels and
# colours live in the exhibit page's DATA object (the exhibit CMS).
# ---------------------------------------------------------------------------
TOPIC_SLUGS = ["lying", "invisible-ring", "art", "beauty", "real"]

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
                topic       TEXT,
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
                topic      TEXT,
                order_idx  INTEGER DEFAULT 0
            )
        """)
        # migrate pre-topic databases in place
        for stmt in ("ALTER TABLE captures ADD COLUMN topic TEXT",
                     "ALTER TABLE steps ADD COLUMN topic TEXT"):
            try:
                db.execute(stmt)
            except sqlite3.OperationalError:
                pass

        def seed(device_id, rows):
            n = db.execute("SELECT COUNT(*) FROM steps WHERE device_id=?",
                           (device_id,)).fetchone()[0]
            if n == 0:
                db.executemany(
                    "INSERT INTO steps (device_id, step_type, text, topic, order_idx) "
                    "VALUES (?, ?, ?, ?, ?)", rows
                )

        seed("lens01", [
            # pair
            ("lens01", "camera", "Is sugar bad\nfor your teeth?", None, 0),
            ("lens01", "audio",  "Why do you\nthink that?",       None, 1),
            # series: 3 cameras then 1 audio
            ("lens01", "camera", "Find something\nSTRANGE",       None, 2),
            ("lens01", "camera", "Find something\nOLD",           None, 3),
            ("lens01", "camera", "Find something\nBROKEN",        None, 4),
            ("lens01", "audio",  "Tell us about\nall three",      None, 5),
        ])
        # demo lens journey: one question per topic, photo then voice
        seed("demo", [
            ("demo", "camera", "Find something\npretending to be\nsomething else", "lying",          0),
            ("demo", "audio",  "What is it pretending?\nHow did you catch it?",    "lying",          1),
            ("demo", "camera", "Find a place you'd\nsneak to if nobody\ncould see you", "invisible-ring", 2),
            ("demo", "audio",  "What would you\ndo there, invisible?",             "invisible-ring", 3),
            ("demo", "camera", "Find something that\nmight secretly\nbe art",      "art",            4),
            ("demo", "audio",  "Why might it be art?\nWhy might it not?",          "art",            5),
            ("demo", "camera", "Find something\nbeautiful you\ncan't carry",       "beauty",         6),
            ("demo", "audio",  "What makes it\nbeautiful?",                        "beauty",         7),
            ("demo", "camera", "Find something real\nthat you\ncan't touch",       "real",           8),
            ("demo", "audio",  "How do you know\nit's real?",                      "real",           9),
        ])
        db.commit()

init_db()

# ---------------------------------------------------------------------------
# Demo script — fixed narrative for parent page
# ---------------------------------------------------------------------------
DEMO_SCRIPT = {
    'demo': {
        'topic': 'Big Questions',
        'child': 'Ethan',
        'routes': [
            {
                'title': 'Lying',
                'topic': 'lying',
                'dot': '#F4C6D2',
                'nodes': [
                    {
                        'medium': 'cam',
                        'challenge': False,
                        'prompt': "Find something pretending to be something else",
                        'opener': 'He found something that isn\'t quite what it claims to be. Ask: <b>"What gave it away?"</b>',
                        'moves': [
                            'Ask: "Is pretending the same as lying?"',
                            'Ask: "Can a thing lie, or only a person?"',
                        ],
                    },
                    {
                        'medium': 'aud',
                        'challenge': False,
                        'prompt': 'What is it pretending? How did you catch it?',
                        'opener': 'Listen back together first, then ask: <b>"Does a lie need someone to believe it?"</b>',
                        'moves': [
                            'Ask: "Is it still a lie if nobody is fooled?"',
                            'Ask: "Has anyone ever been glad about a lie?"',
                        ],
                    },
                ],
            },
            {
                'title': 'The Invisible Ring',
                'topic': 'invisible-ring',
                'dot': '#D8CDF1',
                'nodes': [
                    {
                        'medium': 'cam',
                        'challenge': False,
                        'prompt': "Find a place you'd sneak to if nobody could see you",
                        'opener': 'The old story of the invisible ring asks: would we stay good if nobody could catch us? Ask: <b>"Why this place?"</b>',
                        'moves': [
                            'Ask: "Would you act differently if you were invisible for a day?"',
                            'Ask: "Is it still wrong if nobody ever finds out?"',
                        ],
                    },
                    {
                        'medium': 'aud',
                        'challenge': False,
                        'prompt': 'What would you do there, invisible?',
                        'opener': 'Listen back together, then ask: <b>"Would invisible-you still be you?"</b>',
                        'moves': [
                            'Ask: "What would you never do, even invisible?"',
                            'Ask: "Do rules count when no one is watching?"',
                        ],
                    },
                ],
            },
            {
                'title': 'Is It Art?',
                'topic': 'art',
                'dot': '#BFE5D2',
                'nodes': [
                    {
                        'medium': 'cam',
                        'challenge': False,
                        'prompt': 'Find something that might secretly be art',
                        'opener': 'He decided this might be art. Ask: <b>"What made you wonder about this one?"</b>',
                        'moves': [
                            'Ask: "Does someone have to make it on purpose for it to be art?"',
                            'Ask: "If we put a frame around it, does it change?"',
                        ],
                    },
                    {
                        'medium': 'aud',
                        'challenge': False,
                        'prompt': 'Why might it be art? Why might it not?',
                        'opener': 'Listen back together, then ask: <b>"Who gets to decide what counts as art?"</b>',
                        'moves': [
                            'Ask: "Could something be art to you and not to me?"',
                            'Ask: "Is there anything that could never be art?"',
                        ],
                    },
                ],
            },
            {
                'title': 'Beautiful',
                'topic': 'beauty',
                'dot': '#FADFC7',
                'nodes': [
                    {
                        'medium': 'cam',
                        'challenge': False,
                        'prompt': "Find something beautiful that you can't carry",
                        'opener': 'He found something too big, too fixed, too much to take away. Ask: <b>"What made you stop at this — what did you see?"</b>',
                        'moves': [
                            'Ask: "Would it still be beautiful if you could take it home?"',
                            'Ask: "Does something being unmovable make it more or less beautiful?"',
                        ],
                    },
                    {
                        'medium': 'aud',
                        'challenge': False,
                        'prompt': 'What makes it beautiful?',
                        'opener': 'Listen back together first, then ask: <b>"Is it beautiful because of what it looks like, or because of something else?"</b>',
                        'moves': [
                            'Ask: "Could you describe it to someone who has never seen it?"',
                            'Ask: "Would everyone find it beautiful, or just you?"',
                        ],
                    },
                ],
            },
            {
                'title': 'What Is Real?',
                'topic': 'real',
                'dot': '#C7DEF3',
                'nodes': [
                    {
                        'medium': 'cam',
                        'challenge': False,
                        'prompt': "Find something real that you can't touch",
                        'opener': 'He found something real with nothing to hold. Ask: <b>"How do you know it\'s there?"</b>',
                        'moves': [
                            'Ask: "Is a shadow real? Is a reflection?"',
                            'Ask: "Can something be real and invisible at the same time?"',
                        ],
                    },
                    {
                        'medium': 'aud',
                        'challenge': False,
                        'prompt': "How do you know it's real?",
                        'opener': 'Listen back together, then ask: <b>"Could something feel real and not be?"</b>',
                        'moves': [
                            'Ask: "Are dreams real while you\'re in them?"',
                            'Ask: "What\'s the realest thing you found today?"',
                        ],
                    },
                ],
            },
        ],
    }
}


def _norm(text):
    return " ".join((text or "").split()).lower()


def script_cam_topics(device_id):
    """Ordered topic slugs of the camera nodes in a device's demo script."""
    script = DEMO_SCRIPT.get(device_id)
    if not script:
        return []
    return [r.get("topic") for r in script["routes"]
            for n in r["nodes"] if n["medium"] == "cam" and r.get("topic")]


def resolve_topic(db, device_id, prompt):
    """Topic for an incoming capture: explicit form field beats prompt-text
    match against the device's steps/script, which beats journey order."""
    norm = _norm(prompt)
    if norm:
        rows = db.execute(
            "SELECT text, topic FROM steps WHERE device_id=? AND topic IS NOT NULL",
            (device_id,)
        ).fetchall()
        for r in rows:
            if _norm(r["text"]) == norm:
                return r["topic"]
        script = DEMO_SCRIPT.get(device_id)
        if script:
            for route in script["routes"]:
                for node in route["nodes"]:
                    if _norm(node["prompt"]) == norm:
                        return route.get("topic")
    order = script_cam_topics(device_id)
    if order:
        n = db.execute("SELECT COUNT(*) FROM captures WHERE device_id=?",
                       (device_id,)).fetchone()[0]
        return order[n % len(order)]
    return None


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
        topic = request.form.get("topic") or resolve_topic(db, device_id, prompt)
        db.execute(
            "INSERT INTO captures (id, device_id, prompt, timestamp, photo_path, topic, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (capture_id, device_id, prompt, timestamp, str(photo_path), topic, time.time())
        )
        db.commit()
    print(f"[photo] {capture_id}  '{prompt}'  {device_id}  topic={topic}")
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

VIEWER_HTML = open(str(BASE_DIR / "viewer.html"), encoding="utf-8").read()

@app.route("/")
def viewer():
    return VIEWER_HTML, 200, {"Content-Type": "text/html"}

@app.route("/api/prompts", methods=["GET"])
def get_prompts():
    device_id = request.args.get("device_id", "lens01")
    with get_db() as db:
        rows = db.execute(
            "SELECT step_type, text, topic FROM steps "
            "WHERE device_id=? ORDER BY order_idx ASC", (device_id,)
        ).fetchall()
    return jsonify({"steps": [{"type": r["step_type"], "text": r["text"],
                               "topic": r["topic"]} for r in rows]})

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
                "INSERT INTO steps (device_id, step_type, text, topic, order_idx) "
                "VALUES (?, ?, ?, ?, ?)",
                (device_id, step.get("type", "camera"), step.get("text", ""),
                 step.get("topic"), i)
            )
        db.commit()
    return jsonify({"ok": True, "count": len(data["steps"]), "device_id": device_id})

ADMIN_HTML   = open(str(BASE_DIR / "admin.html"),  encoding="utf-8").read()
PARENT_HTML  = open(str(BASE_DIR / "parent.html"), encoding="utf-8").read()
EXHIBIT_HTML = open(str(BASE_DIR / "loci-standalone-construct.html"), encoding="utf-8").read()

@app.route("/admin")
@app.route("/admin/<device_id>")
def admin(device_id="lens01"):
    return ADMIN_HTML, 200, {"Content-Type": "text/html"}

@app.route("/parent")
@app.route("/parent/<device_id>")
def parent(device_id="lens01"):
    return PARENT_HTML, 200, {"Content-Type": "text/html"}

# ---------------------------------------------------------------------------
# Exhibition tablet display — installable PWA
# ---------------------------------------------------------------------------
EXHIBIT_MANIFEST = {
    "id": "/exhibit/demo",
    "name": "Loci — Exhibition",
    "short_name": "Loci",
    "description": "A wall of children's wonderings, arriving live from the Loci lens.",
    "start_url": "/exhibit/demo",
    "scope": "/exhibit",
    "display": "fullscreen",
    "orientation": "landscape",
    "background_color": "#FFFDF4",
    "theme_color": "#FFFDF4",
    "icons": [
        {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png",
         "purpose": "any"},
        {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png",
         "purpose": "maskable"},
    ],
}

@app.route("/exhibit/manifest.webmanifest")
def exhibit_manifest():
    resp = jsonify(EXHIBIT_MANIFEST)
    resp.headers["Content-Type"] = "application/manifest+json"
    return resp

@app.route("/exhibit")
@app.route("/exhibit/<device_id>")
def exhibit(device_id="demo"):
    return EXHIBIT_HTML, 200, {"Content-Type": "text/html"}

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
                "topic":     route.get("topic"),
            }
            if node["medium"] == "cam":
                if cam_idx < len(cam_queue):
                    c = cam_queue[cam_idx]
                    n["photo"] = f"/uploads/photos/{Path(c['photo_path']).name}"
                    n["tag"]   = f"{script['child']}'s photo"
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
        out_routes.append({"title": route["title"], "dot": route["dot"],
                           "topic": route.get("topic"), "nodes": out_nodes})

    # flat capture feed for the exhibit wall:
    # {capture_id, topic, prompt, photoUrl, audioUrl, response?}
    topic_order = script_cam_topics(device_id)
    caps_out = []
    for i, c in enumerate(captures):
        topic = c.get("topic")
        if not topic and topic_order:
            topic = topic_order[i % len(topic_order)]
        entry = {
            "capture_id": c["id"],
            "topic":      topic,
            "prompt":     " ".join((c.get("prompt") or "").split()),
            "timestamp":  c.get("timestamp"),
        }
        if c.get("photo_path"):
            entry["photoUrl"] = f"/uploads/photos/{Path(c['photo_path']).name}"
        if c.get("audio_path"):
            entry["audioUrl"] = f"/uploads/audio/{Path(c['audio_path']).name}"
            entry["audioDur"] = format_audio_duration(c["audio_path"])
        caps_out.append(entry)

    return jsonify({"topic": script["topic"], "child": script["child"],
                    "routes": out_routes, "captures": caps_out})


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
