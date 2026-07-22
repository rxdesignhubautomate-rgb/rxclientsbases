import { createServer } from "node:http";
import { createApp } from "./app.js";
import { assertStartupEnv, env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startDigestScheduler } from "../services/dailyDigest.js";
import { startSequenceScheduler } from "../services/sequenceScheduler.js";

assertStartupEnv();
const app = createApp();
const container = app.locals.container;
const server = createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, "server_started");
  if (env.WORKERS_ENABLED) {
    container.workers.inbound.start();
    container.workers.outbound.start();
    container.workers.media.start();
    container.workers.campaign.start();
  }
  if (env.LEGACY_JOBS_ENABLED) {
    startSequenceScheduler();
    startDigestScheduler();
  }
});

async function shutdown(signal) {
  logger.info({ signal }, "graceful_shutdown_started");
  container.workers.inbound.stop();
  container.workers.outbound.stop();
  container.workers.media.stop();
  container.workers.campaign.stop();
  server.close((error) => {
    if (error) {
      logger.error({ error: error.message }, "graceful_shutdown_failed");
      process.exitCode = 1;
    }
  });
  setTimeout(() => {
    logger.error("graceful_shutdown_timed_out");
    process.exit(1);
  }, 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

export { app, server };
