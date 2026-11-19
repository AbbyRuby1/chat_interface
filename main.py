"""Claude-style Chat UI - FastAPI backend.

Works with local LLM runtimes (Ollama, LM Studio) and hosted APIs
(OpenAI / any OpenAI-compatible endpoint, Anthropic).

Run with:  uvicorn main:app --reload
Then open: http://localhost:8000
"""

import json
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from providers import DEFAULT_BASE_URLS, list_models, stream_chat

app = FastAPI(title="Claude-style Chat")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str
    provider: str = "ollama"          # ollama | lmstudio | openai | anthropic
    api_key: str | None = None        # only needed for openai / anthropic
    base_url: str | None = None       # custom endpoint (e.g. http://192.168.1.5:1234/v1)


class ModelsRequest(BaseModel):
    provider: str = "ollama"
    api_key: str | None = None
    base_url: str | None = None


# --- Routes -----------------------------------------------------------------


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if req.provider not in DEFAULT_BASE_URLS:
        raise HTTPException(400, f"Unknown provider: {req.provider}")

    needs_key = req.provider in ("openai", "anthropic")
    if needs_key and not req.api_key:
        raise HTTPException(400, f"An API key is required for the '{req.provider}' provider.")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    async def sse():
        try:
            async for token in stream_chat(
                provider=req.provider,
                model=req.model,
                messages=messages,
                api_key=req.api_key,
                base_url=req.base_url,
            ):
                yield f"data: {json.dumps({'text': token})}\n\n"
            yield "data: [DONE]\n\n"
        except httpx.HTTPStatusError as e:
            detail = f"Provider returned {e.response.status_code}: " \
                     f"{e.response.text[:300]}"
            yield f"data: {json.dumps({'error': detail})}\n\n"
        except httpx.HTTPError as e:
            detail = (
                f"Could not reach the {req.provider} server. "
                f"Make sure it's running at {req.base_url or DEFAULT_BASE_URLS[req.provider]} "
                f"({type(e).__name__})."
            )
            yield f"data: {json.dumps({'error': detail})}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/models")
async def models(req: ModelsRequest):
    """Fetch available models from the configured provider."""
    if req.provider not in DEFAULT_BASE_URLS:
        raise HTTPException(400, f"Unknown provider: {req.provider}")
    try:
        names = await list_models(req.provider, req.base_url, req.api_key)
        return {"models": names}
    except httpx.HTTPError as e:
        raise HTTPException(
            502,
            f"Could not reach {req.base_url or DEFAULT_BASE_URLS[req.provider]} ({type(e).__name__}). "
            "Check that the server is running and CORS/URL are correct.",
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))


@app.get("/health")
async def health():
    return {"status": "ok", "time": time.time()}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
