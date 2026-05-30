import type { IncomingMessage, ServerResponse } from "node:http";
import { mediumState } from "../medium.js";
import type { Medium } from "../types.js";
import { authenticate } from "./auth.js";
import { HttpError } from "./errors.js";
import {
  handleClaim,
  handleDeposit,
  handleHealth,
  handleMemory,
  handleRelease,
  handleSession,
  handleView,
} from "./handlers.js";
import { API_BASE } from "./protocol.js";

/**
 * The HTTP request listener — a tiny router over node:http, no framework. It
 * does four things and nothing else: route by method+path, read and bound the
 * JSON body, authenticate (everything but health), and turn handler return
 * values or thrown HttpErrors into JSON responses.
 */

export interface RouterOptions {
  readonly maxBodyBytes?: number;
  readonly instanceId?: string;
}

type AuthedHandler = (
  deps: { medium: Medium; instanceId?: string },
  agentId: string,
  body: unknown
) => Promise<unknown>;

const AUTHED_ROUTES: Record<string, AuthedHandler> = {
  "/session": (deps, agentId) => handleSession(deps, agentId),
  "/view": handleView,
  "/deposit": handleDeposit,
  "/claim": handleClaim,
  "/release": handleRelease,
  "/memory": handleMemory,
};

export function createRequestListener(
  medium: Medium,
  opts: RouterOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;
  const deps = { medium, instanceId: opts.instanceId };

  return (req, res) => {
    void handle(req, res).catch((err) => {
      // Last-resort guard — handle() already maps known errors. Anything
      // reaching here is a bug; don't leak details.
      console.error("[stigmergy] unhandled server error:", err);
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    try {
      if (!path.startsWith(API_BASE)) {
        throw new HttpError(404, "not_found", `No route for ${method} ${path}`);
      }
      const route = path.slice(API_BASE.length) || "/";

      if (route === "/health" && method === "GET") {
        sendJson(res, 200, await handleHealth(deps));
        return;
      }

      const handler = AUTHED_ROUTES[route];
      if (!handler) throw new HttpError(404, "not_found", `No route for ${method} ${path}`);
      if (method !== "POST") {
        throw new HttpError(405, "method_not_allowed", `${method} not allowed on ${path}`);
      }

      const state = mediumState(medium);
      if (!state) throw new HttpError(500, "internal", "Server is not bound to a valid medium.");

      const auth = await authenticate(state.client, header(req, "authorization"));
      if (!auth) throw new HttpError(401, "unauthorized", "Missing or invalid bearer token.");

      const body = await readJsonBody(req, maxBodyBytes);
      sendJson(res, 200, await handler(deps, auth.agentId, body));
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      console.error("[stigmergy] server error:", err);
      sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, "payload_too_large", `Request body exceeds ${limit} bytes.`);
    }
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "Request body is not valid JSON.");
  }
}
