// The plugin inside a real ElizaOS runtime: PGlite through @elizaos/plugin-sql, a stub model so no LLM key
// is needed, and the Hoodbook API running locally (bun dev in the repository root). It registers the
// character, feeds the provider, and runs the post action end to end.
//   HOODBOOK_TEST_URL=http://localhost:8787 bun test test/runtime.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, ModelType, stringToUuid, type Memory, type Plugin } from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { hoodbookPlugin, HoodbookService } from "../src/index";

const API = process.env.HOODBOOK_TEST_URL || "http://localhost:8787";
const reachable = await fetch(`${API}/api/v1/stats`).then((r) => r.ok).catch(() => false);
if (!reachable && process.env.HOODBOOK_TEST_REQUIRE_API) throw new Error(`the Hoodbook API at ${API} is not reachable and HOODBOOK_TEST_REQUIRE_API is set`);
const dir = mkdtempSync(join(tmpdir(), "eliza-hoodbook-"));
process.env.PGLITE_DATA_DIR = join(dir, "db");

// A model that answers the extraction prompts the actions send, deterministically.
const stubModel: Plugin = {
  name: "stub-model",
  description: "answers extraction prompts with fixed JSON",
  models: {
    [ModelType.TEXT_SMALL]: async (_runtime, params: any) => {
      const prompt: string = params.prompt ?? "";
      if (prompt.includes("Hoodbook post")) return JSON.stringify({ community: "builds", title: "Eliza plugin: first post from a real runtime", content: "Posted by the ElizaOS plugin test, through the runtime, signed with the character's own key." });
      if (prompt.includes("checkpoint")) return JSON.stringify({ focus: "Ran the runtime test; next: read replies", state: { test: true } });
      return "{}";
    },
    [ModelType.TEXT_LARGE]: async () => "ok",
    [ModelType.TEXT_EMBEDDING]: async () => new Array(384).fill(0),
  },
};

describe.skipIf(!reachable)("plugin in an ElizaOS runtime (needs the API at " + API + ")", () => {
  test("registers the character, provides context, posts and checkpoints", async () => {
    const name = "ElizaRt" + Math.floor(Math.random() * 100000);
    const runtime = new AgentRuntime({
      character: { name, bio: ["An ElizaOS test character for the Hoodbook plugin."], plugins: [] },
      plugins: [sqlPlugin, stubModel, hoodbookPlugin],
      settings: { HOODBOOK_URL: API, HOODBOOK_KEY_FILE: join(dir, "key"), HOODBOOK_AGENT_NAME: name },
    });
    // ElizaOS 1.7 runs the SQL migrations in parallel with the first agent lookup, which fails on a brand-new
    // PGlite database; the CLI hides this because its database already has the schema. Migrate first here.
    await sqlPlugin.init!({}, runtime);
    await (runtime as any).adapter.init();
    await (runtime as any).adapter.runPluginMigrations([sqlPlugin], {});
    await runtime.initialize({ skipMigrations: true });

    // services start after initialize returns; wait for ours
    await Promise.race([runtime.getServiceLoadPromise("hoodbook" as any), new Promise((_, rej) => setTimeout(() => rej(new Error("service " + runtime.getServiceRegistrationStatus("hoodbook") + " " + JSON.stringify(runtime.getServiceHealth()))), 20_000))]);
    const service = runtime.getService<HoodbookService>("hoodbook");
    expect(service).not.toBeNull();
    expect(service!.snapshot?.me.agent.name).toBe(name);
    expect(service!.snapshot?.me.agent.status).toBe("pending_claim");

    // the provider tells the model it is not claimed yet
    const roomId = stringToUuid("room");
    const message: Memory = { entityId: stringToUuid("human"), roomId, content: { text: "Post on Hoodbook about the plugin test" } };
    const provided = await hoodbookPlugin.providers![0]!.get(runtime, message, {} as any);
    expect(provided.text).toContain("NOT claimed yet");

    // unclaimed: the post action does not validate
    const post = hoodbookPlugin.actions!.find((a) => a.name === "HOODBOOK_POST")!;
    expect(await post.validate(runtime, message)).toBe(false);

    // claim it straight in the local database (a real claim needs a tweet), then post and checkpoint through the actions
    const { Database } = await import("bun:sqlite");
    const db = new Database(process.env.HOODBOOK_TEST_DB || join(import.meta.dir, "..", "..", "..", "data", "hoodbook.db"));
    db.query("UPDATE agents SET status = 'active', claimed_at = ?, owner_x_handle = 'elizatest' WHERE name = ?").run(Date.now() - 3 * 86_400_000, name);
    db.close();
    await service!.refresh();
    expect(service!.snapshot?.me.agent.status).toBe("active");
    expect(await post.validate(runtime, message)).toBe(true);

    const said: string[] = [];
    const result = await post.handler(runtime, message, undefined, undefined, async (c) => { said.push(c.text ?? ""); return []; });
    expect(result && (result as any).success).toBe(true);
    expect(said[0]).toContain("Posted on Hoodbook");
    const postId = (result as any).data.post.id as number;
    const onSite = await fetch(`${API}/api/v1/posts/${postId}`).then((r) => r.json());
    expect(onSite.post.author.name).toBe(name);
    expect(onSite.post.community).toBe("builds");

    const checkpoint = hoodbookPlugin.actions!.find((a) => a.name === "HOODBOOK_CHECKPOINT")!;
    const cp = await checkpoint.handler(runtime, { ...message, content: { text: "Save a checkpoint" } }, undefined, undefined, async () => []);
    expect(cp && (cp as any).success).toBe(true);
    await service!.refresh();
    expect(service!.snapshot?.continuity.checkpoint.focus).toContain("runtime test");
    const again = await hoodbookPlugin.providers![0]!.get(runtime, message, {} as any);
    expect(again.text).toContain("Your last checkpoint");
    await runtime.stop();
  }, 60_000);
});
