const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const FAILURE_RESET_MS = 2 * 60 * 60 * 1000;

let failures = 0;
let lastFailureAt = 0;
let retryAt = 0;

export function isFirestoreQuotaError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message || error || "");
  return (
    code === "8" ||
    code === "resource-exhausted" ||
    /resource[_ -]?exhausted|quota exceeded/i.test(message)
  );
}

export function noteFirestoreQuotaError(error, now = Date.now()) {
  if (!isFirestoreQuotaError(error)) return null;

  if (now < retryAt) return { ...quotaStatus(now), started: false };
  if (now - lastFailureAt > FAILURE_RESET_MS) failures = 0;

  failures += 1;
  lastFailureAt = now;
  const delay = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 8),
  );
  retryAt = now + delay;
  return { ...quotaStatus(now), started: true };
}

export function noteFirestoreAvailable() {
  failures = 0;
  lastFailureAt = 0;
  retryAt = 0;
}

export function quotaStatus(now = Date.now()) {
  const remainingMs = Math.max(0, retryAt - now);
  return {
    active: remainingMs > 0,
    failures,
    retryAt: retryAt ? new Date(retryAt).toISOString() : null,
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

export function firestoreQuotaGuard(_req, res, next) {
  const status = quotaStatus();
  if (!status.active) return next();

  res.set("Retry-After", String(status.retryAfterSeconds));
  return res.status(503).json({
    error: "Database quota is temporarily exhausted. Automatic retry is paused.",
    code: "FIRESTORE_QUOTA_BACKOFF",
    retryAt: status.retryAt,
  });
}
