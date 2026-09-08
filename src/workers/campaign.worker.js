import { PollLoop } from "./poll-loop.js";

export class CampaignWorker {
  constructor({ marketing, intervalMs, batchSize, logger }) {
    this.marketing = marketing;
    this.batchSize = batchSize;
    this.running = false;
    this.loop = new PollLoop({
      run: () => this.tick(),
      intervalMs,
      logger,
      errorMessage: "marketing_campaign_worker_tick_failed"
    });
  }

  start() {
    this.loop.start();
  }

  stop() {
    this.loop.stop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.marketing.processDue(this.batchSize);
    } finally {
      this.running = false;
    }
  }
}
