const $ = (id) => document.getElementById(id);

const chatEl = $("chat");
const optionsEl = $("options");
const statusEl = $("status");
const threadEl = $("thread");
const timelineEl = $("timeline");
const sessionHintEl = $("sessionHint");
const profileEl = $("profile");
const strategyEl = $("strategy");
const youSentEl = $("youSent");
const themReplyEl = $("themReply");
const threadTitleEl = $("threadTitle");

let sessionId = null;

function setStatus(s){
  statusEl.textContent = s;
  statusEl.style.color =
    s === "done" ? "#22c55e" :
    String(s).includes("repair") || String(s).includes("parse") ? "#f59e0b" :
    s === "error" ? "#ef4444" : "#8b93a7";
}

function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function addTimeline(kind, title, body){
  const div = document.createElement("div");
  div.className = "ti";
  const tagClass =
    kind === "good" ? "tagGood" :
    kind === "warn" ? "tagWarn" :
    kind === "bad" ? "tagBad" : "";
  div.innerHTML = `
    <div class="tiTop">
      <div class="tiTitle">${escapeHtml(title)}</div>
      <div class="tiTag ${tagClass}">${escapeHtml(kind)}</div>
    </div>
    <div class="tiBody">${escapeHtml(body ?? "")}</div>
  `;
  timelineEl.appendChild(div);
  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function renderChatFromTranscript(raw){
  chatEl.innerHTML = "";
  raw.split("\n").forEach((line) => {
    const t = line.trim();
    if (!t) return;
    const isMe = /^you\s*:/i.test(t) || /^me\s*:/i.test(t);
    const isThem = /^them\s*:/i.test(t) || /^her\s*:/i.test(t) || /^him\s*:/i.test(t) || /^partner\s*:/i.test(t);
    if (!isMe && !isThem) return;

    const text = t.replace(/^[^:]+:\s*/,"");
    const div = document.createElement("div");
    div.className = "bubble " + (isMe ? "me" : "them");
    div.textContent = text;
    chatEl.appendChild(div);
  });
  chatEl.scrollTop = chatEl.scrollHeight;
}

function clearOutputs(){
  optionsEl.innerHTML = "";
  profileEl.textContent = "(run agent to see)";
  strategyEl.textContent = "(run agent to see)";
}

function prettyProfile(obj){
  const p = obj?.counterpart_profile;
  if (!p) return "(no profile)";
  const out = [];
  out.push(`confidence: ${p.confidence || "unknown"}`);
  if (Array.isArray(p.communication_habits)) out.push(`habits: ${p.communication_habits.join(" | ")}`);
  if (Array.isArray(p.likely_needs)) out.push(`needs: ${p.likely_needs.join(" | ")}`);
  if (Array.isArray(p.what_helps)) out.push(`helps: ${p.what_helps.join(" | ")}`);
  if (Array.isArray(p.triggers_or_sensitive_points)) {
    out.push("triggers:");
    out.push(p.triggers_or_sensitive_points.map(x => `- ${x.trigger} (evidence: ${x.evidence})`).join("\n"));
  }
  return out.join("\n\n");
}

function prettyStrategy(obj){
  const ns = obj?.north_star_strategy;
  const nx = obj?.next_step_strategy;
  const out = [];
  if (ns) {
    out.push("NORTH-STAR");
    if (Array.isArray(ns.principles)) out.push(`principles: ${ns.principles.join(" | ")}`);
    if (Array.isArray(ns.what_to_prioritize)) out.push(`prioritize: ${ns.what_to_prioritize.join(" | ")}`);
    if (Array.isArray(ns.what_to_avoid)) out.push(`avoid: ${ns.what_to_avoid.join(" | ")}`);
  }
  if (nx) {
    out.push("\nNEXT STEP");
    if (nx.goal_this_turn) out.push(`goal: ${nx.goal_this_turn}`);
    if (Array.isArray(nx.moves)) out.push(`moves: ${nx.moves.join(" | ")}`);
    if (Array.isArray(nx.watch_outs)) out.push(`watch outs: ${nx.watch_outs.join(" | ")}`);
  }
  return out.length ? out.join("\n") : "(no strategy)";
}

function setOptionsFromJson(obj){
  optionsEl.innerHTML = "";
  if (!obj?.draft_messages?.length) return;

  obj.draft_messages.forEach((m) => {
    const card = document.createElement("div");
    card.className = "opt";
    card.innerHTML = `
      <div class="lbl">${escapeHtml(m.label || "Option")}</div>
      <div class="txt">${escapeHtml(m.text || "")}</div>
    `;
    card.onclick = async () => {
      await navigator.clipboard.writeText(m.text || "");
      youSentEl.value = m.text || "";
      addTimeline("good", "Picked option", m.label || "");
    };
    optionsEl.appendChild(card);
  });

  if (obj.recommended_option_label) {
    addTimeline("good", "Recommended", obj.recommended_option_label);
  }
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(t);
  }
}

async function normalizeThread(){
  const raw = threadEl.value.trim();
  if (!raw) return;

  addTimeline("info", "Normalize", "Sending to /api/normalize (if you have it) ...");
  try {
    const j = await fetchJson("/api/normalize", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ raw })
    }, 15000);

    threadEl.value = (j.normalized || "").trim();
    renderChatFromTranscript(threadEl.value);
    addTimeline("good", "Normalize complete", "Converted to You:/Them: format.");
  } catch (e) {
    addTimeline("warn", "Normalize", "Your server may not have /api/normalize. You can skip it.");
    addTimeline("bad", "Normalize error", String(e?.message || e));
  }
}

