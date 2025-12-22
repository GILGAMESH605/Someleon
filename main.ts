// main.ts
import "jsr:@std/dotenv/load";

import {
  AnthropicModelProvider,
  createZypherContext,
  ZypherAgent,
} from "@zypher/agent";

import { startServer } from "./src/server.ts";

function getRequiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const zypherContext = await createZypherContext(Deno.cwd());

let agentSingleton: ZypherAgent | null = null;

async function buildAgent() {
  if (agentSingleton) return agentSingleton;

  const agent = new ZypherAgent(
    zypherContext,
    new AnthropicModelProvider({ apiKey: getRequiredEnv("ANTHROPIC_API_KEY") }),
  );

  // Firecrawl optional: if you didn't set key, agent still works (just no crawl tool)
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (firecrawlKey) {
    await agent.mcp.registerServer({
      id: "firecrawl",
      type: "command",
      command: {
        command: "npx",
        args: ["-y", "firecrawl-mcp"],
        env: { FIRECRAWL_API_KEY: firecrawlKey },
      },
    });
    console.log("[mcp] firecrawl registered");
  } else {
    console.log("[mcp] FIRECRAWL_API_KEY not set; crawl disabled");
  }

  agentSingleton = agent;
  return agentSingleton;
}

await startServer({
  port: 8787,
  model: "claude-sonnet-4-20250514",
  buildAgent,
});
