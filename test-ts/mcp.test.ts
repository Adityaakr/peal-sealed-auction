/**
 * The QoreChain MCP server this repository configures for coding agents
 * (`.mcp.json`, `@qorechain/mcp` pinned in devDependencies) starts over stdio and
 * offers its read-only tools. No network call: only the handshake and the tool list.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe(".mcp.json: the QoreChain MCP server", () => {
  it("starts from the configured command and lists read-only tools, none of which signs", async () => {
    const cfg = JSON.parse(readFileSync(".mcp.json", "utf8")).mcpServers.qorechain as { command: string; args: string[] };
    const child = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const replies = new Map<number, { result?: { tools?: { name: string }[] } }>();
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") replies.set(msg.id, msg as never);
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const wait = async (id: number) => {
      for (let t = 0; t < 300 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 100));
      return replies.get(id);
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "peal-sealed-auction-test", version: "0" } } });
      expect(await wait(1)).toBeDefined();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = ((await wait(2))?.result?.tools ?? []).map((t) => t.name);
      expect(names).toContain("get_pq_status");
      expect(names).toContain("get_transaction");
      expect(names.some((n) => /sign|broadcast|send_tx/.test(n))).toBe(false);
    } finally {
      child.kill();
    }
  });
});
