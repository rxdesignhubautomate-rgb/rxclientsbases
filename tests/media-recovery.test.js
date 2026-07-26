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

  it("uploads an outbound attachment once and reuses the cached Meta media id", async () => {
    const core = makeCore();
    const bucket = memoryBucket();
    const channelManager = {
      uploadMedia: vi.fn().mockResolvedValue("meta-media-2")
    };
    const media = new MediaService({
      store: core.store,
      bucket,
      channelManager,
      channelAccounts: core.channelAccounts
    });
    const attachment = await media.storeBuffer({
      orgId: "RXDH",
      contactId: "CNT_TEST",
      buffer: Buffer.from("pdf-bytes"),
      mimeType: "application/pdf",
      originalFilename: "quotation.pdf"
    });

    const firstId = await media.ensureProviderMediaId({
      orgId: "RXDH",
      account: { phoneNumberId: "phone-id" },
      attachment
    });
    const refreshed = await media.get("RXDH", attachment.attachmentId);
    const secondId = await media.ensureProviderMediaId({
      orgId: "RXDH",
      account: { phoneNumberId: "phone-id" },
      attachment: refreshed
    });

    expect(firstId).toBe("meta-media-2");
    expect(secondId).toBe("meta-media-2");
    expect(channelManager.uploadMedia).toHaveBeenCalledTimes(1);
    expect(channelManager.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      buffer: Buffer.from("pdf-bytes"),
      mimeType: "application/pdf",
      filename: "quotation.pdf"
    }));
    expect(refreshed.providerMediaId).toBe("meta-media-2");
  });

  it("can upload bytes even when Firebase signed URL generation fails", async () => {
    const core = makeCore();
    const stored = new Map();
    const bucket = {
      file(path) {
        return {
          async save(buffer) {
            stored.set(path, Buffer.from(buffer));
          },
          async download() {
            return [stored.get(path)];
          },
          async getSignedUrl() {
            throw new Error("Signing identity unavailable");
          }
        };
      }
    };
    const channelManager = {
      uploadMedia: vi.fn().mockResolvedValue("meta-media-no-link")
    };
    const media = new MediaService({ store: core.store, bucket, channelManager });
    const saved = await media.storeBuffer({
      orgId: "RXDH",
      contactId: "CNT_TEST",
      buffer: Buffer.from("video-bytes"),
      mimeType: "video/mp4",
      originalFilename: "sample.mp4"
    });

    const [prepared] = await media.prepareForSend("RXDH", [saved.attachmentId]);
    const mediaId = await media.ensureProviderMediaId({
      orgId: "RXDH",
      account: { phoneNumberId: "phone-id" },
      attachment: prepared
    });

    expect(prepared.signedUrl).toBeUndefined();
    expect(mediaId).toBe("meta-media-no-link");
    expect(channelManager.uploadMedia).toHaveBeenCalledTimes(1);
  });
});
