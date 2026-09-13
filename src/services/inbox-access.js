import { enforceAssignment } from '../middleware/authorize.js';
import { sha256 } from '../utils/hashing.js';

export const preferenceCollection = 'conversationPreferences';
export const preferenceId = (orgId, userId, conversationId) => sha256(`${orgId}:${userId}:${conversationId}`);

export async function assertInboxAccess(container, orgId, entity, actor) {
  const contact = entity.contactId ? await container.contacts.get(orgId, entity.contactId) : entity;
  enforceAssignment({ ...entity, relationshipType: contact.relationshipType })( { auth: actor } );
}
