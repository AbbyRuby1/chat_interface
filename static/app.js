/* Claude-style chat frontend — talks to the FastAPI /api/chat SSE endpoint.
   Supports Ollama, LM Studio, OpenAI-compatible and Anthropic providers. */

const el = {
  sidebar: document.getElementById("sidebar"),
  history: document.getElementById("history"),
  emptyState: document.getElementById("emptyState"),
  messages: document.getElementById("messages"),
  chatScroll: document.getElementById("chatScroll"),
  input: document.getElementById("input"),
  form: document.getElementById("composerForm"),
  sendBtn: document.getElementById("sendBtn"),
  greeting: document.getElementById("greeting"),
  modelSelect: document.getElementById("modelSelect"),
  // settings modal
  modal: document.getElementById("settingsModal"),
  providerGrid: document.getElementById("providerGrid"),
  baseUrlInput: document.getElementById("baseUrlInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  keyRow: document.getElementById("keyRow"),
  modelManual: document.getElementById("modelManual"),
  modalStatus: document.getElementById("modalStatus"),
  providerLabel: document.getElementById("providerLabel"),
  providerBadge: document.getElementById("providerBadge"),
};

const PROVIDER_DEFAULTS = {
  ollama:     { label: "Ollama",       badge: "local", url: "http://localhost:11434", needsKey: false },
  lmstudio:   { label: "LM Studio",    badge: "local", url: "http://localhost:1234/v1", needsKey: false },
  openai:     { label: "OpenAI-compat",badge: "api",   url: "https://api.openai.com/v1", needsKey: true },
  anthropic:  { label: "Anthropic",    badge: "api",   url: "https://api.anthropic.com", needsKey: true },
};

// ---------- state ----------
let conversations = JSON.parse(localStorage.getItem("chats") || "[]");
let currentId = null;
let busy = false;

let settings = JSON.parse(localStorage.getItem("settings") || "null") || {
  provider: "ollama",
  baseUrl: "",        // blank = use default
  apiKeys: {},        // per-provider keys, kept in browser localStorage
  model: "",          // last chosen model
};

function persistSettings() {
  localStorage.setItem("settings", JSON.stringify(settings));
}

// Greeting based on time of day, like Claude does
(function setGreeting() {
  const h = new Date().getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  el.greeting.textContent = `Good ${part}, how can I help you today?`;
})();

// ---------- helpers ----------
function save() {
  localStorage.setItem("chats", JSON.stringify(conversations));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function renderHistory() {
  el.history.innerHTML = "";
  for (const c of conversations.slice().reverse()) {
    const b = document.createElement("button");
    b.className = "history-item" + (c.id === currentId ? " active" : "");
    b.textContent = c.title;
    b.onclick = () => openChat(c.id);
    el.history.appendChild(b);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* Minimal markdown: code blocks, inline code, bold, lists, paragraphs */
function renderMarkdown(text) {
  const parts = text.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // code block — first line may be a language tag
      const nl = parts[i].indexOf("\n");
      const code = nl === -1 ? "" : parts[i].slice(nl + 1);
      html += `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
    } else {
      let t = escapeHtml(parts[i]);
      t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      const blocks = t.split(/\n{2,}/).filter(Boolean);
      for (const block of blocks) {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          html += "<ul>" + lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, "")}</li>`).join("") + "</ul>";
        } else if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
          html += "<ol>" + lines.map((l) => `<li>${l.replace(/^\s*\d+\.\s+/, "")}</li>`).join("") + "</ol>";
        } else {
          html += `<p>${block.replace(/\n/g, "<br/>")}</p>`;
        }
      }
    }
  }
  return html;
}

function addMessage(role, content) {
  el.emptyState.style.display = "none";
  el.messages.classList.add("visible");

  const wrap = document.createElement("div");
  if (role === "user") {
    wrap.className = "msg-user";
    wrap.innerHTML = `<div class="bubble"></div>`;
    wrap.querySelector(".bubble").textContent = content;
  } else {
    wrap.className = "msg-assistant";
    wrap.innerHTML = `<div class="assistant-mark">✳</div><div class="assistant-body"></div>`;
  }
  el.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function scrollToBottom() {
  el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
}

// ---------- chat flows ----------
function newChat() {
  currentId = null;
  el.messages.innerHTML = "";
  el.messages.classList.remove("visible");
  el.emptyState.style.display = "";
  el.input.value = "";
  autoGrow();
  renderHistory();
  el.input.focus();
}

function openChat(id) {
  const c = conversations.find((x) => x.id === id);
  if (!c) return;
  currentId = id;
  el.emptyState.style.display = "none";
  el.messages.classList.add("visible");
  el.messages.innerHTML = "";
  for (const m of c.messages) addMessage(m.role, m.content);
  renderHistory();
}

function usePrompt(chip) {
  el.input.value = chip.textContent.replace(/…$/, "") + " ";
  el.input.focus();
  autoGrow();
}

function toggleSidebar() {
  el.sidebar.classList.toggle("hidden");
}

async function send() {
  const text = el.input.value.trim();
  if (!text || busy) return;
  busy = true;
  el.sendBtn.disabled = true;

  // Start a new conversation if needed
  if (!currentId) {
    currentId = uid();
    conversations.push({ id: currentId, title: text.slice(0, 40), messages: [] });
  }
  const conv = conversations.find((c) => c.id === currentId);
  conv.messages.push({ role: "user", content: text });
  save();
  renderHistory();

  el.input.value = "";
  autoGrow();
  addMessage("user", text);

  // Placeholder with thinking dots
  const assistantWrap = addMessage("assistant", "");
  const body = assistantWrap.querySelector(".assistant-body");
  body.innerHTML = `<span class="thinking-dots"><span></span><span></span><span></span></span>`;

  let full = "";
  let streamError = null;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: conv.messages,
        model: el.modelSelect.value || settings.model,
        provider: settings.provider,
        api_key: settings.apiKeys[settings.provider] || null,
        base_url: settings.baseUrl || null,
      }),
    });
    if (!res.ok) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    body.innerHTML = `<span class="cursor-blink"></span>`;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) { streamError = obj.error; continue; }
          full += obj.text;
        } catch (_) {}
        body.innerHTML = renderMarkdown(full) + `<span class="cursor-blink"></span>`;
        scrollToBottom();
      }
    }
  } catch (err) {
    streamError = String(err.message || err);
  }

  if (streamError && !full) {
    body.innerHTML = `<p class="error-note">⚠️ ${escapeHtml(streamError)}<br/>` +
      `Check your provider in <a href="#" onclick="openSettings();return false;">Settings</a>.</p>`;
    // remove failed assistant turn from history so retry is clean
    busy = false;
    el.sendBtn.disabled = false;
    el.input.focus();
    return;
  }

  body.innerHTML = renderMarkdown(full) +
    (streamError ? `<p class="error-note">⚠️ Stream interrupted: ${escapeHtml(streamError)}</p>` : "");
  conv.messages.push({ role: "assistant", content: full });
  save();
  busy = false;
  el.sendBtn.disabled = false;
  el.input.focus();
}

