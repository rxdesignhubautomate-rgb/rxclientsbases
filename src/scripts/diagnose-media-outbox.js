import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { COLLECTIONS, ORG_ID } from "../config/constants.js";

const flags = parseFlags(process.argv.slice(2));
if (!flags["service-account"]) {
  throw new Error(
    "Usage: node src/scripts/diagnose-media-outbox.js --service-account=<path> [--org-id=RXDH] [--limit=10]",
  );
}

const orgId = flags["org-id"] || ORG_ID;
const limit = Math.max(1, Math.min(Number(flags.limit) || 10, 50));
const serviceAccount = JSON.parse(
  await fs.readFile(path.resolve(String(flags["service-account"])), "utf8"),
);
const app = initializeApp(
  { credential: cert(serviceAccount) },
  `media-outbox-diagnostic-${Date.now()}`,
);
const db = getFirestore(app);

try {
  const [messagesSnapshot, outboxSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.messages).where("orgId", "==", orgId).get(),
    db.collection(COLLECTIONS.outbox).where("orgId", "==", orgId).get(),
  ]);
  const outboxByMessageId = new Map(
    outboxSnapshot.docs.map((document) => {
      const data = document.data();
      return [data.messageId, { id: document.id, ...data }];
    }),
  );
  const failedMessages = messagesSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter(
      (message) =>
        message.direction === "OUTBOUND" &&
        ["IMAGE", "DOCUMENT", "VIDEO", "AUDIO"].includes(message.type) &&
        ["FAILED", "QUEUED", "SENDING"].includes(message.status),
    )
    .sort((left, right) => toMillis(right.updatedAt) - toMillis(left.updatedAt))
    .slice(0, limit);

  const attachmentIds = [
    ...new Set(failedMessages.flatMap((message) => message.attachmentIds || [])),
  ];
  const attachmentSnapshots = await getAllInChunks(
    db,
    attachmentIds.map((id) => db.collection(COLLECTIONS.attachments).doc(id)),
  );
  const attachmentsById = new Map(
    attachmentSnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => [snapshot.id, snapshot.data()]),
  );
  const mediaInspectionById = new Map();
  const bucket = getStorage(app).bucket(`${serviceAccount.project_id}.firebasestorage.app`);
  for (const [attachmentId, attachment] of attachmentsById) {
    if (!attachment.storagePath || !String(attachment.mimeType || "").startsWith("image/")) continue;
    try {
      const [buffer] = await bucket.file(attachment.storagePath).download();
      mediaInspectionById.set(attachmentId, inspectImage(buffer, attachment.mimeType));
    } catch (error) {
      mediaInspectionById.set(attachmentId, {
        readable: false,
        error: String(error.message || error).slice(0, 200),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        projectId: serviceAccount.project_id,
        orgId,
        failedMediaMessages: failedMessages.map((message) => {
          const outbox = outboxByMessageId.get(message.messageId || message.id);
          return {
            messageId: message.messageId || message.id,
            type: message.type,
            status: message.status,
            createdAt: toIso(message.createdAt),
            updatedAt: toIso(message.updatedAt),
            errorCode: message.errorCode || null,
            errorTitle: message.errorTitle || null,
            errorDetails: message.errorDetails || null,
            errorMessage: message.errorMessage || null,
            outbox: outbox
              ? {
                  outboxId: outbox.outboxId || outbox.id,
                  status: outbox.status,
                  attemptCount: Number(outbox.attemptCount || 0),
                  lastError: outbox.lastError || null,
                }
              : null,
            attachments: (message.attachmentIds || []).map((attachmentId) => {
              const attachment = attachmentsById.get(attachmentId);
              return {
                attachmentId,
                exists: Boolean(attachment),
                mimeType: attachment?.mimeType || null,
                sizeBytes: Number(attachment?.sizeBytes || 0),
                hasStoragePath: Boolean(attachment?.storagePath),
                hasProviderMediaId: Boolean(attachment?.providerMediaId),
                inspection: mediaInspectionById.get(attachmentId) || null,
              };
            }),
          };
        }),
      },
      null,
      2,
    ),
  );
} finally {
  await deleteApp(app);
}

function parseFlags(argumentsList) {
  return Object.fromEntries(
    argumentsList
      .filter((argument) => argument.startsWith("--") && argument.includes("="))
      .map((argument) => {
        const [key, ...rest] = argument.slice(2).split("=");
        return [key, rest.join("=")];
      }),
  );
}

async function getAllInChunks(db, references, chunkSize = 250) {
  const snapshots = [];
  for (let index = 0; index < references.length; index += chunkSize) {
    snapshots.push(...(await db.getAll(...references.slice(index, index + chunkSize))));
  }
  return snapshots;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  return new Date(value).getTime() || 0;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inspectImage(buffer, declaredMimeType) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const colorTypes = {
      0: "GRAYSCALE",
      2: "RGB",
      3: "INDEXED",
      4: "GRAYSCALE_ALPHA",
      6: "RGBA",
    };
    return {
      readable: true,
      declaredMimeType,
      detectedFormat: "PNG",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      bitDepth: buffer[24],
      colorType: colorTypes[buffer[25]] || `UNKNOWN_${buffer[25]}`,
      withinWhatsAppImageLimit: buffer.length <= 5 * 1024 * 1024,
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const frame = findJpegFrame(buffer);
    return {
      readable: Boolean(frame),
      declaredMimeType,
      detectedFormat: "JPEG",
      width: frame?.width || null,
      height: frame?.height || null,
      bitDepth: frame?.bitDepth || null,
      components: frame?.components || null,
      colorModel:
        frame?.components === 1
          ? "GRAYSCALE"
          : frame?.components === 3
            ? "RGB_OR_YCBCR"
            : frame?.components === 4
              ? "CMYK_OR_YCCK"
              : "UNKNOWN",
      progressive: frame?.marker === 0xc2,
      withinWhatsAppImageLimit: buffer.length <= 5 * 1024 * 1024,
    };
  }
  return {
    readable: false,
    declaredMimeType,
    detectedFormat: "UNKNOWN",
    withinWhatsAppImageLimit: buffer.length <= 5 * 1024 * 1024,
  };
}

function findJpegFrame(buffer) {
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (frameMarkers.has(marker) && length >= 8) {
      return {
        marker,
        bitDepth: buffer[offset + 2],
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
        components: buffer[offset + 7],
      };
    }
    offset += length;
  }
  return null;
}
