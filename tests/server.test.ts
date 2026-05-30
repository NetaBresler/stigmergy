import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Medium,
  type ServerHandle,
  StigmergyRemoteError,
  connect,
  defineMedium,
  issueToken,
  pgliteClient,
  serve,
} from "../src/index.js";

/**
 * Network-layer tests. A server is stood up over real HTTP (ephemeral port)
 * against in-process PGlite; the client SDK connects over the loopback. The
 * point of these tests is the trust boundary: an authenticated agent can do
 * exactly what its roles permit and nothing else.
 */

function defineColony(medium: Medium) {
  const reportedBug = medium.defineSignal({
    type: "reported_bug",
    decay: { kind: "strength", factor: 0.5, period: "30s", floor: 0.05 },
    shape: z.object({
      title: z.string(),
      component: z.string(),
      severity: z.number(),
      body: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });
  const triageNote = medium.defineSignal({
    type: "triage_note",
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      bug_id: z.string(),
      bug_title: z.string(),
      verdict: z.enum(["confirm", "duplicate", "invalid"]),
      body: z.string(),
      recommended_boost: z.number(),
    }),
  });

  const ReporterRole = medium.defineRole({
    name: "Reporter",
    reads: [reportedBug],
    writes: [reportedBug],
    localQuery: { types: ["reported_bug"], limit: 50 },
  });
  const TriagerRole = medium.defineRole({
    name: "Triager",
    reads: [reportedBug],
    writes: [triageNote],
    localQuery: {
      types: ["reported_bug"],
      where: {
        op: "and",
        clauses: [
          { op: "eq", field: "claimed_by", value: null },
          { op: "gt", field: "strength", value: 0.1 },
        ],
      },
      orderBy: { field: "strength", direction: "desc" },
      limit: 5,
    },
  });

  medium.defineValidator({
    name: "triage_reviewer",
    triggers: [triageNote],
    async validate(note) {
      const { verdict, bug_id, recommended_boost } = note.payload;
      const target = { type: "reported_bug", id: bug_id as string };
      if (verdict === "confirm") return { approve: true, boost: recommended_boost as number, target };
      return { approve: false, penalty: 0.5, target };
    },
  });

  medium.defineAgent({ id: "reporter-01", roles: [ReporterRole] });
  medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
}

