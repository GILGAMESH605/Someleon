import {
  AnthropicModelProvider,
  createZypherContext,
  ZypherAgent,
} from "@zypher/agent";

export async function createSomeleonAgent() {
  const zypherContext = await createZypherContext(Deno.cwd());

  const agent = new ZypherAgent(
    zypherContext,
    new AnthropicModelProvider({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
    }),
  );

  // Register Firecrawl for "Live Research" capabilities
  await agent.mcp.registerServer({
    id: "firecrawl",
    type: "command",
    command: {
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: {
        FIRECRAWL_API_KEY: Deno.env.get("FIRECRAWL_API_KEY")!,
      },
    },
  });

  return agent;
}

export const SYSTEM_PROMPT = `
You are "Someleon" (Social Chameleon). You are not a chatbot; you are a strategic communication consultant.

Your workflow for every user request is:
1. **PSYCHOLOGICAL PROFILING**: Analyze the uploaded chat logs. Determine the target's Big 5 Personality traits, current emotional state (e.g., Defensive, Eager, Skeptical), and hidden intent.
2. **STRATEGIC RESEARCH (Agency)**: If the user's goal involves a specific domain (e.g., "Closing a SaaS deal" or "Recovering from a ghosting"), you MUST use the 'firecrawl' tool to search for "best negotiation tactics 2024" or "psychological tricks for texting". DO NOT rely solely on training data; verify with live web trends.
3. **GENERATION**: Produce 3 options for the next message, ranging from "Safe" to "Bold".

Output Format:
Please format your final response in Markdown. Include a section called "## 🧠 Target Profile" and "## 🌐 Research Insights" before the actual draft messages.
`;