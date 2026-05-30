import type { DepositedSignal, Duration } from "../types.js";
import type {
  ApiErrorBody,
  ClaimResponse,
  DepositResponse,
  RoleDescriptor,
  SessionResponse,
  ViewResponse,
  WireSignal,
} from "../server/protocol.js";

/**
 * The Stigmergy client SDK — how an agent that lives in its own process joins
 * a colony over the network.
 *
 * The surface mirrors the in-process one deliberately. In-process you write:
 *
 *     await medium.run(agent, async (ctx) => {
 *       const queue = await ctx.as(TriagerRole).view();
 *       ...
 *     });
 *
 * Remotely you write the same thing, with the role named by string and the
 * agent identified by a token instead of a registration:
 *
 *     const session = await connect({ url, token });
 *     await session.run(async (ctx) => {
 *       const queue = await ctx.as("Triager").view();
 *       ...
 *     });
 *
 * Everything an agent can do — view its slice, deposit, claim, release,
 * consolidate memory — is bounded by the server to the roles the agent was
 * declared with. There is no escape hatch on this object on purpose: locality
 * is the whole point, and over the wire it is enforced, not merely encouraged.
 */

export interface ConnectOptions {
  /** Base URL of the Stigmergy server, e.g. http://127.0.0.1:8787 */
  readonly url: string;
  /** The agent's bearer token (issued via `issueToken` / the CLI). */
  readonly token: string;
  /** Override the fetch implementation (defaults to global fetch). */
  readonly fetch?: typeof fetch;
}

export interface RunLoopOptions {
  /** Milliseconds between handler invocations. Default 1000. */
  readonly intervalMs?: number;
  /** Stop after this many invocations. Default: run until close(). */
  readonly maxTicks?: number;
}

/** A role-bounded surface, identical in shape to the in-process RoleContext. */
export interface RemoteRoleContext {
  view(): Promise<ReadonlyArray<DepositedSignal>>;
  deposit(type: string, payload: Record<string, unknown>): Promise<DepositedSignal>;
  tryClaim(signalId: string, opts: { until: Duration }): Promise<boolean>;
  release(signalId: string): Promise<void>;
}

export interface RemoteAgentSession {
  readonly agentId: string;
  readonly charter?: string;
  readonly soul?: string;
  readonly skills: Readonly<Record<string, string>>;
  readonly memory?: string;
  readonly roles: ReadonlyArray<RoleDescriptor>;

  /** Narrow to one of this agent's roles. Throws if the role isn't declared. */
  as(role: string | RoleDescriptor): RemoteRoleContext;

  /** Consolidate the agent's MEMORY document (server-side). */
  writeMemory(text: string): Promise<void>;

  /** Re-fetch the session (e.g. to pick up a charter edit). */
  refresh(): Promise<void>;

  /**
   * Run a handler loop, the network twin of `medium.run`. The handler is this
   * session. Stops on `maxTicks` or when `close()` is called.
   */
  run(handler: (ctx: RemoteAgentSession) => Promise<void>, opts?: RunLoopOptions): Promise<void>;

  /** Stop any running loop. */
  close(): void;
}

/** A non-2xx response from the server, carrying the machine code and status. */
export class StigmergyRemoteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StigmergyRemoteError";
    this.status = status;
    this.code = code;
  }
}

/** Open a session against a Stigmergy server and load the agent's identity. */
export async function connect(opts: ConnectOptions): Promise<RemoteAgentSession> {
  const session = new Session(opts);
  await session.refresh();
  return session;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class Session implements RemoteAgentSession {
  agentId = "";
  charter?: string;
  soul?: string;
  skills: Record<string, string> = {};
  memory?: string;
  roles: RoleDescriptor[] = [];

  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private stopped = false;

  constructor(opts: ConnectOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        "connect: no fetch implementation available. Pass { fetch } or run on Node 18+."
      );
    }
    this.fetchImpl = f;
  }

  as(role: string | RoleDescriptor): RemoteRoleContext {
    const name = typeof role === "string" ? role : role.name;
    const descriptor = this.roles.find((r) => r.name === name);
    if (!descriptor) {
      throw new Error(
        `Agent "${this.agentId}" is not declared with role "${name}" (declared: ${this.roles
          .map((r) => r.name)
          .join(", ")}).`
      );
    }
    return {
      view: async () => {
        const { signals } = await this.post<ViewResponse>("/view", { role: name });
        return signals.map(fromWire);
      },
      deposit: async (type, payload) => {
        if (!descriptor.writes.includes(type)) {
          throw new Error(`Role "${name}" is not permitted to deposit signal type "${type}".`);
        }
        const { signal } = await this.post<DepositResponse>("/deposit", {
          role: name,
          type,
          payload,
        });
        return fromWire(signal);
      },
      tryClaim: async (signalId, claimOpts) => {
        const { claimed } = await this.post<ClaimResponse>("/claim", {
          role: name,
          signalId,
          until: claimOpts.until,
        });
        return claimed;
      },
      release: async (signalId) => {
        await this.post("/release", { role: name, signalId });
      },
    };
  }

  async writeMemory(text: string): Promise<void> {
    await this.post("/memory", { text });
    this.memory = text;
  }

  async refresh(): Promise<void> {
    const session = await this.post<SessionResponse>("/session", {});
    this.agentId = session.agentId;
    this.charter = session.charter;
    this.soul = session.soul;
    this.skills = { ...session.skills };
    this.memory = session.memory;
    this.roles = [...session.roles];
  }

  async run(
    handler: (ctx: RemoteAgentSession) => Promise<void>,
    opts: RunLoopOptions = {}
  ): Promise<void> {
    const intervalMs = opts.intervalMs ?? 1000;
    this.stopped = false;
    let ticks = 0;
    while (!this.stopped) {
      if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
      ticks += 1;
      await handler(this);
      if (this.stopped) break;
      await sleep(intervalMs, () => this.stopped);
    }
  }

  close(): void {
    this.stopped = true;
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/v1${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    return this.unwrap<T>(res);
  }

  private async unwrap<T>(res: Response): Promise<T> {
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const errBody = parsed as ApiErrorBody;
      const code = errBody?.error?.code ?? "error";
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;
      throw new StigmergyRemoteError(res.status, code, message);
    }
    return parsed as T;
  }
}

function fromWire(w: WireSignal): DepositedSignal {
  const d: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: Date;
    originAgentId: string;
    strength?: number;
    expiresAt?: Date;
  } = {
    id: w.id,
    type: w.type,
    payload: w.payload,
    createdAt: new Date(w.createdAt),
    originAgentId: w.originAgentId,
  };
  if (w.strength !== undefined) d.strength = w.strength;
  if (w.expiresAt) d.expiresAt = new Date(w.expiresAt);
  return d as DepositedSignal;
}

async function sleep(ms: number, stopped: () => boolean): Promise<void> {
  const slice = 25;
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const chunk = Math.min(slice, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}
