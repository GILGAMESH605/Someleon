
import { extname, join, normalize } from "jsr:@std/path";
import { fromFileUrl } from "jsr:@std/path/from-file-url";
import { eachValueFrom } from "npm:rxjs-for-await";
import { buildSomeleonTask } from "./someleon_task.ts";

type BuildAgentFn = () => Promise<any>;
type Speaker = "You" | "Them";
type Turn = { speaker: Speaker; text: string; ts: number };

type SessionState = {
  id: string;
  objective: string;
  turns: Turn[];
  memory: string;
  lastFinal: any | null;
  createdAt: number;
  updatedAt: number;
};

const sessions = new Map<string, SessionState>();
const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function safeReadStatic(root: string, urlPath: string): Promise<Response | null> {
  const clean = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const fsPath = join(root, clean);
  try {
    const bytes = await Deno.readFile(fsPath);
    return new Response(bytes, { headers: { "content-type": contentType(fsPath) } });
  } catch {
    return null;
  }
}

function parseTranscriptToTurns(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!m) continue;

    const who = m[1].trim().toLowerCase();
    const text = (m[2] ?? "").trim();
    if (!text) continue;

    let speaker: Speaker = "Them";
    if (who === "you" || who === "me") speaker = "You";
    else if (["them", "her", "him", "partner"].includes(who)) speaker = "Them";
    else speaker = "Them";

    turns.push({ speaker, text, ts: Date.now() });
  }
  return turns;
}

function turnsToTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

function extractTextFromEvent(ev: any): string {
  if (!ev || typeof ev !== "object") return "";
  if (ev.type === "text" && typeof ev.content === "string") return ev.content;
  if (typeof ev.text === "string") return ev.text;
  if (typeof ev.content === "string") return ev.content;
  return "";
}

function tryParseFinalJson(text: string): any | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  const unfenced = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {}

  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(unfenced.slice(first, last + 1));
    } catch {}
  }
  return null;
}

async function repairToJson(agent: any, model: string, raw: string): Promise<any | null> {
  const prompt = `
Return ONLY valid JSON matching the schema below. No markdown.

{
  "context_summary": "...",
  "objective_understanding": ["..."],
  "counterpart_profile": {
    "communication_habits": ["..."],
    "likely_needs": ["..."],
    "triggers_or_sensitive_points": [{"trigger":"...","evidence":"..."}],
    "what_helps": ["..."],
    "confidence": "low|medium|high"
  },
  "north_star_strategy": {"principles":["..."],"what_to_prioritize":["..."],"what_to_avoid":["..."]},
  "next_step_strategy": {"goal_this_turn":"...","moves":["..."],"watch_outs":["..."]},
  "draft_messages": [{"label":"Option A","text":"..."}],
  "recommended_option_label": "Option ...",
  "do_not_say": ["..."],
  "follow_up_questions": ["..."],
  "session_memory_update": "...",
  "agency_timeline": [{"phase":"...","detail":"..."}]
}

Raw:
${raw}
`.trim();

  let buf = "";
  const event$ = agent.runTask(prompt, model);
  for await (const ev of eachValueFrom(event$)) buf += extractTextFromEvent(ev);
  return tryParseFinalJson(buf);
}

function mustGetSession(id: string): SessionState {
  const s = sessions.get(id);
  if (!s) throw new Error(`Unknown sessionId: ${id}`);
  return s;
}

