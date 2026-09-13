import { ConflictError } from "../utils/errors.js";

const MIME_PREFIX = Object.freeze({
  IMAGE: "image/",
  VIDEO: "video/",
  DOCUMENT: "application/"
});

/**
 * Validates that an uploaded file is the single media header expected by the
 * server-owned Meta template and that it belongs to the selected client.
 */
export async function validateTemplateHeaderMedia({
  media,
  orgId,
  contactId,
  conversationId = null,
  template,
  attachmentIds = [],
  allowSharedUtilityAsset = false
}) {
  const ids = [...new Set((attachmentIds || []).filter(Boolean))];
  const header = template?.header || null;

  if (!header?.type) {
    if (ids.length) throw new ConflictError("The selected Meta template does not accept header media");
    return [];
  }
  if (header.required && ids.length !== 1) {
    throw new ConflictError(`Upload exactly one ${String(header.type).toLowerCase()} for this approved Meta template`);
  }
  if (ids.length > 1) throw new ConflictError("A Meta template can use only one header file");
  if (!ids.length) return [];

  const attachment = await media.get(orgId, ids[0]);
  const sharedUtilityAsset = allowSharedUtilityAsset && attachment.purpose === "UTILITY_TEMPLATE_ASSET";
  if (!sharedUtilityAsset && attachment.contactId !== contactId) {
    throw new ConflictError("The template header file does not belong to the selected client");
  }
  if (!sharedUtilityAsset && conversationId && attachment.conversationId && attachment.conversationId !== conversationId) {
    throw new ConflictError("The template header file belongs to another conversation");
  }

  const expectedType = String(header.type).toUpperCase();
  const prefix = MIME_PREFIX[expectedType];
  if (!prefix || !String(attachment.mimeType || "").toLowerCase().startsWith(prefix)) {
    throw new ConflictError(`The approved Meta template requires a ${expectedType.toLowerCase()} header file`);
  }
  return ids;
}
