#!/usr/bin/env bun
import { loadConfig } from "./config.js";
import { createRocketr } from "./app.js";

const r = await createRocketr(loadConfig());
await r.listen();

const shutdown = async (sig: string) => {
  console.error(`rocketr: ${sig}, shutting down`);
  await r.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
