"""Claude-style Chat UI - FastAPI backend.

Works with local LLM runtimes (Ollama, LM Studio) and hosted APIs
(OpenAI / any OpenAI-compatible endpoint, Anthropic).

Run with:  uvicorn main:app --reload
Then open: http://localhost:8000
"""

import asyncio
import json
import os
import sys
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


def _default_provider() -> str:
    """Pick a sensible default provider for this OS (overridable via env)."""
    env = os.environ.get("DEFAULT_PROVIDER")
    if env:
        return env
    # LM Studio's local server defaults to Windows/macOS; Ollama to Linux.
    return "lmstudio" if sys.platform == "win32" else "ollama"


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str
    provider: str | None = None       # ollama | lmstudio | openai | anthropic
    api_key: str | None = None        # only needed for openai / anthropic
    base_url: str | None = None       # custom endpoint (e.g. http://192.168.1.5:1234/v1)


class ModelsRequest(BaseModel):
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None


# --- Routes -----------------------------------------------------------------


@app.get("/api/config")
async def config():
    """Server info used by the frontend to pick OS-appropriate defaults."""
    return {
        "os": "windows" if sys.platform == "win32" else "posix",
        "default_provider": _default_provider(),
        "defaults": DEFAULT_BASE_URLS,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    provider = req.provider or _default_provider()
    if provider not in DEFAULT_BASE_URLS:
        raise HTTPException(400, f"Unknown provider: {provider}")

    needs_key = provider in ("openai", "anthropic")
    if needs_key and not req.api_key:
        raise HTTPException(400, f"An API key is required for the '{provider}' provider.")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    async def sse():
        try:
            async for token in stream_chat(
                provider=provider,
                model=req.model,
                messages=messages,
                api_key=req.api_key,
                base_url=req.base_url,
            ):
                yield f"data: {json.dumps({'text': token})}\n\n"
                # Yield control back to the event loop every token. This keeps
                # streaming responsive on Python's Proactor event loop (the
                # default asyncio loop on Windows), where many small socket
                # writes without yields can stall other requests.
                await asyncio.sleep(0)
            yield "data: [DONE]\n\n"
        except httpx.HTTPStatusError as e:
            detail = f"Provider returned {e.response.status_code}: " \
                     f"{e.response.text[:300]}"
            yield f"data: {json.dumps({'error': detail})}\n\n"
        except httpx.HTTPError as e:
            detail = (
                f"Could not reach the {provider} server. "
                f"Make sure it's running at {req.base_url or DEFAULT_BASE_URLS[provider]} "
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
    provider = req.provider or _default_provider()
    if provider not in DEFAULT_BASE_URLS:
        raise HTTPException(400, f"Unknown provider: {provider}")
    try:
        names = await list_models(provider, req.base_url, req.api_key)
        return {"models": names}
    except httpx.HTTPError as e:
        raise HTTPException(
            502,
            f"Could not reach {req.base_url or DEFAULT_BASE_URLS[provider]} ({type(e).__name__}). "
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
