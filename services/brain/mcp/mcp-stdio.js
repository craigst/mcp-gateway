"use strict";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function createMcpServer({ name, version, tools }) {
  if (!name) {
    throw new Error("MCP server name is required");
  }

  const toolEntries = Object.entries(tools || {});
  const toolList = toolEntries.map(([toolName, tool]) => ({
    name: toolName,
    description: tool.description || "",
    inputSchema: tool.inputSchema || {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  }));

  let framingMode = null;

  function sendMessage(payload) {
    const json = JSON.stringify(payload);

    if (framingMode === "content-length") {
      const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}`;
      process.stdout.write(`${header}\r\n\r\n${json}`);
      return;
    }

    process.stdout.write(`${json}\n`);
  }

  function sendResponse(id, result) {
    if (id === undefined || id === null) return;
    sendMessage({ jsonrpc: "2.0", id, result });
  }

  function sendError(id, code, message, data) {
    if (id === undefined || id === null) return;
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sendMessage({ jsonrpc: "2.0", id, error });
  }

  function normalizeToolResult(result) {
    if (result && typeof result === "object" && Array.isArray(result.content)) {
      return result;
    }

    const text =
      typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);

    return {
      content: [{ type: "text", text }],
    };
  }

  async function handleRequest(message) {
    if (!message || message.jsonrpc !== "2.0" || !message.method) {
      return;
    }

    const { id, method, params } = message;

    try {
      if (method === "initialize") {
        const protocolVersion =
          params && typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;

        sendResponse(id, {
          protocolVersion,
          capabilities: {
            tools: { list: true, call: true },
            resources: { list: false, read: false },
            prompts: { list: false },
          },
          serverInfo: { name, version: version || "0.1.0" },
        });
        return;
      }

      if (method === "tools/list") {
        sendResponse(id, { tools: toolList });
        return;
      }

      if (method === "tools/call") {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        const tool = toolName ? tools[toolName] : null;

        if (!tool) {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
        }

        try {
          const result = await tool.handler(toolArgs);
          sendResponse(id, normalizeToolResult(result));
        } catch (error) {
          const messageText = error && error.message ? error.message : String(error);
          sendResponse(id, {
            content: [{ type: "text", text: messageText }],
            isError: true,
          });
        }

        return;
      }

      if (method === "prompts/list") {
        sendResponse(id, { prompts: [] });
        return;
      }

      if (method === "resources/list") {
        sendResponse(id, { resources: [] });
        return;
      }

      if (id !== undefined && id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const messageText = error && error.message ? error.message : String(error);
      sendError(id, -32000, messageText);
    }
  }

  let buffer = Buffer.alloc(0);

  function parseContentLengthFrame() {
    const headerEndCrlf = buffer.indexOf("\r\n\r\n");
    const headerEndLf = buffer.indexOf("\n\n");
    let headerEnd = -1;
    let separatorLength = 0;

    if (headerEndCrlf !== -1) {
      headerEnd = headerEndCrlf;
      separatorLength = 4;
    } else if (headerEndLf !== -1) {
      headerEnd = headerEndLf;
      separatorLength = 2;
    }

    if (headerEnd === -1) return false;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return false;

    const contentLength = Number.parseInt(match[1], 10);
    const messageStart = headerEnd + separatorLength;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) return false;

    const body = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    try {
      const message = JSON.parse(body);
      framingMode = "content-length";
      void handleRequest(message);
    } catch {
      // Ignore malformed frame.
    }

    return true;
  }

  function parseLineFrame() {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) return false;

    const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) return true;

    try {
      const message = JSON.parse(line);
      framingMode = "line";
      void handleRequest(message);
    } catch {
      // Ignore malformed line.
    }

    return true;
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (parseContentLengthFrame()) continue;
      if (parseLineFrame()) continue;
      break;
    }
  });

  process.stdin.resume();
}

module.exports = {
  createMcpServer,
  DEFAULT_PROTOCOL_VERSION,
};
