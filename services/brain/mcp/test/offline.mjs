#!/usr/bin/env node
/**
 * Offline suite for brain-mcp.
 *
 *   node test/offline.mjs
 *
 * No homelab, no real hub, no real brain-api — but everything else is real: the
 * suite spawns the actual server, speaks real MCP over stdio, and points it at a
 * fake hub and a fake brain-api it starts itself. That is deliberate. The one
 * thing worth testing here is the AUTHORISATION decision, and a suite that trusts
 * a mock of its own gate tests nothing:
 *
 *   · who am I              — missing/absent credential
 *   · may I                 — not granted, expired, unknown server, actions too narrow
 *   · fail closed           — hub unreachable: reads may use a short cache, writes refuse
 *   · what reaches the wire — the actor and the key on the brain-api call
 *
 * The live suite (test/live.mjs) is what proves archive-host and the real hub answer.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "brain-mcp.js");

const EXPECTED_TOOLS = [
  "brain_whoami",
  "brain_search",
  "brain_remember",
  "brain_import_memories",
  "brain_update",
  "brain_forget",
  "brain_stats",
  "knowledge_search",
  "knowledge_ingest",
  // The asset register — how an estate stays current across agents.
  "brain_asset_get",
  "brain_asset_list",
  "brain_asset_set",
  "brain_asset_forget",
];

const API_KEY = "test-harness-key";
const AGENT = "test-agent";
const TOKEN = "msg_testtoken";

let passed = 0;
let failed = 0;

async function check(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${label}`);
    console.log(`       ${error?.message ?? error}`);
    failed += 1;
  }
}

// ── the two fakes ───────────────────────────────────────────────────────────

/** A hub that answers /v1/mcp/access however the scenario wants. */
function startFakeHub() {
  const state = {
    mode: "ok", // ok | fail | notoken
    access: { ok: true, contactId: AGENT, access: [] },
    seenTokens: [],
  };
  const server = http.createServer((req, res) => {
    state.seenTokens.push(req.headers.authorization || null);
    if (state.mode === "fail") {
      // Simulate "cannot reach the hub" — not an HTTP error, a dead socket.
      req.socket.destroy();
      return;
    }
    if (state.mode === "notoken" || !req.headers.authorization) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorised" }));
      return;
    }
    if (req.url.startsWith("/v1/mcp/access")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.access));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A brain-api that records what it was asked, and answers what the scenario wants. */
function startFakeBrain() {
  const state = {
    requests: [],
    status: 200,
    assets: {
      "ip/archive-host": { key: "ip/archive-host", value: "192.0.2.13", category: "homelab", note: "storage host" },
      "account/halifax": { key: "account/halifax", value: "sort code 11-22-33", category: "financial" },
    },
    body: { ok: true, count: 1, results: [{ id: "m1", memory: "ArchiveHost is the main storage host server.", user_id: "shared" }] },
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = { unparsable: raw };
      }
      state.requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        actor: req.headers["x-brain-actor"] || null,
        categories: req.headers["x-brain-allowed-categories"] || null,
        body: parsed,
      });
      // The asset register: model it faithfully enough that the tools are tested
      // against real shapes rather than a canned blob.
      if (req.url.startsWith("/assets")) {
        if (req.method === "PUT") {
          state.assets[parsed.key] = { ...parsed, updated_by: req.headers["x-brain-actor"] };
          const existed = state.assetHad?.[parsed.key];
          state.assetHad = { ...(state.assetHad || {}), [parsed.key]: true };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true, key: parsed.key, value: parsed.value, category: parsed.category,
            created: !existed, changed: true, previous: existed ? "OLD VALUE" : null,
          }));
          return;
        }
        if (req.method === "DELETE") {
          const key = decodeURIComponent(req.url.replace("/assets/", ""));
          delete state.assets[key];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key, deleted: true }));
          return;
        }
        const key = req.url.startsWith("/assets/") ? decodeURIComponent(req.url.slice(8)) : null;
        const allowed = (req.headers["x-brain-allowed-categories"] || "").split(",");
        if (key) {
          const row = state.assets[key];
          if (!row) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: `no asset with key '${key}'` }));
            return;
          }
          if (!allowed.includes(row.category)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: `asset '${key}' is in category '${row.category}', which you may not read` }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            asset: { key, value: row.value, category: row.category, note: row.note || null,
                     updated_by: row.updated_by, updated_at: "2026-10-05T11:00:00Z", created_at: "2026-10-05T10:00:00Z" },
            recent_changes: [{ value: row.value, changed_by: row.updated_by, changed_at: "2026-10-05T11:00:00Z" }],
          }));
          return;
        }
        const rows = Object.entries(state.assets)
          .filter(([, r]) => allowed.includes(r.category))
          .map(([k, r]) => ({ key: k, value: r.value, category: r.category, note: r.note || null }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: rows.length, categories_searched: allowed, assets: rows }));
        return;
      }
      // The category vocabulary is the one GET this server serves.
      if (req.method === "GET" && req.url.startsWith("/categories")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            categories: [
              { name: "homelab", sensitive: false },
              { name: "projects", sensitive: false },
              { name: "email", sensitive: true },
              { name: "financial", sensitive: true },
              { name: "personal", sensitive: true },
            ],
            public: ["homelab", "projects"],
            sensitive: ["email", "financial", "personal"],
          }),
        );
        return;
      }
      // The memory write path is handled by the fall-through below unless a
      // scenario wants to model the brain host's EXTRACTION step failing (Mem0's
      // LLM aborting on a repeat loop). `state.onMemoryAdd` returns
      // {status, detail} to refuse that body, or null to accept it — so a test
      // can fail `infer:true` while letting the verbatim retry through, which is
      // exactly the shape the fallback exists for.
      if (req.url === "/memory/add" && state.onMemoryAdd) {
        const veto = state.onMemoryAdd(parsed);
        if (veto) {
          res.writeHead(veto.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: veto.detail }));
          return;
        }
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.body));
        return;
      }
      res.writeHead(state.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A credential file with the shape the hub actually writes. */
function writeCred(hubUrl) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-cred-")), `${AGENT}.env`);
  fs.writeFileSync(
    file,
    `# test credential\nMESSENGER_AGENT=${AGENT}\nMESSENGER_HUB=${hubUrl}\nMESSENGER_CRED=${TOKEN}\n`,
    { mode: 0o600 },
  );
  return file;
}

