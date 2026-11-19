# chat_interface

A Claude-desktop-style chat UI with a FastAPI backend that works with
**local runtimes (Ollama, LM Studio)** and **hosted APIs (OpenAI-compatible, Anthropic)**.

## Run

```bash
pip install -r requirements.txt
uvicorn main:app --reload
# open http://localhost:8000
```

## Providers

Pick one in the **⚙ Settings** modal (bottom-left of the sidebar or top bar):

| Provider            | Default base URL                | Auth     | Notes |
|---------------------|---------------------------------|----------|-------|
| Ollama              | `http://localhost:11434`        | none     | Models auto-loaded from `/api/tags` |
| LM Studio           | `http://localhost:1234/v1`      | none     | Enable "Local Server" in LM Studio |
| OpenAI-compatible   | `https://api.openai.com/v1`     | API key  | Works with any OpenAI-style endpoint via custom base URL |
| Anthropic           | `https://api.anthropic.com`     | API key  | Uses streaming `/v1/messages` |

- The model dropdown is populated by **Test & load models**, or type a model name manually.
- API keys are stored only in your browser's localStorage and forwarded per-request to the local backend — nothing is written to disk on the server.
- You can point Ollama/LM Studio at another machine via the Base URL field (e.g. `http://192.168.1.20:1234/v1`).

## Files

- `main.py` — FastAPI app (`/api/chat` SSE stream, `/api/models` discovery)
- `providers.py` — adapters for Ollama / LM Studio / OpenAI / Anthropic streaming
- `static/` — the Claude-style frontend (HTML/CSS/JS, no build step)
