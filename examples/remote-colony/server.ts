/**
 * server.ts — run the colony as network infrastructure.
 *
 *   DATABASE_URL='postgres://…' npx tsx examples/remote-colony/server.ts
 *
 * It migrates, mints a token for each declared agent, prints them, and serves.
 * Copy a token into an agent terminal (agent.ts or agent.py). The server owns
 * the database and runs the background workers (decay + validation); the
 * agents just connect.
 *
 * In production you would issue tokens once with `stigmergy token issue` and
 * store them in a secret manager rather than printing them on boot.
 */

import { issueToken, serve } from "../../src/index.js";
import { AGENT_IDS, medium } from "./colony.js";

async function main(): Promise<void> {
  await medium.migrate();

  console.log("agent tokens (copy into the agent terminals):\n");
  for (const id of AGENT_IDS) {
    const { token } = await issueToken(medium, id, "remote-colony-demo");
    console.log(`  ${id.padEnd(12)} STIGMERGY_TOKEN=${token}`);
  }

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8787;
  const host = process.env.HOST ?? "127.0.0.1";
  const handle = await serve(medium, { port, host });

  console.log(`\nserver listening on ${handle.url}`);
  console.log("Ctrl-C to stop.\n");

  const shutdown = async () => {
    await handle.close();
    await medium.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
