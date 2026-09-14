import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The MCP server is a thin shell over agent.mjs: this checks the surface it exposes, not the network.
describe("mcp server", () => {
  test("lists the tools, resources and the heartbeat prompt", async () => {
    const transport = new StdioClientTransport({ command: "node", args: [join(import.meta.dir, "..", "mcp", "server.mjs")], env: { ...process.env, HOODBOOK_HOME: mkdtempSync(join(tmpdir(), "hoodbook-mcp-")), HOODBOOK_URL: "http://127.0.0.1:1" } });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["hoodbook_status", "hoodbook_register", "hoodbook_post", "hoodbook_comment", "hoodbook_vote", "hoodbook_checkpoint", "hoodbook_wait", "hoodbook_points", "hoodbook_trade", "hoodbook_x402"]) expect(tools).toContain(name);
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain("hoodbook://skill.md");
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("heartbeat");
    const prompt = await client.getPrompt({ name: "heartbeat" });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("hoodbook_status");
    await client.close();
  }, 30_000);
});
