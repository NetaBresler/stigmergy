/**
 * colony.ts — the shared colony definition.
 *
 * This module defines the medium (signals, roles, validators, agents) and
 * exports it. The server imports it; so does the `stigmergy` CLI. Agents do
 * NOT import it — they live in their own processes and only speak the wire
 * protocol (see agent.ts / agent.py).
 *
 * Because the server and agents are separate processes, they need a *shared*
 * substrate: a real Postgres, not in-process PGlite. Point DATABASE_URL at one
 * (a Supabase free-tier database works). For a zero-setup, single-process
 * version of the same colony, see examples/remote-agent.ts instead.
 *
 * In your own project this import is `from "stigmergy"`.
 */

import { z } from "zod";
import { defineMedium } from "../../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "Set DATABASE_URL to a Postgres connection string before loading this colony.\n" +
      "  e.g. export DATABASE_URL='postgres://…'  (a Supabase free-tier db works)"
  );
}

export const medium = defineMedium({
  url,
  charter: "# Triage reported bugs. Keep real ones loud. Let noise fade.",
});

const reportedBug = medium.defineSignal({
  type: "reported_bug",
  decay: { kind: "strength", factor: 0.5, period: "5m", floor: 0.05 },
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
    return { approve: false, penalty: verdict === "invalid" ? 0.8 : 0.4, target };
  },
});

medium.defineAgent({ id: "reporter-01", roles: [ReporterRole] });
medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });

/** The agents this colony expects to connect. The server mints a token each. */
export const AGENT_IDS = ["reporter-01", "triager-01", "triager-02"] as const;

// Allow `stigmergy serve examples/remote-colony/colony.ts` to find the medium.
export default medium;
