import path from "node:path";
import sharp from "sharp";
import { AppError } from "../utils/errors.js";

export const WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TARGET_BYTES = Math.floor(4.75 * 1024 * 1024);
const MAX_DIMENSION = 4096;
const JPEG_QUALITIES = [88, 82, 76, 70, 64, 58];

export async function normalizeWhatsAppImage({
  buffer,
  mimeType = "application/octet-stream",
  filename = "image",
}) {
  if (!String(mimeType).toLowerCase().startsWith("image/")) {
    return { buffer, mimeType, filename, normalized: false, metadata: null };
  }
  let source;
  try {
    source = await sharp(buffer, { failOn: "warning" }).metadata();
  } catch (error) {
    throw invalidImage(`Image could not be decoded: ${error.message}`);
  }
  if (!source.width || !source.height) throw invalidImage("Image has no readable dimensions");

  let targetWidth = Math.min(source.width, MAX_DIMENSION);
  let targetHeight = Math.min(source.height, MAX_DIMENSION);
  let lastResult = null;

  for (let resizeRound = 0; resizeRound < 5; resizeRound += 1) {
    for (const quality of JPEG_QUALITIES) {
      try {
        const result = await sharp(buffer, { failOn: "warning" })
          .rotate()
          .flatten({ background: "#ffffff" })
          .resize({
            width: Math.max(1, Math.round(targetWidth)),
            height: Math.max(1, Math.round(targetHeight)),
            fit: "inside",
            withoutEnlargement: true,
          })
          .toColourspace("srgb")
          .jpeg({
            quality,
            chromaSubsampling: "4:2:0",
            progressive: false,
            force: true,
          })
          .toBuffer({ resolveWithObject: true });
        lastResult = result;
        if (result.data.length <= TARGET_BYTES) {
          return {
            buffer: result.data,
            mimeType: "image/jpeg",
            filename: jpegFilename(filename),
            normalized: true,
            metadata: {
              sourceMimeType: mimeType,
              sourceSizeBytes: buffer.length,
              sourceWidth: source.width,
              sourceHeight: source.height,
              sourceColourspace: source.space || null,
              outputSizeBytes: result.data.length,
              outputWidth: result.info.width,
              outputHeight: result.info.height,
              outputColourspace: "srgb",
              quality,
            },
          };
        }
      } catch (error) {
        throw invalidImage(`Image could not be converted: ${error.message}`);
      }
    }
    targetWidth *= 0.8;
    targetHeight *= 0.8;
  }

  throw invalidImage(
    `Image remains too large after conversion (${lastResult?.data?.length || buffer.length} bytes)`,
  );
}

function jpegFilename(filename) {
  const parsed = path.parse(String(filename || "image"));
  return `${parsed.name || "image"}-whatsapp.jpg`;
}

function invalidImage(message) {
  return new AppError("INVALID_WHATSAPP_IMAGE", message, 400, {
    maxBytes: WHATSAPP_IMAGE_MAX_BYTES,
    supportedOutput: "JPEG, RGB, 8-bit",
  });
}
