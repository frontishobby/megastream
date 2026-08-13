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
    "fingering": "solo",
}

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


def pick_position(tags: dict):
    best_label, best_p = None, 0.0
    for tag, label in POSITION_TAGS.items():
        p = tags.get(tag, 0.0)
        if p > best_p:
            best_label, best_p = label, p
    return best_label, best_p


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
    return {
        "position": position,
        "confidence": round(conf, 3) if position else None,
        "source": source,
        "tags": {k: round(v, 3) for k, v in top.items()},
    }
