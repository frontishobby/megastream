"""Local scene labeler for MegaStream.

The web app posts scene keyframes (JPEG) to this server while uploading or
scanning videos. Frames are tagged with a WD (waifu-diffusion) booru tagger
and the tags are mapped to coarse sex-position labels; optionally,
low-confidence frames are escalated to a local VLM served by Ollama.

It also generates subtitles on request: the browser streams one decrypted
video into a job, the server transcribes it with faster-whisper and
optionally translates the cues through a local LLM served by Ollama.

Classification is stateless: image in, label out. Subtitle jobs only live
until the browser collects the result. All MEGA access stays in the browser.

Usage:
    pip install -r requirements.txt
    uvicorn server:app --host 127.0.0.1 --port 8756

Environment variables:
    WD_MODEL         HuggingFace repo of the tagger
                     (default: SmilingWolf/wd-eva02-large-tagger-v3)
    VLM_MODEL        Ollama model name for low-confidence escalation
                     (default: disabled)
    OLLAMA_URL       Ollama endpoint (default: http://127.0.0.1:11434)
    VLM_ESCALATE     Escalate to the VLM below this tagger confidence (0.45)
    MIN_CONF         Drop labels below this confidence entirely (0.2)
    WHISPER_MODEL    faster-whisper model for subtitles (default: large-v3)
    TRANSLATE_MODEL  Ollama model for subtitle translation
                     (default: huihui_ai/gemma-4-abliterated:12b,
                     empty disables translation)
"""

import base64
import csv
import gc
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path

import numpy as np
import onnxruntime as ort
import requests
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import hf_hub_download
from PIL import Image