describe("network layer — server + client SDK", () => {
  let db: PGlite;
  let medium: Medium;
  let server: ServerHandle;
  let reporterToken: string;
  let triagerToken: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    medium = defineMedium({
      client: pgliteClient(db),
      charter: "# Keep real bugs loud. Let noise fade.",
    });
    defineColony(medium);
    await medium.migrate();
    reporterToken = (await issueToken(medium, "reporter-01", "test")).token;
    triagerToken = (await issueToken(medium, "triager-01")).token;
    server = await serve(medium, { port: 0, dispatchIntervalMs: 50, sweepIntervalMs: 200 });
  });

  afterEach(async () => {
    await server.close();
    await medium.close();
    await db.close();
  });

  it("bootstraps a session with charter, identity, and role descriptors", async () => {
    const reporter = await connect({ url: server.url, token: reporterToken });
    expect(reporter.agentId).toBe("reporter-01");
    expect(reporter.charter).toContain("Keep real bugs loud");
    expect(reporter.roles.map((r) => r.name)).toEqual(["Reporter"]);
    expect(reporter.roles[0]?.writes).toContain("reported_bug");
    reporter.close();
  });

  it("round-trips deposit → view → claim → release across two agents", async () => {
    const reporter = await connect({ url: server.url, token: reporterToken });
    const bug = await reporter.as("Reporter").deposit("reported_bug", {
      title: "payment-webhook-500s",
      component: "backend",
      severity: 1,
      body: "stripe retries for hours",
      claimed_by: null,
      claimed_until: null,
    });
    expect(bug.id).toMatch(/[0-9a-f-]{36}/);
    expect(bug.payload.title).toBe("payment-webhook-500s");
    expect(bug.strength).toBeCloseTo(1.0, 3);

    const triager = await connect({ url: server.url, token: triagerToken });
    const queue = await triager.as("Triager").view();
    expect(queue.map((s) => s.payload.title)).toContain("payment-webhook-500s");

    const claimed = await triager.as("Triager").tryClaim(bug.id, { until: "2m" });
    expect(claimed).toBe(true);

    // Claimed bugs drop out of the Triager's unclaimed-only slice.
    const after = await triager.as("Triager").view();
    expect(after.map((s) => s.id)).not.toContain(bug.id);

    await triager.as("Triager").deposit("triage_note", {
      bug_id: bug.id,
      bug_title: "payment-webhook-500s",
      verdict: "confirm",
      body: "real bug",
      recommended_boost: 3,
    });

    const notes = await medium.query(`SELECT bug_id FROM signal_triage_note`);
    expect(notes).toHaveLength(1);

    await triager.as("Triager").release(bug.id);
    const released = await triager.as("Triager").view();
    expect(released.map((s) => s.id)).toContain(bug.id);

    reporter.close();
    triager.close();
  });

  it("enforces locality: an agent cannot act as a role it wasn't declared with", async () => {
    const triager = await connect({ url: server.url, token: triagerToken });
    // Client-side fast-fail (the role isn't in the session).
    expect(() => triager.as("Reporter")).toThrow(/not declared with role "Reporter"/);

    // Server-side enforcement against a hand-rolled request with the valid
    // triager token but a forbidden role.
    const res = await fetch(`${server.url}/v1/view`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${triagerToken}` },
      body: JSON.stringify({ role: "Reporter" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("role_forbidden");
    triager.close();
  });

  it("enforces write bounds: a role cannot deposit a signal type outside its writes", async () => {
    const reporter = await connect({ url: server.url, token: reporterToken });
    // Client-side fast-fail.
    await expect(
      reporter.as("Reporter").deposit("triage_note", { anything: true })
    ).rejects.toThrow(/not permitted to deposit/);

    // Server-side enforcement (bypassing the client guard).
    const res = await fetch(`${server.url}/v1/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ role: "Reporter", type: "triage_note", payload: {} }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("write_forbidden");
    reporter.close();
  });

  it("rejects bad payloads with a 400, not a 500", async () => {
    const reporter = await connect({ url: server.url, token: reporterToken });
    await expect(
      // severity must be a number; title missing.
      reporter.as("Reporter").deposit("reported_bug", { severity: "high" })
    ).rejects.toMatchObject({ status: 400 });
    reporter.close();
  });

  it("rejects unauthenticated and bad-token requests with 401", async () => {
    await expect(connect({ url: server.url, token: "stg_not_a_real_token" })).rejects.toMatchObject({
      status: 401,
    });

    const res = await fetch(`${server.url}/v1/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "Reporter" }),
    });
    expect(res.status).toBe(401);
  });

  it("runs validators server-side: a confirm boosts the bug's strength", async () => {
    const reporter = await connect({ url: server.url, token: reporterToken });
    const bug = await reporter.as("Reporter").deposit("reported_bug", {
      title: "login-loops",
      component: "auth",
      severity: 1,
      body: "infinite redirect",
      claimed_by: null,
      claimed_until: null,
    });

    const triager = await connect({ url: server.url, token: triagerToken });
    await triager.as("Triager").tryClaim(bug.id, { until: "2m" });
    await triager.as("Triager").deposit("triage_note", {
      bug_id: bug.id,
      bug_title: "login-loops",
      verdict: "confirm",
      body: "confirmed",
      recommended_boost: 3,
    });

    // The dispatcher worker runs on its own cadence; poll for the boost.
    let strength = 0;
    for (let i = 0; i < 40; i++) {
      const rows = await medium.query<{ strength: string }>(
        `SELECT strength::text AS strength FROM signal_reported_bug WHERE id = '${bug.id}'`
      );
      strength = Number.parseFloat((rows[0]?.strength as string) ?? "0");
      if (strength > 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Started at 1.0, +3 boost (minus a little strength decay over the poll).
    expect(strength).toBeGreaterThan(3);

    reporter.close();
    triager.close();
  });

  it("serves an unauthenticated health check", async () => {
    const res = await fetch(`${server.url}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; signals: number; agents: number };
    expect(body.ok).toBe(true);
    expect(body.signals).toBe(2);
    expect(body.agents).toBe(2);
  });
});
