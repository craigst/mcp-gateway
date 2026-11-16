#!/usr/bin/env node
"use strict";

/**
 * MCP adapter for the managed brain. Authorization comes from the local grant
 * configured for this server process. Its identity is shared by callers of that
 * process; gateway key permissions still apply, but do not create per-key brain
 * identities. The backend credential must remain private to trusted adapters.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpServer } = require("./mcp-stdio");

const VERSION = "1.2.0";

const BRAIN_URL = (process.env.BRAIN_URL || "http://mcp-gateway-brain:8000").replace(/\/+$/, "");
const DEFAULT_HUB = process.env.MESSENGER_HUB || "http://127.0.0.1:7317";
const ACL_CACHE_MS = Number(process.env.BRAIN_ACL_CACHE_MS || 30000);
const TIMEOUT_MS = Number(process.env.BRAIN_TIMEOUT_MS || 30000);

function expandHome(value) {
  return path.resolve(String(value).replace(/^~(?=$|\/)/, os.homedir()));
}

/**
 * The harness key, from a file by preference.
 *
 * A file rather than an env var for the same reason the contact credential is a
 * file: the value lives in exactly one place at mode 0600, it survives the
 * `dsh-mcp-client` env scrub, and an agent the messenger runner wakes — whose
 * environment is the runner's, not the web unit's — can still reach it. The file
 * may hold either the bare key or a `BRAIN_API_KEY=value` line.
 */
let cachedKey = null;
function brainKey() {
  if (process.env.BRAIN_API_KEY) return process.env.BRAIN_API_KEY;
  if (cachedKey) return cachedKey;
  const file = process.env.BRAIN_KEY_FILE;
  if (!file) {
    throw new Error(
      "no brain key: set BRAIN_KEY_FILE (a 0600 file) or BRAIN_API_KEY. Nothing was sent.",
    );
  }
  let text;
  try {
    text = fs.readFileSync(expandHome(file), "utf8");
  } catch (error) {
    throw new Error(`cannot read BRAIN_KEY_FILE (${file}): ${error.message}`);
  }
  const match = /^\s*(?:BRAIN_API_KEY\s*=\s*)?(\S+)\s*$/m.exec(text.trim());
  if (!match) throw new Error(`BRAIN_KEY_FILE (${file}) holds no key`);
  cachedKey = match[1];
  return cachedKey;
}

/**
 * How a grant names the parts of the brain a contact may use. Three forms, and the
 * difference between the first two is the whole reason this exists:
 *
 *   knowledge                 the NON-sensitive default (homelab + projects)
 *   knowledge:financial       that default PLUS financial      (additive)
 *   knowledge=projects        EXACTLY projects, nothing else   (assignment)
 *   knowledge:*               every category
 *
 * The additive form alone could not express "this person works on projects and
 * nothing else", because plain `knowledge` always dragged homelab in with it. The
 * `=` form is the assignment: what you name is what they get, read and write.
 */
const KNOWLEDGE_PREFIX = "knowledge:";
const KNOWLEDGE_EXACT = "knowledge=";

/** Which hub action each tool needs. `brain_whoami` needs identity, not an action. */
const REQUIRED_ACTION = {
  brain_search: "search",
  brain_stats: "search",
  brain_remember: "remember",
  brain_import_memories: "remember",
  brain_update: "update",
  brain_forget: "forget",
  knowledge_search: "knowledge",
  knowledge_ingest: "ingest",
  // The asset register: reading it is part of "knowledge", changing it is a write.
  brain_asset_get: "knowledge",
  brain_asset_list: "knowledge",
  brain_asset_set: "ingest",
  brain_asset_forget: "forget",
  brain_whoami: null,
};

/** Writes re-ask the hub every time; reads may use a short-lived cached answer. */
const WRITE_TOOLS = new Set([
  "brain_remember",
  "brain_import_memories",
  "brain_update",
  "brain_forget",
  "knowledge_ingest",
  "brain_asset_set",
  "brain_asset_forget",
]);

// ── the caller's identity ───────────────────────────────────────────────────