// ---------- provider settings ----------
function openSettings() {
  el.modal.style.display = "flex";
  highlightProvider();
  el.baseUrlInput.value = settings.baseUrl || "";
  el.apiKeyInput.value = settings.apiKeys[settings.provider] || "";
  el.modelManual.value = settings.model || "";
  el.modalStatus.textContent = "";
  el.keyRow.style.display = PROVIDER_DEFAULTS[settings.provider].needsKey ? "" : "none";
}

function closeSettings() {
  el.modal.style.display = "none";
}

function highlightProvider() {
  document.querySelectorAll(".provider-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.provider === settings.provider);
  });
  const d = PROVIDER_DEFAULTS[settings.provider];
  el.providerLabel.textContent = d.label;
  el.providerBadge.textContent = d.badge;
  el.baseUrlInput.placeholder = d.url;
  el.keyRow.style.display = d.needsKey ? "" : "none";
}

document.querySelectorAll(".provider-card").forEach((card) => {
  card.addEventListener("click", () => {
    settings.provider = card.dataset.provider;
    highlightProvider();
    el.modalStatus.textContent = "";
  });
});

async function loadModels() {
  el.modalStatus.textContent = "Connecting…";
  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: settings.provider,
        api_key: settings.apiKeys[settings.provider] || null,
        base_url: el.baseUrlInput.value.trim() || settings.baseUrl || null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const { models } = await res.json();
    if (!models.length) throw new Error("No models found. Pull one in Ollama or load one in LM Studio first.");

    settings.baseUrl = el.baseUrlInput.value.trim();
    persistSettings();

    el.modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      el.modelSelect.appendChild(opt);
    }
    if (models.includes(settings.model)) el.modelSelect.value = settings.model;
    else settings.model = models[0], el.modelSelect.value = models[0];

    el.modalStatus.textContent = `✓ Connected — ${models.length} model(s) loaded.`;
  } catch (e) {
    el.modelSelect.innerHTML = `<option value="">${escapeHtml(el.modelManual.value || "manual model")}</option>`;
    el.modalStatus.textContent = `✗ ${e.message}`;
  }
}

function saveSettings() {
  settings.baseUrl = el.baseUrlInput.value.trim();
  const key = el.apiKeyInput.value.trim();
  if (key) settings.apiKeys[settings.provider] = key;
  const manual = el.modelManual.value.trim();
  if (manual) {
    settings.model = manual;
    const exists = [...el.modelSelect.options].some((o) => o.value === manual);
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = manual;
      opt.textContent = manual;
      el.modelSelect.appendChild(opt);
    }
    el.modelSelect.value = manual;
  }
  persistSettings();
  closeSettings();
}

el.modal.addEventListener("click", (e) => {
  if (e.target === el.modal) closeSettings();
});

el.modelSelect.addEventListener("change", () => {
  settings.model = el.modelSelect.value;
  persistSettings();
});

// ---------- composer wiring ----------
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});

el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
}
el.input.addEventListener("input", autoGrow);

renderHistory();

// On load: ask the backend which provider default fits this OS
// (LM Studio is common on Windows, Ollama on Linux/Debian), then apply it
// only if the user hasn't explicitly configured a provider before.
(async function initConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const cfg = await res.json();
      const hadSaved = localStorage.getItem("settings") !== null;
      if (!hadSaved && cfg.default_provider && PROVIDER_DEFAULTS[cfg.default_provider]) {
        settings.provider = cfg.default_provider;
      }
    }
  } catch (_) {
    /* backend config endpoint unavailable — keep bundled default */
  }
  highlightProvider();

  // If we have a saved model, try to populate the picker from the provider.
  if (settings.model) {
    el.modelSelect.innerHTML = `<option value="${escapeHtml(settings.model)}">${escapeHtml(settings.model)}</option>`;
  }
  try {
    await loadModels();
  } catch (_) {
    /* offline / provider not running — manual model still selectable */
  }
})();