WD_REPO = os.environ.get("WD_MODEL", "SmilingWolf/wd-eva02-large-tagger-v3")
VLM_MODEL = os.environ.get("VLM_MODEL", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MIN_CONF = float(os.environ.get("MIN_CONF", "0.2"))
VLM_ESCALATE = float(os.environ.get("VLM_ESCALATE", "0.45"))
TOP_TAGS = int(os.environ.get("TOP_TAGS", "24"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
TRANSLATE_MODEL = os.environ.get("TRANSLATE_MODEL", "huihui_ai/gemma-4-abliterated:12b")

# Coarse labels the web app displays on scene chips.
LABELS = [
    "missionary",
    "doggy",
    "cowgirl",
    "reverse-cowgirl",
    "spooning",
    "standing",
    "oral",
    "paizuri",
    "handjob",
    "solo",
]

# booru tag -> label. The tagger's vocabulary already contains position tags,
# so classification is just "which position tag scored highest".
POSITION_TAGS = {
    "missionary": "missionary",
    "doggystyle": "doggy",
    "sex_from_behind": "doggy",
    "bent_over": "doggy",
    "cowgirl_position": "cowgirl",
    "girl_on_top": "cowgirl",
    "upright_straddle": "cowgirl",
    "reverse_cowgirl_position": "reverse-cowgirl",
    "spooning": "spooning",
    "standing_sex": "standing",
    "suspended_congress": "standing",
    "fellatio": "oral",
    "irrumatio": "oral",
    "deepthroat": "oral",
    "cunnilingus": "oral",
    "69": "oral",
    "paizuri": "paizuri",
    "handjob": "handjob",
    "masturbation": "solo",
    # NB: "fingering" deliberately unmapped — partner fingering is not solo,
    # and it has no clean position label of its own.
}

# Framing/composition tags returned on every response regardless of the
# top-k cutoff, so the client can score frames for thumbnail selection
# (face + body visible beats close-ups). Order/content is free to tune;
# missing vocabulary entries are skipped at load time.
THUMB_TAGS = [
    "looking_at_viewer",
    "smile",
    "portrait",
    "upper_body",
    "lower_body",
    "full_body",
    "cowboy_shot",
    "close-up",
    "blurry",
    "motion_blur",
    "from_behind",
    "facing_away",
    "looking_back",
    "ass_focus",
    "dark",
    "head_out_of_frame",
    "out_of_frame",
    "profile",
    "1girl",
    "solo",
]

# Make the pip-installed NVIDIA wheels' DLLs findable; without this,
# onnxruntime looks for a system CUDA Toolkit (cublasLt64_12.dll etc.) and
# silently falls back to CPU when it's not installed.
#
# preload_dlls() alone is not enough: cuDNN 9 lazily loads sublibraries
# (cudnn_engines_tensor_ir64_9.dll etc.) by name at inference time, so the
# wheel bin directories must also be on the DLL search path and PATH.
if sys.platform == "win32":
    _nvidia_root = Path(ort.__file__).resolve().parents[1] / "nvidia"
    if _nvidia_root.is_dir():
        for _bin in sorted(_nvidia_root.glob("*/bin")):
            os.add_dll_directory(str(_bin))
            os.environ["PATH"] = str(_bin) + os.pathsep + os.environ.get("PATH", "")
if hasattr(ort, "preload_dlls"):
    try:
        ort.preload_dlls()
    except Exception as err:  # noqa: BLE001 - CPU fallback still works
        print("CUDA DLL preload failed (falling back to CPU):", err)

print(f"Loading tagger {WD_REPO} ...")
_model_path = hf_hub_download(WD_REPO, "model.onnx")
_csv_path = hf_hub_download(WD_REPO, "selected_tags.csv")
_session = ort.InferenceSession(
    _model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
)
_input = _session.get_inputs()[0]
_input_size = int(_input.shape[1]) if isinstance(_input.shape[1], int) else 448
with open(_csv_path, newline="", encoding="utf-8") as f:
    _rows = list(csv.DictReader(f))
_tag_names = [r["name"] for r in _rows]
_general = np.array([r["category"] == "0" for r in _rows])
_thumb_idx = {t: _tag_names.index(t) for t in THUMB_TAGS if t in _tag_names}
print(
    f"Ready: {len(_tag_names)} tags, input {_input_size}px, "
    f"providers {_session.get_providers()}, vlm {VLM_MODEL or 'off'}"
)
if "CUDAExecutionProvider" not in _session.get_providers():
    print("WARNING: running on CPU — classification will be slow.")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def allow_private_network(request: Request, call_next):
    # Chrome sends a local-network-access preflight when the (https) web app
    # calls a localhost server; without this header it gets blocked.
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def preprocess(img: Image.Image, size: int) -> np.ndarray:
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.alpha_composite(img)
    img = bg.convert("RGB")
    w, h = img.size
    side = max(w, h)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(img, ((side - w) // 2, (side - h) // 2))
    square = square.resize((size, size), Image.BICUBIC)
    arr = np.asarray(square, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR
    return np.expand_dims(arr, 0)


def infer_tags(img: Image.Image) -> tuple[dict, dict]:
    """Returns (general tags >= 0.1, thumb-framing tag probs)."""
    arr = preprocess(img, _input_size)
    probs = _session.run(None, {_input.name: arr})[0][0].astype(float)
    out = {}
    for i, p in enumerate(probs):
        if _general[i] and p >= 0.1:
            out[_tag_names[i]] = p
    thumb = {t: float(probs[i]) for t, i in _thumb_idx.items()}
    return out, thumb


# Penetration defines a scene even when oral/hand play is simultaneously
# more prominent in frame (group scenes: she sucks one guy while another is
# inside her — the camera favours the upper body and fellatio outscores the
# position tag). If any intercourse label clears this bar, it wins over
# foreplay labels regardless of their (usually higher) confidence.
INTERCOURSE = {"missionary", "doggy", "cowgirl", "reverse-cowgirl", "spooning", "standing"}
SEX_PRIORITY_MIN = float(os.environ.get("SEX_PRIORITY_MIN", "0.35"))


def pick_position(tags: dict):
    best_label, best_p = None, 0.0
    best_sex, best_sex_p = None, 0.0
    for tag, label in POSITION_TAGS.items():
        p = tags.get(tag, 0.0)
        if p > best_p:
            best_label, best_p = label, p
        if label in INTERCOURSE and p > best_sex_p:
            best_sex, best_sex_p = label, p
    if best_sex is not None and best_sex_p >= SEX_PRIORITY_MIN:
        return best_sex, best_sex_p
    return best_label, best_p


def position_scores(tags: dict) -> dict:
    """Best tag probability per position label — stored client-side so
    priority thresholds and label groupings can be retuned without a
    rescan."""
    out: dict = {}
    for tag, label in POSITION_TAGS.items():
        p = tags.get(tag, 0.0)
        if p > out.get(label, 0.0):
            out[label] = p
    return {k: round(v, 3) for k, v in out.items() if v >= 0.1}


def vlm_classify(jpeg: bytes):
    prompt = (
        "You are labelling frames from an adult video for the owner's "
        "personal library. Classify the sex position shown. Answer with "
        "exactly one of: " + ", ".join(LABELS) + ", none. One word only."
    )
    try:
        res = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": VLM_MODEL,
                "prompt": prompt,
                "images": [base64.b64encode(jpeg).decode()],
                "stream": False,
            },
            timeout=120,
        )
        text = (res.json().get("response") or "").strip().lower()
    except Exception as err:  # noqa: BLE001 - escalation is best-effort
        print("VLM query failed:", err)
        return None, 0.0
    # Longest first so "reverse-cowgirl" wins over its "cowgirl" substring.
    for label in sorted(LABELS, key=len, reverse=True):
        if label in text:
            return label, 0.6
    return None, 0.0


@app.get("/health")
def health():
    return {
        "ok": True,
        "tagger": WD_REPO,
        "vlm": VLM_MODEL or None,
        "subtitles": {"whisper": WHISPER_MODEL, "translate": TRANSLATE_MODEL or None},
    }


@app.post("/classify")
async def classify(request: Request):
    body = await request.body()
    try:
        img = Image.open(io.BytesIO(body))
        img.load()
    except Exception:
        return Response(status_code=400, content="not an image")

    tags, thumb = infer_tags(img)
    position, conf = pick_position(tags)
    source = "wd"
    if VLM_MODEL and (position is None or conf < VLM_ESCALATE):
        v_pos, v_conf = vlm_classify(body)
        if v_pos:
            position, conf, source = v_pos, max(conf, v_conf), "vlm"
    if position is not None and conf < MIN_CONF:
        position, conf = None, 0.0

    top = dict(sorted(tags.items(), key=lambda kv: -kv[1])[:TOP_TAGS])
    top3 = ", ".join(f"{k}:{v:.2f}" for k, v in list(top.items())[:3])
    # Media time supplied by the browser purely for these logs.
    t = request.query_params.get("t")
    at = f" @{float(t):7.1f}s" if t else ""
    print(
        f"classify{at}: {position or 'none'}"
        + (f" ({conf:.2f}, {source})" if position else "")
        + (f" | top tags: {top3}" if top3 else "")
    )
    return {
        "position": position,
        "confidence": round(conf, 3) if position else None,
        "source": source,
        "positions": position_scores(tags),
        "tags": {k: round(v, 3) for k, v in top.items()},
        "thumb": {k: round(v, 3) for k, v in thumb.items()},
    }


# ---------------------------------------------------------------------------
# Subtitles
#
# Chrome can't stream a fetch() request body over plain HTTP/1.1, so a job
# receives the decrypted video as sequential chunk PUTs into a temp file.
# A worker thread then transcribes it with faster-whisper and translates the
# cues through Ollama. Jobs run one at a time, and whisper is unloaded before
# translation starts so the two models never share the GPU.

SUB_LANGS = {"en": "English", "ko": "Korean", "zh": "Simplified Chinese", "ja": "Japanese"}
SUB_DIR = Path(tempfile.gettempdir()) / "megastream-subs"
SUB_DIR.mkdir(parents=True, exist_ok=True)
# Jobs live in memory only, so anything left from a previous run (crash,
# closed window) is an orphan nobody can collect anymore.
for _stale in SUB_DIR.iterdir():
    try:
        _stale.unlink()
    except OSError:
        pass
JOB_TTL = 3600  # idle seconds before a finished, uncollected job is dropped
UPLOAD_TTL = 900  # idle seconds before a half-sent upload (tab closed) is dropped
TRANSLATE_BATCH = 20

# Stock phrases whisper invents over silence and moaning (lots of YouTube
# outros in its training data). Matched case-insensitively as substrings.
HALLUCINATIONS = [
    "ご視聴ありがとうございました",
    "チャンネル登録",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "시청해 주셔서 감사합니다",
    "구독과 좋아요",
    "字幕由",
    "请不吝点赞",
    "订阅",
    "訂閱",
]
# "ああああああああ" / "ha ha ha ha ha ..." loops -> three repeats.
_REPEAT = re.compile(r"(.{1,8}?)\1{4,}")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_work_lock = threading.Lock()
_BUSY = {"queued", "loading", "transcribing", "translating"}


class JobCancelled(Exception):
    pass


def _prune_jobs():
    now = time.time()
    with _jobs_lock:
        for jid, job in list(_jobs.items()):
            ttl = UPLOAD_TTL if job["state"] == "receiving" else JOB_TTL
            if job["state"] not in _BUSY and now - job["touched"] > ttl:
                _jobs.pop(jid)
                _drop_file(job)


def _drop_file(job):
    try:
        job["path"].unlink(missing_ok=True)
    except OSError:
        pass  # still open by the worker on Windows; it cleans up itself


def _job_or_404(jid: str) -> dict:
    job = _jobs.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return job


def _job_status(job: dict) -> dict:
    out = {
        "id": job["id"],
        "state": job["state"],
        "progress": round(job["progress"], 4),
        "language": job["language"],
        "error": job["error"],
        "warning": job["warning"],
    }
    if job["state"] == "done":
        out["tracks"] = job["tracks"]
    return out


def _clean_text(text: str) -> str:
    text = text.strip()
    low = text.lower()
    if any(h in low for h in HALLUCINATIONS):
        return ""
    return _REPEAT.sub(r"\1\1\1", text)


def _transcribe(job: dict):
    from faster_whisper import WhisperModel  # heavy; only needed for subtitles

    if job["cancelled"]:  # deleted while waiting for the previous job
        raise JobCancelled()
    job.update(state="loading", progress=0.0)
    try:
        model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
    except Exception as err:  # noqa: BLE001 - CPU works, just slowly
        print("Whisper on CUDA failed (falling back to CPU):", err)
        model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segments = None
    try:
        job["state"] = "transcribing"
        segments, info = model.transcribe(
            str(job["path"]),
            language=job["source"],
            beam_size=5,
            # VAD skips the long non-speech stretches whisper otherwise fills
            # with hallucinated text; not conditioning on previous text stops
            # one bad cue from looping through the rest of the file.
            vad_filter=True,
            condition_on_previous_text=False,
        )
        cues: list[dict] = []
        for seg in segments:
            if job["cancelled"]:
                raise JobCancelled()
            if info.duration:
                job["progress"] = min(1.0, seg.end / info.duration)
            job["touched"] = time.time()
            if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                continue
            text = _clean_text(seg.text)
            if not text:
                continue
            if cues and cues[-1]["text"] == text and seg.start - cues[-1]["end"] < 1.0:
                cues[-1]["end"] = seg.end
                continue
            cues.append({"start": seg.start, "end": seg.end, "text": text})
        print(
            f"subtitles {job['id'][:8]}: {len(cues)} cues, "
            f"language {info.language} ({info.language_probability:.2f})"
        )
        return cues, info.language
    finally:
        # The segment generator holds the model; both must go to free VRAM.
        del segments
        del model
        gc.collect()


def _raise_ollama(res):
    """raise_for_status, but with Ollama's own error text (e.g. an outdated
    Ollama that doesn't know the model architecture) instead of a bare 500."""
    if res.ok:
        return
    try:
        detail = res.json().get("error") or res.text
    except ValueError:
        detail = res.text
    raise RuntimeError(f"Ollama HTTP {res.status_code}: {detail.strip()[:300]}")


def _ollama_chat(payload: dict) -> str:
    try:
        res = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=300)
    except requests.ConnectionError:
        raise RuntimeError(f"Ollama is not reachable at {OLLAMA_URL}") from None
    if res.status_code == 404:
        raise RuntimeError(f"{TRANSLATE_MODEL} is not installed — run: ollama pull {TRANSLATE_MODEL}")
    _raise_ollama(res)
    return res.json()["message"]["content"]


_pull_lock = threading.Lock()


def _ensure_translate_model():
    """Pulls TRANSLATE_MODEL into Ollama when it isn't there yet."""
    with _pull_lock:
        try:
            res = requests.post(
                f"{OLLAMA_URL}/api/show", json={"model": TRANSLATE_MODEL}, timeout=10
            )
        except requests.ConnectionError:
            raise RuntimeError(f"Ollama is not reachable at {OLLAMA_URL}") from None
        if res.ok:
            return
        print(f"Pulling {TRANSLATE_MODEL} into Ollama (first run, several GB) ...")
        with requests.post(
            f"{OLLAMA_URL}/api/pull",
            json={"model": TRANSLATE_MODEL, "stream": True},
            stream=True,
            timeout=(10, 600),
        ) as pull:
            _raise_ollama(pull)
            shown = -10
            for line in pull.iter_lines():
                if not line:
                    continue
                msg = json.loads(line)
                if msg.get("error"):
                    raise RuntimeError(f"ollama pull failed: {msg['error']}")
                total, done = msg.get("total"), msg.get("completed")
                if total and done and done * 100 // total >= shown + 10:
                    shown = done * 100 // total
                    print(f"  {msg.get('status', 'pulling')}: {shown}%")
        print(f"{TRANSLATE_MODEL} ready")


def _prefetch_translate_model():
    # Background so the tagger is usable while the model downloads.
    try:
        _ensure_translate_model()
    except Exception as err:  # noqa: BLE001 - retried when a job needs it
        print(f"Subtitle translation unavailable for now: {err}")
        print("Install Ollama from https://ollama.com/download to enable it.")


def _translate_batch(lines: list[str], context: list[str], src: str, dst: str):
    """Returns the translated lines, or None when the reply doesn't line up."""
    src_name, dst_name = SUB_LANGS.get(src, src), SUB_LANGS[dst]
    system = (
        "You translate subtitles of an adult video in the owner's private "
        f"library from {src_name} to {dst_name}. Translate faithfully and keep "
        "sexual, explicit and vulgar language exactly as explicit as the "
        "original — never censor, soften, refuse or add notes. Moans, gasps "
        f"and interjections become natural {dst_name} equivalents. Keep lines "
        "short and natural, as subtitles."
    )
    user = (
        f"Translate each of the {len(lines)} entries in `lines` to {dst_name}. "
        "`context` is the dialogue right before them, for reference only. "
        f'Reply as JSON {{"lines": [...]}} with exactly {len(lines)} strings, '
        "in the same order.\n\n"
        + json.dumps({"context": context, "lines": lines}, ensure_ascii=False)
    )
    schema = {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": len(lines),
                "maxItems": len(lines),
            }
        },
        "required": ["lines"],
    }
    content = _ollama_chat(
        {
            "model": TRANSLATE_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": schema,
            "stream": False,
            "keep_alive": "5m",
            "options": {"temperature": 0.2},
        }
    )
    try:
        out = json.loads(content)["lines"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(out, list) or len(out) != len(lines):
        return None
    return [str(t).strip() for t in out]


def _translate(job: dict, texts: list[str], src: str, dst: str) -> list[str]:
    job.update(state="translating", progress=0.0)
    _ensure_translate_model()  # no-op unless Ollama started after us
    out: list[str] = []
    try:
        for i in range(0, len(texts), TRANSLATE_BATCH):
            if job["cancelled"]:
                raise JobCancelled()
            batch = texts[i : i + TRANSLATE_BATCH]
            context = texts[max(0, i - 4) : i]
            lines = _translate_batch(batch, context, src, dst)
            if lines is None:
                lines = _translate_batch(batch, context, src, dst)
            if lines is None:
                # Misaligned twice: fall back to one line per request.
                lines = [(_translate_batch([t], context, src, dst) or [t])[0] for t in batch]
            out.extend(lines)
            job["progress"] = len(out) / len(texts)
            job["touched"] = time.time()
        return out
    finally:
        # Hand the VRAM back right away instead of after keep_alive expires.
        try:
            requests.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": TRANSLATE_MODEL, "keep_alive": 0},
                timeout=10,
            )
        except requests.RequestException:
            pass


def _vtt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}.{ms:03}"


