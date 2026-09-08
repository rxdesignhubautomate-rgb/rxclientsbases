import { assertStartupEnv, env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createContainer } from "../container.js";

assertStartupEnv();
const container = createContainer();
container.workers.campaign.start();
logger.info({ mode: "external", batchSize: env.CAMPAIGN_BATCH_SIZE }, "campaign_worker_started");
const keepAlive = setInterval(() => {}, 60_000);

function shutdown(signal) {
  container.workers.campaign.stop();
  clearInterval(keepAlive);
  logger.info({ signal }, "campaign_worker_stopped");
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