export async function startServer(opts: { port: number; model: string; buildAgent: BuildAgentFn }) {
  const publicDir = fromFileUrl(new URL("../public/", import.meta.url));
  const sessionsDir = fromFileUrl(new URL("../sessions/", import.meta.url));

  console.log(`Someleon Web Demo running on http://localhost:${opts.port}`);

  Deno.serve({ port: opts.port }, async (req) => {
    const url = new URL(req.url);

    // ✅ health check
    if (req.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true, time: Date.now(), sessions: sessions.size });
    }

    // static
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      const p = url.pathname === "/" ? "/index.html" : url.pathname;
      const res = await safeReadStatic(publicDir, p);
      return res ?? new Response("Not found", { status: 404 });
    }

    // sample load
    if (req.method === "GET" && url.pathname === "/api/sample") {
      const id = url.searchParams.get("id") ?? "business";
      const file = id === "couple" ? "couple_chat.txt" : "business_chat.txt";
      const text = await Deno.readTextFile(join(sessionsDir, file));
      return Response.json({ id, text });
    }

    // session new (NO agent here, should be instant)
    if (req.method === "POST" && url.pathname === "/api/session/new") {
      let body: any = {};
      try { body = await req.json(); } catch {}

      const objective = String(body.objective ?? "Help me write the next message.");
      const thread = String(body.thread ?? "");
      const turns = parseTranscriptToTurns(thread);

      const id = crypto.randomUUID();
      const now = Date.now();

      const s = {
        id,
        objective,
        turns,
        memory: "",
        lastFinal: null,
        createdAt: now,
        updatedAt: now,
      } satisfies SessionState;

      sessions.set(id, s);
      console.log(`[session/new] id=${id} turns=${turns.length}`);

      return Response.json({ id, objective, transcript: turnsToTranscript(turns) });
    }

    if (req.method === "GET" && url.pathname === "/api/session/get") {
      const id = String(url.searchParams.get("id") ?? "");
      if (!id) return new Response("Missing id", { status: 400 });
      const s = mustGetSession(id);
      return Response.json({
        id: s.id,
        objective: s.objective,
        transcript: turnsToTranscript(s.turns),
        memory: s.memory,
        lastFinal: s.lastFinal,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/session/objective") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const id = String(body.id ?? "");
      const objective = String(body.objective ?? "").trim();
      if (!id || !objective) return new Response("Missing id/objective", { status: 400 });
      const s = mustGetSession(id);
      s.objective = objective;
      s.updatedAt = Date.now();
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/session/append") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const id = String(body.id ?? "");
      const speaker = String(body.speaker ?? "Them");
      const text = String(body.text ?? "").trim();
      if (!id || !text) return new Response("Missing id/text", { status: 400 });

      const s = mustGetSession(id);
      const sp: Speaker = speaker === "You" ? "You" : "Them";
      s.turns.push({ speaker: sp, text, ts: Date.now() });
      s.updatedAt = Date.now();

      console.log(`[session/append] id=${id} ${sp}: ${text.slice(0, 60)}`);
      return Response.json({ ok: true, transcript: turnsToTranscript(s.turns) });
    }

    // session run (SSE)
    if (req.method === "POST" && url.pathname === "/api/session/run") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const id = String(body.id ?? "");
      const crawl = Boolean(body.crawl ?? false);
      if (!id) return new Response("Missing id", { status: 400 });

      const s = mustGetSession(id);
      console.log(`[session/run] id=${id} turns=${s.turns.length} crawl=${crawl}`);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          (async () => {
            controller.enqueue(sse("meta", { sessionId: id, model: opts.model, crawl }));
            controller.enqueue(sse("status", { phase: "building_agent" }));

            let textBuffer = "";
            try {
              const agent = await opts.buildAgent();

              controller.enqueue(sse("status", { phase: "running_task" }));
              const task = buildSomeleonTask({
                objective: s.objective,
                transcript: turnsToTranscript(s.turns),
                crawl,
                sessionMemory: s.memory,
              });

              const event$ = agent.runTask(task, opts.model);
              for await (const ev of eachValueFrom(event$)) {
                controller.enqueue(sse("event", ev));
                textBuffer += extractTextFromEvent(ev);
              }

              controller.enqueue(sse("status", { phase: "parsing_final" }));
              let finalObj = tryParseFinalJson(textBuffer);

              if (!finalObj) {
                controller.enqueue(sse("status", { phase: "repairing_json" }));
                const agent2 = await opts.buildAgent();
                finalObj = await repairToJson(agent2, opts.model, textBuffer);
              }

              if (!finalObj) {
                controller.enqueue(sse("final_error", { message: "Could not parse final JSON", raw: textBuffer.slice(0, 1500) }));
              } else {
                s.lastFinal = finalObj;
                s.memory = String(finalObj.session_memory_update ?? s.memory ?? "");
                s.updatedAt = Date.now();
                controller.enqueue(sse("final", finalObj));
              }

              controller.enqueue(sse("status", { phase: "done" }));
            } catch (err: any) {
              controller.enqueue(sse("error", { message: String(err?.message ?? err) }));
            } finally {
              controller.close();
            }
          })();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  });
}
