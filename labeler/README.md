# MegaStream scene labeler

Local inference server for position-labelling scene keyframes. The web app
detects scenes in the browser, captures a keyframe per scene, and posts it
here; the label is written back into the `.scenes.json` sidecar on MEGA by
the browser. This server never touches MEGA.

## Setup (Windows, NVIDIA GPU)

Double-click `run.bat` (or run it from a terminal). It creates the venv,
installs dependencies on first run (and whenever `requirements.txt`
changes), and starts the server. Manual equivalent:

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

## Subtitles

The video page's subtitle button sends that one video here; the server
transcribes it with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(`large-v3`, ~3 GB download on first use) and, when the "Also translate to"
language in the Scene AI header menu differs from the spoken one, translates
the cues through [Ollama](https://ollama.com/download) (install it once; the
server pulls `huihui_ai/gemma-4-abliterated:12b` into it by itself on start).

Whisper is unloaded before translation starts and the translator right
after, so the two never share the GPU (peak ~10 GB on top of the tagger).
The browser stores the tracks as `.megastream/<nodeId>.sub.<lang>.vtt`.

## API

- `GET /health` → `{ ok, tagger, vlm }`
- `POST /classify` (raw JPEG body) →
  `{ position, confidence, source, tags }` — `position` is one of
  missionary / doggy / cowgirl / reverse-cowgirl / spooning / standing /
  oral / paizuri / handjob / solo, or `null` when unsure.

- `POST /subtitles/jobs` (`{ source, target }`) → `{ id }`, then
  `PUT /subtitles/jobs/{id}/data?offset=N` (raw video bytes, in order),
  `POST /subtitles/jobs/{id}/start`, poll `GET /subtitles/jobs/{id}` until
  `state` is `done` (carries `tracks: [{ lang, translated, vtt }]`) or
  `error`, and `DELETE /subtitles/jobs/{id}` to clean up.

Config via env vars: `WD_MODEL`, `VLM_MODEL`, `OLLAMA_URL`, `VLM_ESCALATE`,
`MIN_CONF`, `WHISPER_MODEL`, `TRANSLATE_MODEL` (see `server.py` docstring).
