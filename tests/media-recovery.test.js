import { describe, expect, it, vi } from "vitest";
import { MediaService } from "../src/services/media.service.js";
import { makeCore, seedConversation } from "./helpers/core.js";

function memoryBucket() {
  const values = new Map();
  return {
    file(path) {
      return {
        async save(buffer) {
          values.set(path, Buffer.from(buffer));
        },
        async getSignedUrl() {
          return [`https://storage.test/${encodeURIComponent(path)}`];
        },
        async download() {
          return [values.get(path)];
        }
      };
    }
  };
}

describe("WhatsApp media recovery", () => {
  it("recovers provider media, links it to the message, and serves its content", async () => {
    const core = makeCore();
    const { contact, lead, conversation } = await seedConversation(core);
    const saved = await core.messages.createInbound({
      orgId: "RXDH",
      conversationId: conversation.conversationId,
      contactId: contact.contactId,
      leadId: lead.leadId,
      channel: "WHATSAPP",
      channelAccountId: "WA_RX_01",
      type: "IMAGE",
      providerMessageId: "wamid.media",
      senderId: "919876543210",
      metadata: {
        providerMedia: {
          providerMediaId: "media-1",
          mimeType: "image/jpeg",
          filename: "customer-photo.jpg"
        },
        mediaArchiveStatus: "FAILED"
      }
    });
    const bucket = memoryBucket();
    const channelManager = {
      downloadMedia: vi.fn().mockResolvedValue({
        buffer: Buffer.from("image-bytes"),
        mimeType: "image/jpeg",
        filename: "customer-photo.jpg",
        providerMediaId: "media-1"
      })
    };
    const media = new MediaService({
      store: core.store,
      bucket,
      channelManager,
      channelAccounts: core.channelAccounts
    });

    const attachment = await media.retryInboundMedia("RXDH", saved.message.messageId);
    const message = await core.store.get("messages", saved.message.messageId);
    const content = await media.getContent("RXDH", attachment.attachmentId);

    expect(channelManager.downloadMedia).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({ providerMediaId: "media-1" })
    }));
    expect(message.attachmentIds).toEqual([attachment.attachmentId]);
    expect(message.metadata.mediaArchiveStatus).toBe("READY");
    expect(content.buffer.toString()).toBe("image-bytes");
    expect((await core.store.get("conversations", conversation.conversationId)).mediaUpdatedAt).toBeInstanceOf(Date);
  });
});
