"""Local scene labeler for MegaStream.

The web app posts scene keyframes (JPEG) to this server while uploading or
scanning videos. Frames are tagged with a WD (waifu-diffusion) booru tagger
and the tags are mapped to coarse sex-position labels; optionally,
low-confidence frames are escalated to a local VLM served by Ollama.

The server is stateless: image in, label out. All MEGA access stays in the
browser.

Usage:
    pip install -r requirements.txt
    uvicorn server:app --host 127.0.0.1 --port 8756

Environment variables:
    WD_MODEL      HuggingFace repo of the tagger
                  (default: SmilingWolf/wd-eva02-large-tagger-v3)
    VLM_MODEL     Ollama model name for low-confidence escalation
                  (default: disabled)
    OLLAMA_URL    Ollama endpoint (default: http://127.0.0.1:11434)
    VLM_ESCALATE  Escalate to the VLM below this tagger confidence (0.45)
    MIN_CONF      Drop labels below this confidence entirely (0.2)
"""

import base64
import csv
import io
import os
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import requests
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import hf_hub_download
from PIL import Image

WD_REPO = os.environ.get("WD_MODEL", "SmilingWolf/wd-eva02-large-tagger-v3")
VLM_MODEL = os.environ.get("VLM_MODEL", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MIN_CONF = float(os.environ.get("MIN_CONF", "0.2"))
VLM_ESCALATE = float(os.environ.get("VLM_ESCALATE", "0.45"))
TOP_TAGS = int(os.environ.get("TOP_TAGS", "24"))

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


def infer_tags(img: Image.Image) -> dict:
    arr = preprocess(img, _input_size)
    probs = _session.run(None, {_input.name: arr})[0][0].astype(float)
    out = {}
    for i, p in enumerate(probs):
        if _general[i] and p >= 0.1:
            out[_tag_names[i]] = p
    return out


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
    return {"ok": True, "tagger": WD_REPO, "vlm": VLM_MODEL or None}


@app.post("/classify")
async def classify(request: Request):
    body = await request.body()
    try:
        img = Image.open(io.BytesIO(body))
        img.load()
    except Exception:
        return Response(status_code=400, content="not an image")

    tags = infer_tags(img)
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
    }
