#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { issueToken, revokeToken } from "./admin.js";
import { serve } from "./server/index.js";
import type { Medium } from "./types.js";

/**
 * The `stigmergy` CLI — operate a colony from the command line.
 *
 *   stigmergy migrate <colony>                 apply migrations + signal tables
 *   stigmergy serve   <colony> [--port N] [--host H] [--migrate]
 *   stigmergy token issue  <colony> <agent-id> [--label L]
 *   stigmergy token revoke <colony> <token>
 *   stigmergy inspect <colony>                 print the colony's state
 *
 * A "colony" is a module that defines a Medium (signals, roles, validators,
 * agents) and exports it — as the default export, or as `medium` / `colony`.
 * It must NOT start the server or run agents at import time; the CLI does that.
 * Point at a compiled `.js`, or a `.ts` file if `tsx` is installed.
 */

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "migrate":
      return cmdMigrate(rest);
    case "serve":
      return cmdServe(rest);
    case "token":
      return cmdToken(rest);
    case "inspect":
      return cmdInspect(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMigrate(args: string[]): Promise<void> {
  const { positionals } = parseArgs(args);
  const medium = await loadColony(requireArg(positionals[0], "colony module path"));
  await medium.migrate();
  console.log("Migrations applied. Signal tables are up to date.");
  await medium.close();
}

async function cmdServe(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const medium = await loadColony(requireArg(positionals[0], "colony module path"));

  const handle = await serve(medium, {
    port: flags.port ? Number.parseInt(flags.port, 10) : undefined,
    host: flags.host,
    migrate: "migrate" in flags,
  });

  console.log(`Stigmergy server listening on ${handle.url}`);
  console.log(`  instance: ${handle.instanceId}`);
  console.log("  Ctrl-C to stop.");

  const shutdown = async () => {
    console.log("\nShutting down…");
    await handle.close();
    await medium.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdToken(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { positionals, flags } = parseArgs(rest);
  const medium = await loadColony(requireArg(positionals[0], "colony module path"));

  if (sub === "issue") {
    const agentId = requireArg(positionals[1], "agent id");
    const issued = await issueToken(medium, agentId, flags.label);
    console.log(`Token for "${issued.agentId}" (store it now — it is not recoverable):\n`);
    console.log(`  ${issued.token}\n`);
  } else if (sub === "revoke") {
    const token = requireArg(positionals[1], "token");
    const ok = await revokeToken(medium, token);
    console.log(ok ? "Token revoked." : "No live token matched.");
  } else {
    await medium.close();
    fail("Usage: stigmergy token <issue|revoke> <colony> …");
  }
  await medium.close();
}

async function cmdInspect(args: string[]): Promise<void> {
  const { positionals } = parseArgs(args);
  const medium = await loadColony(requireArg(positionals[0], "colony module path"));

  const signals = await medium.query<{ type: string; table_name: string; decay_kind: string }>(
    `SELECT type, table_name, decay_kind FROM stigmergy_signal_registry ORDER BY type`
  );
  console.log("signals:");
  for (const s of signals) {
    const counted = await medium.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${s.table_name}`
    );
    const n = counted[0]?.count ?? "0";
    console.log(`  ${s.type.padEnd(24)} ${s.decay_kind.padEnd(14)} ${n} rows`);
  }

  const agents = await medium.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM stigmergy_agents`
  );
  const reinforcements = await medium.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM stigmergy_reinforcements WHERE created_at > now() - interval '1 hour'`
  );
  console.log(`\nagents: ${agents[0]?.count ?? "0"}`);
  console.log(`reinforcements (last hour): ${reinforcements[0]?.count ?? "0"}`);

  await medium.close();
}

// ---------------------------------------------------------------------------
// Colony loading
// ---------------------------------------------------------------------------

async function loadColony(path: string): Promise<Medium> {
  const abs = resolve(process.cwd(), path);
  if (abs.endsWith(".ts")) await registerTsx(path);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const medium = (mod.default ?? mod.medium ?? mod.colony) as Medium | undefined;
  if (!medium || typeof medium.migrate !== "function") {
    fail(
      `Colony module "${path}" must export a Stigmergy Medium — as the default export, or as a named export 'medium' or 'colony'.`
    );
  }
  return medium as Medium;
}

async function registerTsx(path: string): Promise<void> {
  try {
    const tsx = (await import("tsx/esm/api")) as { register: () => void };
    tsx.register();
  } catch {
    fail(
      `Loading a .ts colony ("${path}") requires tsx. Install it (npm i -D tsx) or point the CLI at a compiled .js file.`
    );
  }
}

// ---------------------------------------------------------------------------
// Tiny arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "";
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) fail(`Missing required argument: ${name}`);
  return value;
}

function printUsage(): void {
  console.log(
    [
      "stigmergy — operate a colony",
      "",
      "Usage:",
      "  stigmergy migrate <colony>",
      "  stigmergy serve   <colony> [--port N] [--host H] [--migrate]",
      "  stigmergy token issue  <colony> <agent-id> [--label L]",
      "  stigmergy token revoke <colony> <token>",
      "  stigmergy inspect <colony>",
      "",
      "<colony> is a module exporting a configured Medium (default, or named",
      "'medium' / 'colony'). Point at compiled .js, or .ts if tsx is installed.",
    ].join("\n")
  );
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
