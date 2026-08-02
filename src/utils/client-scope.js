export const CLIENT_SCOPES = Object.freeze({
  ALL: "ALL",
  ASSIGNED: "ASSIGNED",
  EXISTING_CLIENT: "EXISTING_CLIENT",
  PROSPECT: "PROSPECT"
});

const ELEVATED_ROLES = new Set(["OWNER", "ADMIN", "SALES_MANAGER"]);
const EMAIL_SCOPES = Object.freeze({
  "ankit@rxdesignhub.com": CLIENT_SCOPES.EXISTING_CLIENT,
  "reshu@rxdesignhub.com": CLIENT_SCOPES.PROSPECT
});

export function resolveClientScope(user = {}) {
  if (ELEVATED_ROLES.has(user.role)) return CLIENT_SCOPES.ALL;
  if (Object.values(CLIENT_SCOPES).includes(user.clientScope)) return user.clientScope;
  return EMAIL_SCOPES[normalizeEmail(user.email)] || CLIENT_SCOPES.ASSIGNED;
}

export function relationshipTypesForScope(scope) {
  if (scope === CLIENT_SCOPES.EXISTING_CLIENT) return ["EXISTING_CLIENT"];
  if (scope === CLIENT_SCOPES.PROSPECT) return ["PROSPECT", "LEAD"];
  return [];
}

export function canAccessRelationship(scope, relationshipType) {
  if (scope === CLIENT_SCOPES.ALL) return true;
  return relationshipTypesForScope(scope).includes(String(relationshipType || "PROSPECT"));
}

export function normalizeSegment(value) {
  const segment = String(value || "").trim().toUpperCase();
  if (segment === "EXISTING_CLIENT") return "EXISTING_CLIENT";
  if (["PROSPECT", "LEAD"].includes(segment)) return "PROSPECT";
  return null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
