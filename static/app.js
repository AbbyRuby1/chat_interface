/* Claude-style chat frontend — talks to the FastAPI /api/chat SSE endpoint. */

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
};

// ---------- state ----------
let conversations = JSON.parse(localStorage.getItem("chats") || "[]");
let currentId = null;
let busy = false;

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
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conv.messages, model: el.modelSelect.value }),
    });

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
          full += JSON.parse(payload).text;
        } catch (_) {}
        body.innerHTML = renderMarkdown(full) + `<span class="cursor-blink"></span>`;
        scrollToBottom();
      }
    }
  } catch (err) {
    full = full || "⚠️ Something went wrong talking to the backend. Is uvicorn running?";
  }

  body.innerHTML = renderMarkdown(full);
  conv.messages.push({ role: "assistant", content: full });
  save();
  busy = false;
  el.sendBtn.disabled = false;
  el.input.focus();
}

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