/**
 * Each contact gets `~/.config/ai-messenger/creds/<contact>.env`, mode 0600,
 * written by the hub. Parsing it is the ONLY way this server learns who it is:
 * there is deliberately no fallback identity, because a fallback would silently
 * turn "no credential" into "acted as somebody".
 */
function readCredFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `no caller identity: cannot read MESSENGER_CRED_FILE (${file}): ${error.message}. ` +
        "This agent has no brain access until the hub issues it a credential.",
    );
  }
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  if (!env.MESSENGER_AGENT || !env.MESSENGER_CRED) {
    throw new Error(`credential file ${file} is missing MESSENGER_AGENT or MESSENGER_CRED`);
  }
  return {
    agent: env.MESSENGER_AGENT,
    hub: (env.MESSENGER_HUB || DEFAULT_HUB).replace(/\/+$/, ""),
    token: env.MESSENGER_CRED,
    file,
  };
}

function credFile() {
  const file = process.env.MESSENGER_CRED_FILE;
  if (!file) {
    throw new Error(
      "no caller identity: MESSENGER_CRED_FILE is not set on this MCP row. " +
        "Every brain tool refuses without it — that is the design, not a misconfiguration to work around.",
    );
  }
  return path.resolve(file.replace(/^~(?=$|\/)/, os.homedir()));
}

// ── the hub's answer ────────────────────────────────────────────────────────

/** agent -> { at, access } */
const aclCache = new Map();

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── the local grant (AI Messenger retired 2026-11-13) ───────────────────────
//
// The hub used to be the only source of truth for "may THIS contact do THIS to
// the brain". When it was retired the brain would have had no way to authorise
// anyone, so a local grant answers instead: BRAIN_LOCAL_GRANT=1 reads the grant
// from THIS PROCESS'S env — which the MCP gateway sets per server row
// (`brain` and `brain-full` carry different actions) — and never calls the hub.
//
// BRAIN_LOCAL_ACTIONS uses exactly the hub's vocabulary, so the category
// derivation (`knowledge=homelab,projects`, `knowledge:*`) is untouched.
function localGrant() {
  const actions = (process.env.BRAIN_LOCAL_ACTIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    agent: process.env.BRAIN_LOCAL_AGENT || "local",
    hub: "(local grant - AI Messenger retired)",
    token: null,
    file: "(none)",
    grant: { server: "brain", allowed: true, actions },
  };
}

/**
 * A parameterised action satisfies its base: `knowledge:financial` implies the
 * `knowledge` tool is usable. Without this, naming a category explicitly would
 * be LESS capable than the plain action, which is backwards.
 */
function satisfies(actions, action) {
  return (
    actions.includes(action) ||
    actions.some((a) => a.startsWith(`${action}:`) || a.startsWith(`${action}=`))
  );
}

