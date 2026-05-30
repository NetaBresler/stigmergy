import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Medium } from "../types.js";
import { type WorkerOptions, ensureWorkers } from "../workers.js";
import { createRequestListener } from "./router.js";

/**
 * serve(medium, opts) — run a colony as network infrastructure.
 *
 * The server owns the medium: it holds the database connection, runs the
 * background workers (decay sweep + validator dispatch), and exposes the
 * agent-bounded operations over HTTP for agents that live elsewhere. It does
 * NOT run agent handlers — those connect from their own processes via the
 * client SDK (src/client) or any HTTP client.
 *
 * Put TLS termination and rate limiting in front of this (a reverse proxy);
 * the server speaks plain HTTP and trusts the bearer token on each request, so
 * it must only be reachable over a trusted channel.
 */

export interface ServeOptions extends WorkerOptions {
  /** Port to listen on. Default 8787. Use 0 for an ephemeral port (tests). */
  readonly port?: number;
  /** Interface to bind. Default "127.0.0.1". Use "0.0.0.0" to accept remote. */
  readonly host?: string;
  /** Run `medium.migrate()` before listening. Default false. */
  readonly migrate?: boolean;
  /** Start the background workers. Default true. */
  readonly startWorkers?: boolean;
  /** Max request body size in bytes. Default 1_000_000. */
  readonly maxBodyBytes?: number;
}

export interface ServerHandle {
  /** The bound port (resolved, even when `port: 0` was requested). */
  readonly port: number;
  /** The base URL agents connect to, e.g. http://127.0.0.1:8787 */
  readonly url: string;
  /** This instance's worker identity (for lease ownership / debugging). */
  readonly instanceId: string;
  /** Stop accepting connections and stop the background workers. */
  close(): Promise<void>;
}

export async function serve(medium: Medium, opts: ServeOptions = {}): Promise<ServerHandle> {
  if (opts.migrate) await medium.migrate();

  // ServeOptions extends WorkerOptions, so the worker fields pass straight
  // through; ensureWorkers ignores the server-only extras.
  const workers = (opts.startWorkers ?? true) ? ensureWorkers(medium, opts) : undefined;
  const instanceId = workers?.instanceId ?? opts.instanceId ?? "server";

  const server = createServer(
    createRequestListener(medium, { instanceId, maxBodyBytes: opts.maxBodyBytes })
  );
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 8787;

  await listen(server, requestedPort, host);

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://${displayHost(host)}:${port}`;

  return {
    port,
    url,
    instanceId,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (workers) await workers.stop();
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function displayHost(host: string): string {
  // "0.0.0.0" / "::" aren't useful in a connect URL; show loopback instead.
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host;
}
