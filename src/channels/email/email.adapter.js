import { BaseChannelAdapter, ChannelError } from "../base-channel.adapter.js";

export class EmailChannelAdapter extends BaseChannelAdapter {
  async sendMessage() {
    throw new ChannelError("Email provider is not configured", { status: 501, code: "EMAIL_PROVIDER_MISSING", retryable: false });
  }
}
