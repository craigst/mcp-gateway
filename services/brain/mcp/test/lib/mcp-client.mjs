/**
 * A minimal MCP stdio client for the tests.
 *
 * Speaks line-framed JSON-RPC to a spawned copy of github-mcp.js. Deliberately independent of
 * the server's own code: a test that shares an implementation with the thing it tests can
 * agree with a bug.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(__dirname, "..", "..", "brain-mcp.js");

export function startServer(env = {}, { serverPath = SERVER, timeoutMs = 20000 } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map();
  const stderr = [];
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });
  child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));
  child.on("exit", (code) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: `server exited with code ${code}` } });
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    stderr,
    child,
    init: () => send("initialize", { protocolVersion: "2024-11-05" }),

    async listTools() {
      const res = await send("tools/list", {});
      return (res.result && res.result.tools) || [];
    },

    /** Returns { isError, text, rpcError } — an unknown tool is a JSON-RPC error, not a result. */
    async call(name, args) {
      const res = await send("tools/call", { name, arguments: args || {} });
      if (res.error) return { isError: true, text: res.error.message, rpcError: true };
      const result = res.result || {};
      const text = (result.content || []).map((c) => c.text).join("\n");
      return { isError: Boolean(result.isError), text, result };
    },

    /** As call(), but parses the JSON payload the server returns. */
    async callJson(name, args) {
      const res = await this.call(name, args);
      if (res.isError) return { isError: true, text: res.text };
      try {
        return { isError: false, json: JSON.parse(res.text), text: res.text };
      } catch {
        return { isError: false, raw: res.text, text: res.text };
      }
    },

    stop: () =>
      new Promise((resolve) => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }),
  };
}
