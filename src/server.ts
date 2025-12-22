import { serve } from "std/http/server.ts"; // Uses the map from deno.json
import { createSomeleonAgent, SYSTEM_PROMPT } from "./agent.ts";
import { eachValueFrom } from "rxjs-for-await";

const agent = await createSomeleonAgent();

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Serve Static Frontend (The Instagram UI)
  if (req.method === "GET" && url.pathname === "/") {
    const html = await Deno.readTextFile("./public/index.html");
    return new Response(html, {
      headers: { "content-type": "text/html" },
    });
  }

  // API Endpoint: Analyze Chat
  if (req.method === "POST" && url.pathname === "/api/analyze") {
    try {
      const { purpose, chatLog } = await req.json();

      const task = `
        ${SYSTEM_PROMPT}
        
        === USER GOAL ===
        ${purpose}

        === CHAT LOGS ===
        ${chatLog}
      `;

      // Create a readable stream to send data to frontend in real-time
      const stream = new ReadableStream({
        async start(controller) {
          const event$ = agent.runTask(task, "claude-3-5-sonnet-latest");
          
          for await (const event of eachValueFrom(event$)) {
            // We stream the raw events from Zypher to the frontend
            // This allows the frontend to show "Thinking...", "Searching...", etc.
            const chunk = JSON.stringify(event) + "\n";
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson" },
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
}

console.log("Someleon Server running on http://localhost:8000");
serve(handler, { port: 8000 });