async function ocrImage(){
  const file = $("upload").files?.[0];
  if (!file) { addTimeline("warn", "OCR", "No file selected."); return; }
  if (!file.type.startsWith("image/")) { addTimeline("warn", "OCR", "Selected file is not an image."); return; }
  if (!window.Tesseract) { addTimeline("bad", "OCR", "Tesseract.js not loaded."); return; }

  addTimeline("info", "OCR", `Recognizing ${file.name} ...`);
  const { data } = await window.Tesseract.recognize(file, "eng");
  const text = (data?.text || "").trim();
  if (!text) { addTimeline("bad", "OCR", "No text recognized."); return; }
  threadEl.value = text;
  addTimeline("good", "OCR complete", "Inserted OCR text. Next: Normalize (optional).");
}

async function newSession() {
  addTimeline("info", "Session", "Creating new session...");
  const objective = $("objective").value.trim() || "Help me write the next message.";
  const thread = threadEl.value || "";

  const j = await fetchJson("/api/session/new", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ objective, thread })
  }, 8000);

  sessionId = j.id;
  sessionHintEl.textContent = `Session: ${sessionId}`;
  threadEl.value = j.transcript || threadEl.value;
  renderChatFromTranscript(threadEl.value);
  addTimeline("good", "Session created", sessionId);
}

async function commitTurn(speaker, text){
  if (!sessionId) {
    addTimeline("warn", "Commit", "No session. Creating one first...");
    await newSession();
  }
  const t = String(text || "").trim();
  if (!t) return;

  const j = await fetchJson("/api/session/append", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ id: sessionId, speaker, text: t })
  }, 8000);

  threadEl.value = j.transcript || threadEl.value;
  renderChatFromTranscript(threadEl.value);
  addTimeline("good", "Committed", `${speaker}: ${t.slice(0, 80)}${t.length>80?"...":""}`);
}

async function runAgent(){
  clearOutputs();
  setStatus("starting");

  // health check
  try {
    await fetchJson("/api/health", {}, 2000);
  } catch (e) {
    setStatus("error");
    addTimeline("bad", "Server", "Health check failed. Are you running the new server.ts? Open /api/health.");
    throw e;
  }

  if (!sessionId) {
    addTimeline("warn", "Run", "No session. Creating one automatically...");
    await newSession();
  }

  const objective = $("objective").value.trim() || "Help me write the next message.";
  await fetchJson("/api/session/objective", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ id: sessionId, objective })
  }, 8000);

  const crawl = $("crawl").checked;

  addTimeline("info", "Run", `sessionId=${sessionId}`);
  const res = await fetch("/api/session/run", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ id: sessionId, crawl })
  });

  if (!res.ok || !res.body) {
    setStatus("error");
    const text = await res.text();
    addTimeline("bad", "HTTP error", `${res.status}: ${text.slice(0, 200)}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += decoder.decode(value, {stream:true});

    let idx;
    while((idx = buf.indexOf("\n\n")) >= 0){
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx+2);

      const lines = frame.split("\n");
      const evLine = lines.find(l => l.startsWith("event:"));
      const dataLine = lines.find(l => l.startsWith("data:"));
      const ev = evLine ? evLine.slice(6).trim() : "message";
      const data = dataLine ? dataLine.slice(5).trim() : "{}";

      let obj = null;
      try { obj = JSON.parse(data); } catch {}

      if (ev === "status") {
        setStatus(obj?.phase || "status");
        addTimeline("info", "Status", obj?.phase || data);
      } else if (ev === "event") {
        const t = obj?.type;
        if (t === "text") addTimeline("info", "Streaming", (obj.content || "").slice(0, 180));
      } else if (ev === "final") {
        addTimeline("good", "Final", "Rendered profile/strategy/options.");
        profileEl.textContent = prettyProfile(obj);
        strategyEl.textContent = prettyStrategy(obj);
        setOptionsFromJson(obj);
      } else if (ev === "final_error") {
        addTimeline("bad", "Final JSON failed", obj?.message || data);
      } else if (ev === "error") {
        setStatus("error");
        addTimeline("bad", "Server error", obj?.message || data);
      }
    }
  }

  setStatus("done");
}

// bindings
$("btnNormalize").onclick = () => normalizeThread();
$("btnOCR").onclick = () => ocrImage();

$("btnNewSession").onclick = async () => {
  try { await newSession(); } catch (e) { addTimeline("bad", "Session failed", String(e?.message||e)); }
};
$("run").onclick = async () => {
  try { await runAgent(); } catch (e) { addTimeline("bad", "Run failed", String(e?.message||e)); }
};

$("btnCommitYou").onclick = async () => {
  try { await commitTurn("You", youSentEl.value); youSentEl.value=""; } catch (e) { addTimeline("bad","Commit failed",String(e?.message||e)); }
};
$("btnCommitThem").onclick = async () => {
  try { await commitTurn("Them", themReplyEl.value); themReplyEl.value=""; } catch (e) { addTimeline("bad","Commit failed",String(e?.message||e)); }
};

$("upload").addEventListener("change", async () => {
  const file = $("upload").files?.[0];
  if (!file) return;

  if (file.type.startsWith("image/")) {
    addTimeline("info", "Upload", `Image selected: ${file.name}. Click OCR Image.`);
    return;
  }
  const text = await file.text();
  threadEl.value = text;
  renderChatFromTranscript(text);
  addTimeline("good", "Upload", `Loaded file: ${file.name}`);
});

// boot defaults
threadTitleEl.textContent = "DM Thread";
$("objective").value = "Help me write the next message in a natural tone.";
setStatus("idle");
addTimeline("info", "Ready", "Paste your thread, then New/Reset Session → Run Agent.");
