export class ChannelError extends Error {
  constructor(message, { status = 500, code = "CHANNEL_ERROR", retryable = true } = {}) {
    super(message);
    this.name = "ChannelError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class BaseChannelAdapter {
  async verifyWebhook(_input) {
    throw new ChannelError("Webhook verification is not implemented", { status: 501, retryable: false });
  }

  async normalizeWebhook(_payload) {
    throw new ChannelError("Webhook normalization is not implemented", { status: 501, retryable: false });
  }

  async sendMessage(_input) {
    throw new ChannelError("Message sending is not implemented", { status: 501, retryable: false });
  }

  async downloadMedia(_input) {
    throw new ChannelError("Media download is not implemented", { status: 501, retryable: false });
  }

  async markAsRead(_input) {
    throw new ChannelError("Read receipts are not implemented", { status: 501, retryable: false });
  }
}
