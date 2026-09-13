import { randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { config } from "../config.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
let auth;

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function safePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

export function quotationArchiveName({ partyName, phone, quotationId }) {
  const cleanedParty = safePart(partyName);
  const party =
    cleanedParty && !/^(unknown|customer|n\/?a|na)$/i.test(cleanedParty)
      ? cleanedParty
      : safePart(phone) || "Customer";
  const reference = safePart(quotationId) || `Quotation-${Date.now()}`;
  return `${party} - ${reference}.pdf`;
}

async function accessToken() {
  auth ||= new GoogleAuth({
    credentials: {
      client_email: config.firebaseClientEmail,
      private_key: config.firebasePrivateKey,
    },
    scopes: [DRIVE_SCOPE],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw fail("Google Drive authentication failed");
  return token.token;
}

export async function uploadQuotationToDrive(pdf, details = {}) {
  if (!Buffer.isBuffer(pdf) || !pdf.length)
    throw fail("Quotation PDF is empty", 400);
  if (!config.googleDriveQuotationsFolderId)
    throw fail("Google Drive quotation folder is not configured", 503);

  const filename = quotationArchiveName(details);
  const boundary = `rx_quote_${randomBytes(12).toString("hex")}`;
  const metadata = {
    name: filename,
    mimeType: "application/pdf",
    parents: [config.googleDriveQuotationsFolderId],
    appProperties: {
      source: "rx-whatsapp-crm",
      quotationId: safePart(details.quotationId).slice(0, 120),
      leadId: safePart(details.leadId).slice(0, 120),
    },
  };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    pdf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const token = await accessToken();
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
    {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    if (response.status === 403 || response.status === 404)
      throw fail(
        `Drive folder access denied. Share folder ${config.googleDriveQuotationsFolderId} with ${config.firebaseClientEmail} as Editor and enable Google Drive API. ${detail}`,
        503,
      );
    throw fail(`Google Drive upload failed: ${response.status} ${detail}`);
  }
  return response.json();
}
