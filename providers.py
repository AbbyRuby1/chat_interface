"""Provider adapters: Ollama, LM Studio, OpenAI-compatible APIs, Anthropic.

All providers are exposed through a single async streaming interface:

    stream_chat(provider, model, messages, api_key) -> AsyncIterator[str]

and a model-listing helper:

    list_models(provider, base_url, api_key) -> list[str]

Providers supported:
  - "ollama"     : local Ollama server        (default http://localhost:11434)
  - "lmstudio"   : LM Studio local server      (default http://localhost:1234/v1)
  - "openai"     : api.openai.com or any custom OpenAI-compatible base URL
  - "anthropic"  : Anthropic API (api.anthropic.com)
"""

import json
import sys
from typing import AsyncIterator

import httpx


def _is_local(hostname: str) -> bool:
    return hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0")


def _trust_env_for(url: str) -> bool:
    """Only honour HTTP(S)_PROXY env vars for non-local endpoints.

    Without this, a system-wide proxy (common on corporate Windows machines
    and some Debian setups) would intercept requests to localhost Ollama /
    LM Studio servers and break them.
    """
    try:
        host = httpx.URL(url).host or ""
    except Exception:  # noqa: BLE001
        return True
    return not _is_local(str(host))


DEFAULT_BASE_URLS = {
    "ollama": "http://127.0.0.1:11434" if sys.platform == "win32" else "http://localhost:11434",
    "lmstudio": ("http://127.0.0.1:1234/v1" if sys.platform == "win32" else "http://localhost:1234/v1"),
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
}


def _norm_base(provider: str, base_url: str | None) -> str:
    base = (base_url or DEFAULT_BASE_URLS[provider]).rstrip("/")
    # Tolerate users pasting the URL with a trailing /chat/completions
    for suffix in ("/chat/completions", "/api/chat", "/v1"):
        if base.endswith(suffix) and provider != "anthropic":
            base = base[: -len(suffix)].rstrip("/")
    return base


# --- Model discovery ---------------------------------------------------------


async def list_models(provider: str, base_url: str | None = None,
                      api_key: str | None = None) -> list[str]:
    base = _norm_base(provider, base_url)
    async with httpx.AsyncClient(timeout=8, trust_env=_trust_env_for(base)) as client:
        if provider == "ollama":
            r = await client.get(f"{base}/api/tags")
            r.raise_for_status()
            return [m["name"] for m in r.json().get("models", [])]

        if provider == "lmstudio":
            # LM Studio exposes an OpenAI-compatible /v1/models endpoint
            r = await client.get(f"{base}/models")
            r.raise_for_status()
            return [m["id"] for m in r.json().get("data", [])]

        if provider == "openai":
            # Ensure the base ends with /v1 for OpenAI-style endpoints unless it
            # already carries an explicit path (e.g. a proxy route).
            if not base.endswith("/v1") and "://" in base:
                rest = base.split("://", 1)[1]
                if "/" not in rest:
                    base += "/v1"
            headers = {"Authorization": f"Bearer {api_key or ''}"}
            r = await client.get(f"{base}/models", headers=headers)
            r.raise_for_status()
            return sorted(m["id"] for m in r.json().get("data", []))

        if provider == "anthropic":
            headers = {
                "x-api-key": api_key or "",
                "anthropic-version": "2023-06-01",
            }
            r = await client.get(f"{base}/v1/models", headers=headers)
            r.raise_for_status()
            return [m["id"] for m in r.json().get("data", [])]

    raise ValueError(f"Unknown provider: {provider}")


# --- Streaming chat ----------------------------------------------------------


async def stream_chat(provider: str, model: str, messages: list[dict],
                      api_key: str | None = None,
                      base_url: str | None = None) -> AsyncIterator[str]:
    """Yield text deltas from the chosen provider."""
    base = _norm_base(provider, base_url)

    if provider == "ollama":
        async for chunk in _stream_ollama(base, model, messages):
            yield chunk
        return

    if provider == "anthropic":
        async for chunk in _stream_anthropic(base, model, messages, api_key):
            yield chunk
        return

    # lmstudio / openai both use the OpenAI-compatible streaming format
    async for chunk in _stream_openai_compat(base, model, messages, api_key):
        yield chunk


async def _stream_ollama(base: str, model: str, messages: list[dict]) -> AsyncIterator[str]:
    payload = {"model": model, "messages": messages, "stream": True}
    url = f"{base}/api/chat"
    async with httpx.AsyncClient(timeout=None, trust_env=_trust_env_for(url)) as client:
        async with client.stream("POST", url, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                data = json.loads(line)
                token = data.get("message", {}).get("content", "")
                if token:
                    yield token
                if data.get("done"):
                    break


async def _stream_openai_compat(base: str, model: str, messages: list[dict],
                                api_key: str | None) -> AsyncIterator[str]:
    # Ensure the base ends with /v1 for OpenAI-style endpoints unless it
    # already carries an explicit path (e.g. a proxy route).
    if not base.endswith("/v1") and "://" in base:
        rest = base.split("://", 1)[1]
        if "/" not in rest:
            base += "/v1"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": model, "messages": messages, "stream": True}
    url = f"{base}/chat/completions"
    async with httpx.AsyncClient(timeout=None, trust_env=_trust_env_for(url)) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (KeyError, IndexError, json.JSONDecodeError):
                    continue
                if delta:
                    yield delta


async def _stream_anthropic(base: str, model: str, messages: list[dict],
                            api_key: str | None) -> AsyncIterator[str]:
    headers = {
        "x-api-key": api_key or "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    # system message must be pulled out for the Anthropic API
    system = "\n".join(m["content"] for m in messages if m["role"] == "system")
    conv = [m for m in messages if m["role"] != "system"]
    payload = {"model": model, "max_tokens": 4096, "messages": conv, "stream": True}
    if system:
        payload["system"] = system

    url = f"{base}/v1/messages"
    async with httpx.AsyncClient(timeout=None, trust_env=_trust_env_for(url)) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            resp.raise_for_status()
            event = None
            async for line in resp.aiter_lines():
                line = line.rstrip("\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    try:
                        data = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    if event == "content_block_delta":
                        token = data.get("delta", {}).get("text", "")
                        if token:
                            yield token
                    elif event == "message_stop":
                        break
