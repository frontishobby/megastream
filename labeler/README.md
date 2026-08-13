# MegaStream scene labeler

Local inference server for position-labelling scene keyframes. The web app
detects scenes in the browser, captures a keyframe per scene, and posts it
here; the label is written back into the `.scenes.json` sidecar on MEGA by
the browser. This server never touches MEGA.

## Setup (Windows, NVIDIA GPU)

```
cd labeler
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8756
```

First start downloads the tagger model (~1.2 GB) from HuggingFace.
`onnxruntime-gpu` needs CUDA 12; without a GPU, install `onnxruntime`
instead (CPU works, just slower).

Keep it running while uploading or scanning in the web app — the app probes
`http://127.0.0.1:8756/health` and uses the labeler automatically when it
responds. Chrome may ask once to allow the site to access local devices.

## Optional VLM escalation

Frames the tagger is unsure about can be re-checked by a local VLM through
[Ollama](https://ollama.com):

```
set VLM_MODEL=<ollama vision model name>
uvicorn server:app --host 127.0.0.1 --port 8756
```

Pick an NSFW-capable vision model — mainstream VLMs refuse these frames.

## API

- `GET /health` → `{ ok, tagger, vlm }`
- `POST /classify` (raw JPEG body) →
  `{ position, confidence, source, tags }` — `position` is one of
  missionary / doggy / cowgirl / reverse-cowgirl / spooning / standing /
  oral / paizuri / handjob / solo, or `null` when unsure.

Config via env vars: `WD_MODEL`, `VLM_MODEL`, `OLLAMA_URL`, `VLM_ESCALATE`,
`MIN_CONF` (see `server.py` docstring).
