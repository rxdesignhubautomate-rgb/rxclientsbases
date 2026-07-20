import { BaseChannelAdapter, ChannelError } from "../base-channel.adapter.js";

export class WebsiteChannelAdapter extends BaseChannelAdapter {
  async sendMessage() {
    throw new ChannelError("Website push transport is not configured", { status: 501, code: "WEBSITE_TRANSPORT_MISSING", retryable: false });
  }
}