async function hubAccess(cred, { fresh }) {
  if (process.env.BRAIN_LOCAL_GRANT === "1") {
    // Local grant: there is no hub to ask and nothing to cache.
    return { access: [localGrant().grant] };
  }
  const cached = aclCache.get(cred.agent);
  if (!fresh && cached && Number.isFinite(ACL_CACHE_MS) && ACL_CACHE_MS > 0 && Date.now() - cached.at < ACL_CACHE_MS) {
    return cached.access;
  }
  const url = `${cred.hub}/v1/mcp/access`;
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${cred.token}`, Accept: "application/json" } },
      Math.min(TIMEOUT_MS, 10000),
    );
  } catch (error) {
    throw new Error(
      `cannot reach the messenger hub at ${cred.hub} (${error.message}); refusing ` +
        (fresh ? "a write" : "the call") +
        " rather than acting on a permission that cannot be checked",
    );
  }
  if (!response.ok) {
    throw new Error(
      `the messenger hub refused this credential (HTTP ${response.status}) for agent "${cred.agent}"; ` +
        "ask the operator to rotate it",
    );
  }
  const body = await response.json();
  aclCache.set(cred.agent, { at: Date.now(), access: body });
  return body;
}

/**
 * The one gate. Returns the credential on success; throws a message an agent can
 * act on (or repeat to its operator) on refusal.
 */
async function authorize(toolName) {
  if (process.env.BRAIN_LOCAL_GRANT === "1") {
    const local = localGrant();
    const neededLocal = REQUIRED_ACTION[toolName];
    if (neededLocal && !satisfies(local.grant.actions, neededLocal)) {
      throw new Error(
        `agent "${local.agent}" may use the brain but has no "${neededLocal}" action ` +
          `(granted: ${local.grant.actions.join(", ") || "none"}). This call needs "${neededLocal}".`,
      );
    }
    return local;
  }
  const cred = readCredFile(credFile());
  const needed = REQUIRED_ACTION[toolName];
  const access = await hubAccess(cred, { fresh: WRITE_TOOLS.has(toolName) });

  const entry = (access.access || []).find((row) => row && row.server === "brain");
  if (!entry) {
    throw new Error(
      'the hub has no MCP server registered as "brain", so this call cannot be authorised. ' +
        "Register it (POST /v1/mcp/servers) or restart the hub so it imports the mcp-brain profile row.",
    );
  }
  if (!entry.allowed) {
    const why = entry.expired ? " (the grant has expired)" : "";
    throw new Error(
      `agent "${cred.agent}" is not granted the "brain" server${why}. ` +
        "Ask the operator for a grant: messenger_mcp_grant(contact, \"brain\", actions).",
    );
  }
  // A parameterised action satisfies its base: `knowledge:financial` implies the
  // `knowledge` tool is usable. Without this, naming a category explicitly would
  // be LESS capable than the plain action, which is backwards.
  if (needed && !satisfies(entry.actions || [], needed)) {
    const have = (entry.actions || []).join(", ") || "none";
    throw new Error(
      `agent "${cred.agent}" may use the brain but has no "${needed}" action (granted: ${have}). ` +
        `This call needs "${needed}".`,
    );
  }
  cred.grant = entry;
  return cred;
}

// ── categories ──────────────────────────────────────────────────────────────

let categoryCache = null; // { at, public:[], sensitive:[], all:[] }

/**
 * The category vocabulary, from brain-api.
 *
 * Cached, because it is configuration rather than data, but NOT defaulted: if
 * brain-api cannot be reached the allowed set cannot be computed, and guessing
 * "all" would be the one failure mode worth avoiding. The call fails instead.
 */
async function categoryVocabulary() {
  if (categoryCache && Date.now() - categoryCache.at < 60000) return categoryCache;
  let response;
  try {
    response = await fetchWithTimeout(
      `${BRAIN_URL}/categories`,
      { headers: { Authorization: `Bearer ${brainKey()}`, Accept: "application/json" } },
      Math.min(TIMEOUT_MS, 15000),
    );
  } catch (error) {
    throw new Error(
      `cannot reach brain-api at ${BRAIN_URL} to resolve the category vocabulary (${error.message}); ` +
        "refusing rather than assuming which categories are public",
    );
  }
  if (!response.ok) throw new Error(`brain-api /categories returned ${response.status}`);
  const body = await response.json();
  categoryCache = {
    at: Date.now(),
    public: body.public || [],
    sensitive: body.sensitive || [],
    all: (body.categories || []).map((c) => c.name),
  };
  return categoryCache;
}

/**
 * The categories THIS caller may read, derived only from its hub grant.
 *
 *   knowledge            -> the non-sensitive categories
 *   knowledge:financial  -> adds `financial`
 *   knowledge:*          -> every category
 *
 * Anything the grant does not name is invisible, and the list is sent to
 * brain-api which enforces it again on its side.
 */
async function allowedCategories(entry) {
  const actions = entry.actions || [];
  if (actions.includes(`${KNOWLEDGE_PREFIX}*`)) {
    return (await categoryVocabulary()).all.slice();
  }
  const vocab = await categoryVocabulary();
  const allowed = new Set();

  // An EXACT assignment replaces the default rather than adding to it, so
  // `knowledge=projects` really does mean projects alone.
  const exact = actions.filter((a) => a.startsWith(KNOWLEDGE_EXACT));
  if (exact.length > 0) {
    for (const action of exact) {
      for (const name of action.slice(KNOWLEDGE_EXACT.length).split(",")) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        if (trimmed === "*") return vocab.all.slice();
        if (!vocab.all.includes(trimmed)) {
          throw new Error(
            `grant names an unknown category "${trimmed}" (known: ${vocab.all.join(", ")})`,
          );
        }
        allowed.add(trimmed);
      }
    }
    return [...allowed].sort();
  }

  if (actions.includes("knowledge")) for (const c of vocab.public) allowed.add(c);
  for (const action of actions) {
    if (!action.startsWith(KNOWLEDGE_PREFIX)) continue;
    const name = action.slice(KNOWLEDGE_PREFIX.length);
    if (vocab.all.includes(name)) allowed.add(name);
  }
  return [...allowed].sort();
}

// ── the data plane ──────────────────────────────────────────────────────────

async function apiRequest(cred, method, pathname, body = null, categories = null) {
  const key = brainKey();
  let response;
  try {
    response = await fetchWithTimeout(
      `${BRAIN_URL}${pathname}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Brain-Actor": cred.agent,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(categories ? { "X-Brain-Allowed-Categories": categories.join(",") } : {}),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      },
      TIMEOUT_MS,
    );
  } catch (error) {
    throw new Error(`brain-api at ${BRAIN_URL} is unreachable (${error.message})`);
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const detail = parsed && parsed.detail ? parsed.detail : text.slice(0, 300);
    throw new Error(`brain-api ${method} ${pathname} returned ${response.status}: ${detail}`);
  }
  return parsed;
}

