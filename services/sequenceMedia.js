import { createHash } from "node:crypto";
import { config } from "../config.js";

export function invalidMediaError(message) {
  return Object.assign(new Error(message), {
    status: 422,
    code: "INVALID_SEQUENCE_MEDIA",
    invalidMedia: true,
    deliveryRejected: true,
  });
}

export function mediaReference(value) {
  const media = String(value || "").trim();
  if (/^\d+$/.test(media)) return { id: media };
  if (/^https?:\/\//i.test(media)) {
    try {
      const url = new URL(media);
      if (!url.hostname || url.username || url.password || /\s/.test(media))
        throw new Error();
      return { link: url.href };
    } catch {
      /* Report a configuration error before sending. */
    }
  }
  throw invalidMediaError(
    "Use the numeric ID returned by WhatsApp media upload, or a direct HTTP(S) file URL. A template upload handle, file path or page link is not a media ID.",
  );
}

export function mediaSendError(status, text, type) {
  let detail;
  try {
    detail = JSON.parse(text).error;
  } catch {
    /* Non-JSON errors remain uncertain. */
  }
  const message = String(detail?.message || text || "Request failed").slice(
    0,
    400,
  );
  const error = Object.assign(
    new Error(`WhatsApp ${type} send failed (${status}): ${message}`),
    {
      httpStatus: status,
      graphCode: detail?.code,
      graphSubcode: detail?.error_subcode,
    },
  );
  // Only this explicit rejection proves that the media send was not accepted.
  if (
    status === 400 &&
    Number(detail?.code) === 100 &&
    /(?:video|image)\.id\b.*(?:not\b.*\bvalid|invalid)/i.test(message)
  ) {
    Object.assign(error, {
      invalidMedia: true,
      deliveryRejected: true,
      code: "INVALID_SEQUENCE_MEDIA",
    });
  }
  return error;
}

export function sequenceMediaKey(step) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.whatsappPhoneNumberId,
        step.type,
        String(step.media || "").trim(),
      ]),
    )
    .digest("hex");
}

export function sequenceUploadOptions(slot, buffer, contentType = "") {
  if (![1, 2, 3, 4].includes(slot))
    throw invalidMediaError("Choose a sequence slot from 1 to 4.");
  if (!Buffer.isBuffer(buffer) || !buffer.length)
    throw invalidMediaError("Choose a media file.");
  const supplied = contentType.split(";")[0].trim().toLowerCase();
  const mp4 = buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
  const png = buffer
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    buffer.length >= 3 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255;
  const mimeType =
    slot === 4
      ? png
        ? "image/png"
        : jpeg
          ? "image/jpeg"
          : ""
      : mp4
        ? "video/mp4"
        : "";
  if (
    !mimeType ||
    (supplied &&
      supplied !== "application/octet-stream" &&
      supplied !== mimeType)
  )
    throw invalidMediaError(
      slot === 4
        ? "Slot 4 needs a JPEG or PNG image."
        : "Slots 1–3 need MP4 videos. An image or PDF cannot be used as a video ID.",
    );
  if (buffer.length > (slot === 4 ? 5 : 16) * 1024 * 1024)
    throw invalidMediaError(
      slot === 4
        ? "Image must be 5 MB or smaller."
        : "Video must be 16 MB or smaller.",
    );
  return {
    mimeType,
    filename: `visual-aid-sequence-${slot}.${slot === 4 ? (png ? "png" : "jpg") : "mp4"}`,
  };
}

// Read-only verification; never returns the short-lived download URL or sends a message.
export async function inspectSequenceMedia(value, type) {
  if (!["image", "video"].includes(type))
    throw invalidMediaError("Choose image or video media.");
  const reference = mediaReference(value);
  if (!reference.id)
    return {
      verified: false,
      source: "link",
      type,
      reason:
        "Direct file links are checked by WhatsApp when sent. Upload the file to verify an ID before repairing a paused sequence.",
    };
  const url = new URL(
    `https://graph.facebook.com/${config.whatsappGraphVersion}/${reference.id}`,
  );
  url.searchParams.set("phone_number_id", config.whatsappPhoneNumberId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsappToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data.error)
    throw Object.assign(
      new Error(
        "This media ID could not be verified for the configured WhatsApp number. Re-upload the file or check the account permissions.",
      ),
      { status: 422, graphCode: data.error?.code },
    );
  const mimeType = String(data.mime_type || "").toLowerCase();
  if (
    !(
      type === "video"
        ? ["video/mp4", "video/3gpp"]
        : ["image/jpeg", "image/png"]
    ).includes(mimeType)
  )
    throw invalidMediaError(
      `The uploaded file is not a supported ${type}. Upload the correct file for this step.`,
    );
  const size = Number(data.file_size);
  if (Number.isFinite(size) && size > (type === "image" ? 5 : 16) * 1024 * 1024)
    throw invalidMediaError(`The ${type} exceeds the allowed size.`);
  return {
    verified: true,
    source: "id",
    id: reference.id,
    type,
    mimeType,
    size: Number.isFinite(size) ? size : null,
    checkedAt: new Date().toISOString(),
  };
}