def _to_vtt(cues: list[dict]) -> str:
    parts = ["WEBVTT", ""]
    for c in cues:
        text = c["text"].replace("-->", "->").strip()
        if text:
            parts += [f"{_vtt_time(c['start'])} --> {_vtt_time(c['end'])}", text, ""]
    return "\n".join(parts)


def _run_job(job: dict):
    try:
        with _work_lock:
            cues, lang = _transcribe(job)
            job["language"] = lang
            tracks = [{"lang": lang, "translated": False, "vtt": _to_vtt(cues)}]
            target = job["target"]
            if target and target != lang and cues:
                if not TRANSLATE_MODEL:
                    job["warning"] = "Translation is disabled on the server (TRANSLATE_MODEL)"
                else:
                    try:
                        texts = _translate(job, [c["text"] for c in cues], lang, target)
                        translated = [{**c, "text": t} for c, t in zip(cues, texts)]
                        tracks.append({"lang": target, "translated": True, "vtt": _to_vtt(translated)})
                    except JobCancelled:
                        raise
                    except Exception as err:  # noqa: BLE001 - keep the transcript
                        print("Subtitle translation failed:")
                        traceback.print_exc()
                        job["warning"] = f"Translation failed: {err}"
        job.update(tracks=tracks, state="done", progress=1.0)
    except JobCancelled:
        job.update(state="error", error="cancelled")
    except Exception as err:  # noqa: BLE001 - reported to the browser
        print("Subtitle job failed:", err)
        job.update(state="error", error=str(err) or type(err).__name__)
    finally:
        job["touched"] = time.time()
        _drop_file(job)