function brainGrant({ allowed = true, actions = ["search"], expired = false, omit = false } = {}) {
  if (omit) return { ok: true, contactId: AGENT, access: [] };
  return {
    ok: true,
    contactId: AGENT,
    access: [
      {
        server: "brain",
        name: "brain",
        transport: "stdio",
        description: "from the DSH web profile (mcp-brain)",
        allowed,
        actions,
        expiresAt: null,
        expired,
      },
    ],
  };
}

function baseEnv(hub, brain, credFile) {
  return {
    BRAIN_URL: brain.url,
    BRAIN_API_KEY: API_KEY,
    MESSENGER_HUB: hub.url,
    MESSENGER_CRED_FILE: credFile,
    MESSENGER_TIMEOUT_MS: "5000",
  };
}

async function withServer(env, body) {
  const server = startServer(env, { serverPath: ENTRY });
  try {
    await body(server);
  } finally {
    await server.stop();
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

console.log("brain-mcp offline suite");

// 1. handshake, tool surface, schemas (nothing is called, so no fakes needed).
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("initialize reports server name brain", async () => {
      const res = await server.init();
      assert.equal(res.result.serverInfo.name, "brain");
    });
    await check("tools/list is exactly the contracted surface", async () => {
      const names = (await server.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    });
    await check("every tool has a description and an object schema", async () => {
      for (const tool of await server.listTools()) {
        assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
        assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must be an object`);
      }
    });
  });
  await hub.close();
  await brain.close();
}

// 2. no identity → every tool refuses before touching anything.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  await withServer({ ...baseEnv(hub, brain, ""), MESSENGER_CRED_FILE: "" }, async (server) => {
    await check("missing MESSENGER_CRED_FILE refuses and says why", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError, "expected an error");
      assert.match(res.text, /no caller identity/);
    });
  });
  await check("nothing reached the brain-api", async () => {
    assert.equal(brain.state.requests.length, 0);
  });
  await hub.close();
  await brain.close();
}

// 3. a credential the hub will not honour.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);

  hub.state.access = brainGrant({ allowed: false });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("a revoked grant refuses, naming the agent", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /test-agent/);
      assert.match(res.text, /not granted/);
    });
  });

  hub.state.access = brainGrant({ allowed: false, expired: true });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("an expired grant says the grant expired", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /expired/);
    });
  });

  hub.state.access = brainGrant({ omit: true });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("an unregistered brain server refuses rather than allowing", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /registered as "brain"/);
    });
  });

  await check("a refusal never reached the brain-api", async () => {
    assert.equal(brain.state.requests.length, 0, "an unauthorised call must not hit the data plane");
  });
  await hub.close();
  await brain.close();
}

// 4. a grant that is real but too narrow, then one that is enough.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);

  hub.state.access = brainGrant({ actions: ["search"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("search is allowed with the search action", async () => {
      const res = await server.call("brain_search", { query: "archive-host", scope: "shared" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /ArchiveHost is the main storage host server/);
    });
    await check("remember is refused when only search was granted", async () => {
      const res = await server.call("brain_remember", { text: "Jellyfin runs on archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /"remember"/);
      assert.match(res.text, /granted: search/);
    });
    await check("the harness key and the actor reach the data plane", async () => {
      const req = brain.state.requests.at(-1);
      assert.equal(req.authorization, `Bearer ${API_KEY}`);
      assert.equal(req.actor, AGENT);
      assert.equal(req.url, "/memory/search");
    });
    await check("the hub was asked with this agent's own bearer token", async () => {
      assert.ok(hub.state.seenTokens.every((t) => t === `Bearer ${TOKEN}`));
    });
    await check("external import is refused without a remember grant", async () => {
      const before = brain.state.requests.length;
      const res = await server.call("brain_import_memories", { source: "external", items: [{ external_id: "1", text: "fact" }] });
      assert.ok(res.isError);
      assert.equal(brain.state.requests.length, before);
    });
  });

  brain.state.requests.length = 0;
  hub.state.access = brainGrant({ actions: ["search", "remember", "update", "forget", "knowledge", "ingest"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("remember is allowed once the action is granted", async () => {
      const res = await server.call("brain_remember", { text: "Sonarr is on media-net", source_ref: "chat" });
      assert.ok(!res.isError, res.text);
      assert.equal(brain.state.requests.at(-1).url, "/memory/add");
    });
    await check("external import uses the granted identity and forwards stable IDs", async () => {
      const res = await server.call("brain_import_memories", { source: "external", items: [{ external_id: "1", text: "fact" }] });
      assert.ok(!res.isError, res.text);
      const req = brain.state.requests.at(-1);
      assert.equal(req.url, "/memory/import");
      assert.equal(req.actor, AGENT);
      assert.equal(req.body.items[0].external_id, "1");
    });
    const adds = () => brain.state.requests.filter((r) => r.url === "/memory/add").length;
    await check("a failed extraction falls back to storing the text verbatim", async () => {
      // The exact shape seen on 2026-10-07: the data plane is fine, the
      // extraction model on the brain host aborted, and the fact was lost.
      brain.state.onMemoryAdd = (body) =>
        body.infer === false
          ? null
          : {
              status: 502,
              detail:
                "memory backend: LLM extraction failed: prediction aborted, " +
                "token repeat limit reached (status code: 500)",
            };
      const res = await server.call("brain_remember", {
        text: "The console MCP probes direct -> systemd-run --user -> ssh loopback.",
        source_ref: "offline-suite",
      });
      assert.ok(!res.isError, `the fact was lost: ${res.text}`);
      assert.match(res.text, /VERBATIM/);
      assert.equal(brain.state.requests.at(-1).body.infer, false,
        "the retry must ask for the verbatim store");
      brain.state.onMemoryAdd = null;
    });
    await check("the same failure with infer:false is reported, not retried", async () => {
      // An explicit verbatim request has no cheaper form to fall back to, so it
      // must surface the error rather than loop.
      brain.state.onMemoryAdd = () => ({ status: 502, detail: "memory backend: still down" });
      const before = adds();
      const res = await server.call("brain_remember", { text: "x", infer: false });
      assert.ok(res.isError);
      assert.equal(adds() - before, 1);
      brain.state.onMemoryAdd = null;
    });
    await check("a refused request (4xx) is not blindly retried", async () => {
      // A 400 will be a 400 whatever `infer` says; retrying it is pure noise.
      brain.state.onMemoryAdd = () => ({ status: 400, detail: "text is required" });
      const before = adds();
      const res = await server.call("brain_remember", { text: "x" });
      assert.ok(res.isError);
      assert.equal(adds() - before, 1);
      brain.state.onMemoryAdd = null;
    });
    await check("whoami reports the grant it actually has", async () => {
      const res = await server.call("brain_whoami", {});
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /test-agent/);
      assert.match(res.text, /"granted": true/);
    });
    await check("a data-plane error is passed through, not swallowed", async () => {
      brain.state.status = 502;
      brain.state.body = { detail: "memory backend: ollama is down" };
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /ollama is down/);
      brain.state.status = 200;
      brain.state.body = { ok: true, count: 0, results: [] };
    });
    await check("an empty result says so rather than returning nothing", async () => {
      const res = await server.call("brain_search", { query: "nothing" });
      assert.ok(!res.isError);
      assert.match(res.text, /No memories matched/);
    });
  });
  await hub.close();
  await brain.close();
}

// 5. fail closed: a hub that cannot be reached.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);
  hub.state.access = brainGrant({ actions: ["search", "remember"] });

  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("a read populates the cache", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(!res.isError, res.text);
    });
    hub.state.mode = "fail";
    await check("a read still works from the fresh cache while the hub is down", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(!res.isError, res.text);
    });
    await check("a WRITE refuses while the hub is unreachable", async () => {
      const res = await server.call("brain_remember", { text: "this must not be written" });
      assert.ok(res.isError);
      assert.match(res.text, /cannot reach the messenger hub/);
    });
  });

  await check("no write reached the brain-api while the hub was down", async () => {
    assert.ok(
      brain.state.requests.every((r) => r.url !== "/memory/add"),
      "a write was stored despite the permission being unverifiable",
    );
  });
  await hub.close();
  await brain.close();
}

// 6. a credential the hub actively rejects (401) is not a temporary hiccup.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);
  hub.state.mode = "notoken";
  await withServer({ ...baseEnv(hub, brain, cred), MESSENGER_CRED_FILE: cred }, async (server) => {
    await check("a hub 401 tells the operator to rotate the credential", async () => {
      const res = await server.call("brain_search", { query: "archive-host" });
      assert.ok(res.isError);
      assert.match(res.text, /rotate/);
    });
  });
  await hub.close();
  await brain.close();
}

// 7. the category boundary — the reason this whole layer exists
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);

  // a plain `knowledge` grant sees ONLY the non-sensitive categories
  hub.state.access = brainGrant({ actions: ["search", "knowledge", "ingest"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    brain.state.requests.length = 0;
    await check("plain knowledge searches only the public categories", async () => {
      const res = await server.call("knowledge_search", { query: "bank statement" });
      assert.ok(!res.isError, res.text);
      const req = brain.state.requests.find((r) => r.url === "/knowledge/search");
      assert.ok(req, "no search reached the data plane");
      assert.deepEqual((req.categories || "").split(",").sort(), ["homelab", "projects"]);
    });
    await check("the answer says which categories were searched", async () => {
      const res = await server.call("knowledge_search", { query: "bank statement" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /homelab, projects/);
    });
    await check("writing a sensitive category is refused before the call", async () => {
      brain.state.requests.length = 0;
      const res = await server.call("knowledge_ingest", { path: "inbox/x.pdf", category: "financial" });
      assert.ok(res.isError);
      assert.match(res.text, /may not write category "financial"/);
      assert.equal(brain.state.requests.filter((r) => r.url === "/knowledge/ingest").length, 0);
    });
    await check("writing a public category is allowed", async () => {
      const res = await server.call("knowledge_ingest", { path: "inbox/x.pdf", category: "homelab" });
      assert.ok(!res.isError, res.text);
      const req = brain.state.requests.find((r) => r.url === "/knowledge/ingest");
      assert.equal(req.body.category, "homelab");
    });
    await check("whoami reports the readable categories", async () => {
      const res = await server.call("brain_whoami", {});
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /homelab/);
      assert.match(res.text, /projects/);
    });
  });

  // naming a sensitive category in the grant adds exactly that one
  hub.state.access = brainGrant({ actions: ["knowledge", "knowledge:financial"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    brain.state.requests.length = 0;
    await check("knowledge + knowledge:financial adds financial, and only it", async () => {
      const res = await server.call("knowledge_search", { query: "halifax" });
      assert.ok(!res.isError, res.text);
      const req = brain.state.requests.find((r) => r.url === "/knowledge/search");
      assert.deepEqual((req.categories || "").split(",").sort(), ["financial", "homelab", "projects"]);
    });
  });

  // knowledge:* is the deliberate "everything" grant
  hub.state.access = brainGrant({ actions: ["knowledge:*"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    brain.state.requests.length = 0;
    await check("knowledge:* grants every category", async () => {
      const res = await server.call("knowledge_search", { query: "anything" });
      assert.ok(!res.isError, res.text);
      const req = brain.state.requests.find((r) => r.url === "/knowledge/search");
      assert.deepEqual((req.categories || "").split(",").sort(), [
        "email",
        "financial",
        "homelab",
        "personal",
        "projects",
      ]);
    });
  });

  // no knowledge action at all -> refused, and nothing reaches the data plane
  hub.state.access = brainGrant({ actions: ["search"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    brain.state.requests.length = 0;
    await check("no knowledge action means no documents at all", async () => {
      const res = await server.call("knowledge_search", { query: "anything" });
      assert.ok(res.isError);
      assert.equal(brain.state.requests.filter((r) => r.url === "/knowledge/search").length, 0);
    });
  });

  await hub.close();
  await brain.close();
}

// 8. the asset register — how the estate stays current across agents
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  const cred = writeCred(hub.url);

  hub.state.access = brainGrant({ actions: ["search", "knowledge", "ingest", "forget"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("a fact can be recorded", async () => {
      const res = await server.call("brain_asset_set", { key: "ip/archive-host", value: "192.0.2.20", note: "moved" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /ip\/archive-host = 192\.0\.2\.20/);
    });
    await check("recording a fact sends the actor and the categories", async () => {
      brain.state.requests.length = 0;
      await server.call("brain_asset_set", { key: "ip/workstation", value: "192.0.2.69" });
      const req = brain.state.requests.find((r) => r.url === "/assets" && r.method === "PUT");
      assert.ok(req, "no PUT reached the register");
      assert.equal(req.actor, "test-agent");
      assert.deepEqual((req.categories || "").split(",").sort(), ["homelab", "projects"]);
      assert.equal(req.body.category, "homelab");
    });
    await check("a fact can be read back with its history", async () => {
      const res = await server.call("brain_asset_get", { key: "ip/archive-host" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /192\.0\.2\.20/);
      assert.match(res.text, /updated:/);
    });
    await check("facts can be listed by prefix", async () => {
      const res = await server.call("brain_asset_list", { prefix: "ip/" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /ip\/archive-host/);
    });
    await check("a financial fact is invisible to this grant", async () => {
      const res = await server.call("brain_asset_get", { key: "account/halifax" });
      assert.ok(res.isError);
      assert.match(res.text, /may not read/);
    });
    await check("writing into a category you cannot read is refused", async () => {
      brain.state.requests.length = 0;
      const res = await server.call("brain_asset_set", {
        key: "account/something",
        value: "secret",
        category: "financial",
      });
      assert.ok(res.isError);
      assert.match(res.text, /may not write category "financial"/);
      assert.equal(brain.state.requests.filter((r) => r.method === "PUT").length, 0);
    });
    await check("a fact can be removed", async () => {
      const res = await server.call("brain_asset_forget", { key: "ip/workstation" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /Removed ip\/workstation/);
    });
  });

  // the exact-assignment form: only projects, and nothing else
  hub.state.access = brainGrant({ actions: ["knowledge=projects", "ingest"] });
  await withServer(baseEnv(hub, brain, cred), async (server) => {
    await check("knowledge=projects assigns exactly projects", async () => {
      const res = await server.call("brain_asset_list", {});
      assert.ok(!res.isError, res.text);
      // ip/archive-host is homelab, so it must NOT appear
      assert.ok(!/ip\/archive-host/.test(res.text), "a homelab fact leaked into a projects-only grant");
    });
  });

  await hub.close();
  await brain.close();
}

// 9. the local grant (AI Messenger retired 2026-11-13): the gateway sets the
//    grant per server row, so authorisation must come from THIS process's env and
//    the hub — now retired — must never be contacted.
{
  const hub = await startFakeHub();
  const brain = await startFakeBrain();
  // This hub refuses everything and counts every request: the proof is that it is
  // never asked, not that its answer is ignored.
  hub.state.access = brainGrant({ allowed: false });
  const localEnv = {
    BRAIN_URL: brain.url,
    BRAIN_API_KEY: API_KEY,
    MESSENGER_HUB: hub.url,
    BRAIN_LOCAL_GRANT: "1",
    BRAIN_LOCAL_AGENT: "example-agent",
    BRAIN_LOCAL_ACTIONS: "search,remember,update,knowledge=homelab,knowledge=projects",
  };
  await withServer(localEnv, async (server) => {
    await check("a local grant works with no credential file at all", async () => {
      const res = await server.call("brain_search", { query: "archive-host", scope: "shared" });
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /ArchiveHost is the main storage host server/);
    });
    await check("whoami reports the local agent, its actions and the readable categories", async () => {
      const res = await server.call("brain_whoami", {});
      assert.ok(!res.isError, res.text);
      assert.match(res.text, /example-agent/);
      assert.match(res.text, /local grant/);
      assert.match(res.text, /knowledge=homelab/);
      // knowledge=homelab,knowledge=projects is an ASSIGNMENT: exactly those two.
      assert.match(res.text, /homelab/);
      assert.match(res.text, /projects/);
    });
    await check("an action outside the local grant refuses with the granted list", async () => {
      const res = await server.call("brain_forget", { memory_id: "mem_123" });
      assert.ok(res.isError);
      assert.match(res.text, /example-agent/);
      assert.match(res.text, /"forget"/);
      assert.match(res.text, /granted: search, remember, update/);
    });
    await check("knowledge_ingest is refused when the local grant has no ingest", async () => {
      const res = await server.call("knowledge_ingest", { path: "inbox/x.pdf" });
      assert.ok(res.isError);
      assert.match(res.text, /"ingest"/);
    });
  });
  await check("the retired hub was never contacted", async () => {
    assert.equal(hub.state.seenTokens.length, 0, "a local grant must not call the hub");
  });
  await hub.close();
  await brain.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
