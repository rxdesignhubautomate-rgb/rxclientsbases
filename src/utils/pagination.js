export function encodeCursor(id) {
  return id ? Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url") : null;
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof value.id === "string" ? value.id : null;
  } catch {
    return null;
  }
}

export function listQuery(query = {}) {
  return {
    limit: Math.min(Math.max(Number(query.limit) || 25, 1), 100),
    cursor: decodeCursor(query.cursor),
    sortBy: String(query.sortBy || "updatedAt"),
    sortOrder: query.sortOrder === "asc" ? "asc" : "desc",
    search: String(query.search || "").trim().toLowerCase(),
    status: query.status ? String(query.status) : null,
    assignedTo: query.assignedTo ? String(query.assignedTo) : null,
    from: query.from ? new Date(String(query.from)) : null,
    to: query.to ? new Date(String(query.to)) : null
  };
}
