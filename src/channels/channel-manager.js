import { ConflictError } from "../utils/errors.js";

export class ChannelManager {
  constructor() {
    this.adapters = new Map();
  }

  register(channel, provider, adapter) {
    this.adapters.set(`${channel}:${provider}`, adapter);
    return this;
  }

  adapterFor(account) {
    const adapter = this.adapters.get(`${account.channel}:${account.provider}`);
    if (!adapter) throw new ConflictError(`No adapter for ${account.channel}/${account.provider}`);
    return adapter;
  }

  verifyWebhook(account, input) {
    return this.adapterFor(account).verifyWebhook(input);
  }

  normalizeWebhook(account, payload) {
    return this.adapterFor(account).normalizeWebhook(payload);
  }

  send({ account, message, attachments = [] }) {
    return this.adapterFor(account).sendMessage({ account, message, attachments });
  }

  downloadMedia({ account, media }) {
    return this.adapterFor(account).downloadMedia({ account, media });
  }

  markAsRead({ account, providerMessageId }) {
    return this.adapterFor(account).markAsRead({ account, providerMessageId });
  }
}