@app.post("/subtitles/jobs")
async def create_subtitle_job(request: Request):
    body = await request.json()
    _prune_jobs()
    jid = uuid.uuid4().hex
    path = SUB_DIR / f"{jid}.bin"
    path.write_bytes(b"")
    job = {
        "id": jid,
        "path": path,
        "received": 0,
        # Anything outside the supported set means auto-detect / no translation.
        "source": body.get("source") if body.get("source") in SUB_LANGS else None,
        "target": body.get("target") if body.get("target") in SUB_LANGS else None,
        "state": "receiving",
        "progress": 0.0,
        "language": None,
        "error": None,
        "warning": None,
        "tracks": None,
        "cancelled": False,
        "touched": time.time(),
    }
    with _jobs_lock:
        _jobs[jid] = job
    return {"id": jid}


@app.put("/subtitles/jobs/{jid}/data")
async def put_subtitle_data(jid: str, offset: int, request: Request):
    job = _job_or_404(jid)
    if job["state"] != "receiving":
        raise HTTPException(status_code=409, detail="job is not receiving data")
    if offset != job["received"]:
        return JSONResponse(status_code=409, content={"received": job["received"]})
    try:
        with open(job["path"], "ab") as f:
            async for chunk in request.stream():
                f.write(chunk)
                job["received"] += len(chunk)
    except Exception:
        # Roll back a half-written chunk so the browser can resend it whole.
        os.truncate(job["path"], offset)
        job["received"] = offset
        raise
    job["touched"] = time.time()
    return {"received": job["received"]}


@app.post("/subtitles/jobs/{jid}/start")
def start_subtitle_job(jid: str):
    job = _job_or_404(jid)
    if job["state"] != "receiving":
        raise HTTPException(status_code=409, detail="job already started")
    job.update(state="queued", touched=time.time())
    threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    return _job_status(job)


@app.get("/subtitles/jobs/{jid}")
def get_subtitle_job(jid: str):
    job = _job_or_404(jid)
    job["touched"] = time.time()
    return _job_status(job)


@app.delete("/subtitles/jobs/{jid}")
def delete_subtitle_job(jid: str):
    with _jobs_lock:
        job = _jobs.pop(jid, None)
    if job is not None:
        job["cancelled"] = True
        _drop_file(job)
    return {"ok": True}


if TRANSLATE_MODEL:
    threading.Thread(target=_prefetch_translate_model, daemon=True).start()


def _prune_loop():
    # Abandoned uploads must go even when no further job ever comes in.
    while True:
        time.sleep(60)
        _prune_jobs()


threading.Thread(target=_prune_loop, daemon=True).start()
