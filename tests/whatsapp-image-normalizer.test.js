import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  normalizeWhatsAppImage,
  WHATSAPP_IMAGE_MAX_BYTES,
} from "../src/services/whatsapp-image-normalizer.js";

describe("WhatsApp image normalizer", () => {
  it("converts CMYK JPEG input to an RGB 8-bit JPEG accepted by WhatsApp", async () => {
    const input = await sharp({
      create: {
        width: 600,
        height: 800,
        channels: 3,
        background: "#00a884",
      },
    })
      .toColourspace("cmyk")
      .jpeg({ quality: 95 })
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.space).toBe("cmyk");

    const result = await normalizeWhatsAppImage({
      buffer: input,
      mimeType: "image/jpeg",
      filename: "quotation.jpg",
    });
    const after = await sharp(result.buffer).metadata();

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("quotation-whatsapp.jpg");
    expect(result.buffer.length).toBeLessThanOrEqual(WHATSAPP_IMAGE_MAX_BYTES);
    expect(after.space).toBe("srgb");
    expect(after.channels).toBe(3);
    expect(after.depth).toBe("uchar");
  });

  it("leaves non-image media untouched", async () => {
    const input = Buffer.from("pdf");
    const result = await normalizeWhatsAppImage({
      buffer: input,
      mimeType: "application/pdf",
      filename: "quote.pdf",
    });
    expect(result.buffer).toBe(input);
    expect(result.normalized).toBe(false);
  });
});