async function apiPost(cred, pathname, body, categories = null) {
  // Resolved (and its absence reported) before the request, so a missing key is a
  // clear refusal rather than a 401 from a call that already went out.
  const key = brainKey();
  let response;
  try {
    response = await fetchWithTimeout(
      `${BRAIN_URL}${pathname}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          // The audit trail's actor. brain-api trusts this *claim*; the proof of
          // identity happened one step above, against the hub.
          "X-Brain-Actor": cred.agent,
          // The access boundary, asserted by THIS layer from the hub grant and
          // enforced again by brain-api. It is never taken from the agent — if it
          // were, an agent would simply name every category.
          ...(categories ? { "X-Brain-Allowed-Categories": categories.join(",") } : {}),
        },
        body: JSON.stringify(body || {}),
      },
      TIMEOUT_MS,
    );
  } catch (error) {
    throw new Error(`brain-api at ${BRAIN_URL} is unreachable (${error.message})`);
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const detail = (parsed && (parsed.detail || parsed.raw)) || text || response.statusText;
    throw new Error(`brain-api ${response.status}: ${detail}`);
  }
  return parsed;
}

// The brain host distils remembered text with a SECOND model call (Mem0's fact
// extraction). That step can fail while the data plane is perfectly healthy —
// observed 2026-10-07 as
//   `brain-api 502: memory backend: LLM extraction failed: prediction aborted,
//    token repeat limit reached (status code: 500)`
// — and the caller's fact was then lost entirely. A verbatim memory is less
// tidy than extracted atomic facts, and enormously better than silence.
const EXTRACTION_FALLBACK_NOTE =
  "\n(Note: the brain host's fact-extraction step failed, so this text was stored " +
  "VERBATIM as a single memory instead of being distilled into atomic facts.)";

const EXTRACTION_FAILURE_MARKERS = [
  "extraction failed",
  "token repeat limit",
  "memory backend",
];

/**
 * Is this failure one that storing the text verbatim would survive?
 *
 * Only server-side faults (5xx / no status) qualify. A 4xx means the request
 * itself was refused — wrong shape, no permission, bad category — and asking
 * again with `infer:false` would be refused identically, so it is not retried.
 */
function isExtractionFailure(error) {
  const message = String((error && error.message) || error || "");
  const lower = message.toLowerCase();
  const statusMatch = message.match(/returned\s+(\d{3})/i) || message.match(/brain-api\s+(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status !== null && status < 500) return false;
  return EXTRACTION_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

function render(results) {
  if (!Array.isArray(results) || results.length === 0) return "No memories matched.";
  return results
    .map((row, index) => {
      const id = row && row.id ? row.id : "(no id)";
      const memory = (row && (row.memory || row.data)) || JSON.stringify(row);
      const score = row && typeof row.score === "number" ? ` score=${row.score.toFixed(3)}` : "";
      const meta = (row && row.metadata) || {};
      const bits = [];
      if (meta.source_ref) bits.push(`source=${meta.source_ref}`);
      if (row && row.agent_id) bits.push(`agent=${row.agent_id}`);
      if (row && row.user_id) bits.push(`scope=${row.user_id}`);
      const suffix = bits.length ? `  [${bits.join(" ")}]` : "";
      return `${index + 1}. ${memory}\n   id=${id}${score}${suffix}`;
    })
    .join("\n");
}

// ── tools ───────────────────────────────────────────────────────────────────

const SCOPE = {
  type: "string",
  description:
    "Namespace: shared (default, everyone) | homelab | media | work | vehicles | agents/<contact> (that agent only).",
};

const tools = {
  brain_whoami: {
    description:
      "Report which contact this harness is, and exactly what the hub grants it on the brain. " +
      "Use it when a brain tool refuses, before asking the operator for anything.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const cred = await authorize("brain_whoami");
      const access = await hubAccess(cred, { fresh: true });
      const entry = (access.access || []).find((row) => row && row.server === "brain") || null;
      let readable = [];
      let categoryNote = null;
      try {
        readable = await allowedCategories(entry);
      } catch (error) {
        categoryNote = error.message;
      }
      return {
        agent: cred.agent,
        credentialFile: cred.file,
        hub: cred.hub,
        brainApi: BRAIN_URL,
        granted: Boolean(entry && entry.allowed),
        actions: (entry && entry.actions) || [],
        documentCategoriesReadable: readable,
        ...(categoryNote ? { categoryError: categoryNote } : {}),
        expiresAt: entry ? entry.expiresAt : null,
        note:
          "knowledge = the non-sensitive default (homelab + projects); " +
          "knowledge:financial = that plus financial; " +
          "knowledge=projects = exactly projects (an assignment); " +
          "knowledge:* = everything. Writing needs \"ingest\" and is limited to the " +
          "categories you can already read.",
      };
    },
  },

  brain_search: {
    description:
      "Search long-term memory: facts, preferences, decisions and events other agents have learned. " +
      'Ask this before asking a human "what did we decide about X". Returns each memory with its ' +
      "provenance (source_ref and the agent that recorded it).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        scope: SCOPE,
        top_k: { type: "number", description: "Maximum results (default 8, max 50)." },
        threshold: { type: "number", description: "Minimum similarity 0-1." },
        include_agent_private: {
          type: "boolean",
          description: "Also search this agent's own agents/<contact> scope (default false).",
        },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_search");
      const body = {
        query: String(args.query || ""),
        scope: args.scope || "shared",
        top_k: Math.min(Number(args.top_k) || 8, 50),
        include_agent_private: Boolean(args.include_agent_private),
      };
      if (args.threshold !== undefined) body.threshold = Number(args.threshold);
      const out = await apiPost(cred, "/memory/search", body);
      return `${out.count} memory result(s) in scope "${body.scope}":\n${render(out.results)}`;
    },
  },

  brain_remember: {
    description:
      "Record a durable fact, preference, decision or event so other agents can find it later. " +
      "Prefer one atomic fact per call. Pass source_ref whenever there is a source — an " +
      "unattributable memory is a rumour. Do NOT use this to dump a transcript.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, in one or two sentences." },
        scope: SCOPE,
        source_ref: {
          type: "string",
          description: "Where this came from: a file path, a URL, a message id, a log excerpt.",
        },
        metadata: { type: "object", description: "Extra structured labels." },
        ttl_days: { type: "number", description: "Expire the memory after N days (default: never)." },
        infer: {
          type: "boolean",
          description:
            "true (default) lets Mem0 extract atomic facts from the text; false stores the text verbatim.",
        },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_remember");
      const wantInfer = args.infer === undefined ? true : Boolean(args.infer);
      const body = {
        text: String(args.text || ""),
        scope: args.scope || "shared",
        source_ref: args.source_ref || null,
        metadata: args.metadata || null,
        ttl_days: args.ttl_days ? Number(args.ttl_days) : null,
        infer: wantInfer,
      };
      let out;
      let degraded = "";
      try {
        out = await apiPost(cred, "/memory/add", body);
      } catch (error) {
        if (!wantInfer || !isExtractionFailure(error)) throw error;
        // One retry only, and only in the direction that removes the failing
        // step. If THIS fails the caller hears the second error, so a broken
        // backend still reports honestly instead of looping.
        out = await apiPost(cred, "/memory/add", { ...body, infer: false });
        degraded = EXTRACTION_FALLBACK_NOTE;
      }
      const summary = out.created
        ? `Recorded ${out.created} memory/memories in scope "${out.scope}".`
        : "Nothing new was recorded (Mem0 judged it redundant).";
      return `${summary}${degraded}\n${render(out.results)}`;
    },
  },

  brain_import_memories: {
    description:
      "Import up to 100 verbatim memories from an external system. Supply a stable source and external ID for each item; retries are idempotent and preserve provenance. A conflicting ID is refused.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Stable name of the external memory source." },
        items: { type: "array", minItems: 1, maxItems: 100, items: {
          type: "object", properties: {
            external_id: { type: "string", description: "Stable identifier in the source system." },
            text: { type: "string", description: "Memory text, stored verbatim." },
            scope: SCOPE,
            source_ref: { type: "string", description: "Original location or citation." },
            created_at: { type: "string", description: "Original ISO timestamp, including timezone." },
            metadata: { type: "object", description: "Non-privileged provenance metadata." },
          }, required: ["external_id", "text"],
        } },
      },
      required: ["source", "items"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_import_memories");
      if (typeof args.source !== "string" || !args.source.trim() || !Array.isArray(args.items) || args.items.length < 1 || args.items.length > 100) {
        throw new Error("Provide a source and between 1 and 100 memory items.");
      }
      const out = await apiPost(cred, "/memory/import", { source: args.source.trim(), items: args.items });
      return JSON.stringify(out, null, 2);
    },
  },

  brain_update: {
    description: "Correct an existing memory by id — when a fact has changed, rather than adding a second one.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "The id returned by brain_search or brain_remember." },
        text: { type: "string", description: "The new content." },
        metadata: { type: "object", description: "Metadata fields to merge." },
      },
      required: ["memory_id"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_update");
      const out = await apiPost(cred, "/memory/update", {
        memory_id: String(args.memory_id),
        text: args.text === undefined ? null : String(args.text),
        metadata: args.metadata || null,
      });
      return `Updated ${args.memory_id}.\n${JSON.stringify(out.result, null, 2)}`;
    },
  },

  brain_forget: {
    description:
      "Delete a memory by id, every memory in a scope, or an ingested DOCUMENT by id. Deleting is real " +
      "and immediate: a document's passages, its catalogue row and its stored copy all go. A scope wipe " +
      "is an operator action, not an agent convenience.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Delete this one memory." },
        scope: { type: "string", description: "Or delete every memory in this scope." },
        document_id: {
          type: "number",
          description:
            "Or delete this ingested document (the `document_id` returned by knowledge_search / knowledge_ingest).",
        },
      },
    },
    handler: async (args) => {
      const cred = await authorize("brain_forget");
      if (args.document_id !== undefined && args.document_id !== null) {
        const out = await apiPost(cred, "/knowledge/forget", { document_id: Number(args.document_id) });
        return `Forgotten document ${out.document_id} (${out.filename}); files removed: ${(out.files_removed || []).length}.`;
      }
      const out = await apiPost(cred, "/memory/forget", {
        memory_id: args.memory_id ? String(args.memory_id) : null,
        scope: args.scope ? String(args.scope) : null,
      });
      return `Forgotten: ${JSON.stringify(out.result)}`;
    },
  },

  brain_stats: {
    description: "Counts and the recent audit trail: what the brain holds, and who has been using it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Recent events to return (default 20)." },
      },
    },
    handler: async (args) => {
      const cred = await authorize("brain_stats");
      const url = new URL(`${BRAIN_URL}/stats`);
      url.searchParams.set("limit", String(Math.min(Number(args.limit) || 20, 100)));
      let response;
      try {
        response = await fetchWithTimeout(
          url.toString(),
          { headers: { Authorization: `Bearer ${brainKey()}`, "X-Brain-Actor": cred.agent } },
          TIMEOUT_MS,
        );
      } catch (error) {
        throw new Error(`brain-api at ${BRAIN_URL} is unreachable (${error.message})`);
      }
      if (!response.ok) throw new Error(`brain-api ${response.status}: ${await response.text()}`);
      return JSON.stringify(await response.json(), null, 2);
    },
  },

  knowledge_search: {
    description:
      "Search document knowledge: scanned letters, PDFs, manuals, spreadsheets and archived email that " +
      "have been ingested. Returns the passage, ITS CATEGORY, and the ORIGINAL FILE it came from — cite " +
      "that path, and read the file itself if you need more than the passage. " +
      "You can only see the categories your grant allows; the filter is applied by the service, not by " +
      "you, so there is nothing to widen.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        path_prefix: { type: "string", description: "Restrict to originals under this path." },
        top_k: { type: "number", description: "Maximum passages (default 8, max 30)." },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const cred = await authorize("knowledge_search");
      const categories = await allowedCategories(cred.grant);
      if (categories.length === 0) {
        throw new Error(
          `agent "${cred.agent}" has no readable document categories. Its grant needs "knowledge" ` +
            "(for homelab/projects) or an explicit \"knowledge:<category>\" for anything sensitive.",
        );
      }
      const out = await apiPost(
        cred,
        "/knowledge/search",
        {
          query: String(args.query || ""),
          path_prefix: args.path_prefix || null,
          top_k: Math.min(Number(args.top_k) || 8, 30),
        },
        categories,
      );
      const facts = out.current_facts || [];
      const factBlock = facts.length
        ? "CURRENT FACTS from the register (these outrank the passages below):\n" +
          facts.map((f) => `  ${f.key} = ${f.value}${f.note ? `  (${f.note})` : ""}`).join("\n") +
          "\n\n"
        : "";
      const searched = out.categories_searched || categories;
      if (!out.results || out.results.length === 0) {
        return `${factBlock}No document passages matched (searched: ${searched.join(", ")}).`;
      }
      return (
        factBlock +
        `Searched categories: ${searched.join(", ")}\n\n` +
        out.results
          .map((row, index) => {
            const head = `${index + 1}. [${row.category || "?"}] ${row.original_path}${row.page ? ` (page ${row.page})` : ""}`;
            return `${head}\n${(row.text || "").trim()}`;
          })
          .join("\n\n")
      );
    },
  },

  knowledge_ingest: {
    description:
      "Ingest one file (or a directory) into document knowledge: OCR if it is a scan, extract text and " +
      "metadata, chunk, embed, and index it. Idempotent by content hash — re-ingesting the same bytes " +
      "changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path on the hub's document share, e.g. inbox/letter.pdf." },
        source_kind: { type: "string", description: "Label for the audit trail (default inbox)." },
        category: {
          type: "string",
          description:
            "Which category the document belongs to. Defaults to the most restrictive one. You may only " +
            "write a category your own grant allows you to read.",
        },
      },
      required: ["path"],
    },
    handler: async (args) => {
      const cred = await authorize("knowledge_ingest");
      const categories = await allowedCategories(cred.grant);
      const category = args.category ? String(args.category) : "personal";
      if (!categories.includes(category)) {
        throw new Error(
          `agent "${cred.agent}" may not write category "${category}" — it may write: ` +
            (categories.join(", ") || "nothing"),
        );
      }
      const out = await apiPost(
        cred,
        "/knowledge/ingest",
        {
          path: String(args.path || ""),
          source_kind: args.source_kind || "inbox",
          category,
        },
        categories,
      );
      return `Ingested into "${out.category}": ${JSON.stringify(out, null, 2)}`;
    },
  },
  brain_asset_get: {
    description:
      "Read ONE current fact from the asset register — an IP address, a device location, a folder or file " +
      "path, a project, a port. Returns the value, who last changed it and when, and its recent history. " +
      "Prefer this to searching documents for infrastructure facts: a document may be months old and there " +
      "may be several disagreeing, while the register is the current answer.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Namespaced key, e.g. ip/archive-host, device/pi5-doc, path/sample-env, project/sample-project",
        },
      },
      required: ["key"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_asset_get");
      const cats = await allowedCategories(cred.grant);
      const out = await apiRequest(cred, "GET", `/assets/${encodeURI(String(args.key || ""))}`, null, cats);
      const a = out.asset;
      const lines = [
        `${a.key} = ${a.value}`,
        `  category: ${a.category}   updated: ${a.updated_at} by ${a.updated_by || "?"}`,
      ];
      if (a.note) lines.push(`  note: ${a.note}`);
      if (out.recent_changes && out.recent_changes.length > 1) {
        lines.push("  history (newest first):");
        for (const h of out.recent_changes) {
          lines.push(`    ${h.changed_at} ${h.changed_by || "?"} -> ${h.value}`);
        }
      }
      return lines.join("\n");
    },
  },
  brain_asset_list: {
    description:
      "List the current facts in the asset register that you are allowed to see, optionally filtered by key " +
      "prefix ('ip/' for every address, 'device/' for every machine, 'path/' for locations). Use it to see " +
      "what the estate looks like right now.",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string", description: "Key prefix, e.g. 'ip/' or 'project/'" } },
    },
    handler: async (args) => {
      const cred = await authorize("brain_asset_list");
      const cats = await allowedCategories(cred.grant);
      const qs = args.prefix ? `?prefix=${encodeURIComponent(String(args.prefix))}` : "";
      const out = await apiRequest(cred, "GET", `/assets${qs}`, null, cats);
      if (!out.assets || out.assets.length === 0) {
        return `No facts in the register for you${args.prefix ? ` under '${args.prefix}'` : ""}.`;
      }
      return (
        `${out.count} facts (from: ${out.categories_searched.join(", ")})\n` +
        out.assets.map((a) => `${a.key} = ${a.value}${a.note ? `  (${a.note})` : ""}`).join("\n")
      );
    },
  },
  brain_asset_set: {
    description:
      "Record the CURRENT value of one fact — an IP address, a device location, a folder path, a port. This " +
      "is how the estate stays current for every other agent. Updating an existing key overwrites it and " +
      "keeps the old value in history, so the next agent can see what moved and when. If a fact has " +
      "changed, update it here rather than writing a note only you will see.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Namespaced key, e.g. ip/archive-host, path/sample-env, device/workstation" },
        value: { type: "string", description: "The current answer." },
        category: {
          type: "string",
          description:
            "Which part of the brain this belongs to (default homelab). You may only write a category your " +
            "grant allows you to read.",
        },
        note: { type: "string", description: "Why, or what it means. Shown alongside the value." },
      },
      required: ["key", "value"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_asset_set");
      const cats = await allowedCategories(cred.grant);
      const category = args.category ? String(args.category) : cats.includes("homelab") ? "homelab" : cats[0];
      if (!cats.includes(category)) {
        throw new Error(
          `agent "${cred.agent}" may not write category "${category}" — it may write: ` +
            (cats.join(", ") || "nothing"),
        );
      }
      const out = await apiRequest(
        cred,
        "PUT",
        "/assets",
        { key: String(args.key || ""), value: String(args.value || ""), category, note: args.note || null },
        cats,
      );
      if (!out.changed) return `${out.key} already reads "${out.value}" — nothing changed.`;
      const was = out.previous ? ` (was: ${out.previous})` : "";
      return `${out.created ? "Recorded" : "Updated"} ${out.key} = ${out.value}${was}`;
    },
  },
  brain_asset_forget: {
    description:
      "Remove a fact from the asset register because it is no longer true of anything — a decommissioned " +
      "host, a path that no longer exists. Prefer updating a value over deleting a key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "The key to remove." } },
      required: ["key"],
    },
    handler: async (args) => {
      const cred = await authorize("brain_asset_forget");
      const cats = await allowedCategories(cred.grant);
      const out = await apiRequest(cred, "DELETE", `/assets/${encodeURI(String(args.key || ""))}`, null, cats);
      return `Removed ${out.key} from the register.`;
    },
  },
};

createMcpServer({ name: "brain", version: VERSION, tools });
