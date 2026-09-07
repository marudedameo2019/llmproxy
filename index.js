import http from "http";
import fs from "fs";
import { Agent, fetch } from 'undici';

const longTimeoutAgent = new Agent({
  headersTimeout: 7200000,
  bodyTimeout: 0,
});

function usage() {
  console.log(
    [
      "usage: node index.js [options]",
      "",
      "options:",
      "  -t, --target <url>  upstream target URL (env: LLMPROXY_TARGET, default: http://localhost:8080)",
      "  -p, --port <n>      listen port (env: LLMPROXY_PORT, default: 8081)",
      "  -h, --help          show this help",
    ].join("\n")
  );
}

function fail(msg) {
  console.error(`llmproxy: ${msg}`);
  console.error("run with --help for usage");
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    target: process.env.LLMPROXY_TARGET ?? "http://localhost:8080",
    port: process.env.LLMPROXY_PORT ?? "8081",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "-t":
      case "--target":
        opts.target = next();
        break;
      case "-p":
      case "--port":
        opts.port = next();
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid port: ${opts.port}`);
  }
  let target;
  try {
    target = new URL(opts.target);
  } catch {
    fail(`invalid target URL: ${opts.target}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    fail(`target must be an http(s) URL: ${opts.target}`);
  }
  return { target: target.href.replace(/\/+$/, ""), port };
}

const { target: TARGET, port: PORT } = parseArgs(process.argv.slice(2));
let requestNo = 0;

function mergeChunk(state, json) {
  if (json.id) state.id = json.id;
  if (json.created) state.created = json.created;
  if (json.model) state.model = json.model;
  if (json.usage) state.usage = json.usage;

  for (const choice of json.choices ?? []) {
    const i = choice.index ?? 0;
    if (choice.finish_reason) state.finishReasons[i] = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") {
      state.contents[i] = (state.contents[i] ?? "") + delta.content;
    }
    if (typeof delta.reasoning_content === "string") {
      state.reasoningContents[i] = (state.reasoningContents[i] ?? "") + delta.reasoning_content;
    }
    for (const tc of delta.tool_calls ?? []) {
      const j = tc.index ?? 0;
      if (!state.toolCalls.has(j)) {
        state.toolCalls.set(j, {
          index: j,
          id: tc.id ?? null,
          type: "function",
          function: { name: "", arguments: "" },
        });
      }
      const cur = state.toolCalls.get(j);
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
  }
}

async function recordSSE(stream, filename) {
  const state = {
    id: null,
    created: null,
    model: null,
    usage: null,
    contents: [],
    reasoningContents: [],
    finishReasons: [],
    toolCalls: new Map(),
  };

  const decoder = new TextDecoder();
  let buf = "";

  const handleEvent = (rawEvent) => {
    for (const line of rawEvent.replace(/\r/g, "").split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        mergeChunk(state, JSON.parse(data));
      } catch {
        // 不正なJSONはスキップ
      }
    }
  };

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleEvent(buf);

  const n = Math.max(state.contents.length, state.finishReasons.length, 1);
  const choices = [];
  for (let i = 0; i < n; i++) {
    const message = { role: "assistant" };
    if (state.reasoningContents[i] !== undefined) message.reasoning_content = state.reasoningContents[i];
    if (state.contents[i] !== undefined) message.content = state.contents[i];
    if (i === 0 && state.toolCalls.size) {
      message.tool_calls = [...state.toolCalls.values()].sort((a, b) => a.index - b.index);
    }
    choices.push({ index: i, message, finish_reason: state.finishReasons[i] ?? null });
  }

  const result = {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices,
  };
  if (state.usage) result.usage = state.usage;

  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
}

async function recordRaw(stream, filename) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  fs.writeFileSync(filename, Buffer.concat(chunks));
}

const server = http.createServer(async (req, res) => {
  console.log(`requested: ${req.url}, ${req.method}, ${JSON.stringify(req.headers)}`);
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);

  const isChat = req.url === "/v1/chat/completions";
  let no;

  if (isChat) {
    no = ++requestNo;
    fs.writeFileSync(`request-${no}.json`, body);
    console.log(`saved: request-${no}.json`);
  }

  let response;
  try {
    response = await fetch(TARGET + req.url, {
      method: req.method,
      headers: req.headers,
      body: body.length ? body : undefined,
      dispatcher: longTimeoutAgent,
    });
  } catch (err) {
    console.error("proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("proxy error: " + err.message);
    return;
  }

  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
  ]);
  const headers = {};
  for (const [key, value] of response.headers) {
    if (!hopByHop.has(key)) {
      headers[key] = value;
    }
  }

  let clientStream = response.body;
  let recordStream;
  if (isChat && response.body) {
    const contentType = response.headers.get("content-type") ?? "";
    const isSSE = contentType.includes("text/event-stream");
    [clientStream, recordStream] = response.body.tee();
    const recordFilename = `response-${no}.json`;
    const job = isSSE
      ? recordSSE(recordStream, recordFilename)
      : recordRaw(recordStream, recordFilename);
    job
      .then(() => console.log(`saved: ${recordFilename}`))
      .catch((err) => console.error(`failed to save ${recordFilename}:`, err));
  }

  try {
    res.writeHead(response.status, headers);
    if (clientStream) {
      await clientStream.pipeTo(
        new WritableStream({
          write(chunk) {
            res.write(Buffer.from(chunk));
          },
          close() {
            res.end();
          },
        })
      );
    } else {
      res.end();
    }
  } catch (err) {
    console.error("response error:", err);
    res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`proxy listening on :${PORT} (target: ${TARGET})`);
});
