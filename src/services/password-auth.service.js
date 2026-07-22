import { ulid } from "ulid";
import { COLLECTIONS } from "../config/constants.js";
import { AppError, ForbiddenError } from "../utils/errors.js";
import { parseAccounts } from "./otp-auth.service.js";

const SALES_PERMISSIONS = [
  "dashboard.read",
  "contacts.read_assigned",
  "contacts.write",
  "conversations.read_assigned",
  "conversations.update",
  "messages.send",
  "followups.read",
  "followups.write",
  "leads.read_assigned",
  "leads.write",
  "leads.update",
  "quotations.read",
  "quotations.create",
  "quotations.update",
  "quotations.send",
  "orders.read",
  "orders.write",
  "orders.update_status"
];

export class PasswordAuthService {
  constructor({ store, auth, env, fetchImpl = fetch }) {
    this.store = store;
    this.auth = auth;
    this.env = env;
    this.fetch = fetchImpl;
    this.accounts = parseAccounts(env.OTP_LOGIN_USERS);
  }

  async login(rawEmail, rawPassword) {
    this.assertConfigured();
    const email = normalizeEmail(rawEmail);
    const password = String(rawPassword || "");
    const account = this.accounts.get(email);
    if (!account) throw new ForbiddenError("This login ID is not approved for the CRM");

    const response = await this.fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.env.FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw firebaseLoginError(payload);

    const decoded = await this.auth.verifyIdToken(payload.idToken, true);
    if (decoded.uid !== payload.localId || normalizeEmail(decoded.email || payload.email) !== email) {
      throw new AppError("UNAUTHENTICATED", "Firebase login could not be verified", 401);
    }
    const user = await this.provisionAccount(account, decoded.uid);
    return tokenResponse(payload, user);
  }

  async refresh(rawRefreshToken) {
    this.assertConfigured();
    const refreshToken = String(rawRefreshToken || "").trim();
    const response = await this.fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.env.FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString()
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError("SESSION_EXPIRED", "Session expired. Please sign in again.", 401);

    const idToken = payload.id_token;
    const decoded = await this.auth.verifyIdToken(idToken, true);
    const result = await this.store.find(COLLECTIONS.users, {
      filters: [["firebaseUid", "==", decoded.uid]],
      limit: 2
    });
    const user = result.items.find((candidate) => candidate.active === true && candidate.orgId === this.env.ORG_ID);
    if (!user) throw new ForbiddenError("User is disabled or not provisioned");
    return tokenResponse(
      {
        idToken,
        refreshToken: payload.refresh_token || refreshToken,
        expiresIn: payload.expires_in,
        localId: decoded.uid,
        email: decoded.email || user.email
      },
      user
    );
  }

  async provisionAccount(account, firebaseUid) {
    const [byUid, byEmail] = await Promise.all([
      this.store.find(COLLECTIONS.users, { filters: [["firebaseUid", "==", firebaseUid]], limit: 2 }),
      this.store.find(COLLECTIONS.users, { filters: [["email", "==", account.email]], limit: 10 })
    ]);
    const existing = byUid.items.find((candidate) => candidate.orgId === this.env.ORG_ID)
      || byEmail.items.find((candidate) => candidate.orgId === this.env.ORG_ID);
    const userId = existing?.userId || existing?.id || `USR_${ulid()}`;
    const now = new Date();
    const user = {
      userId,
      orgId: this.env.ORG_ID,
      firebaseUid,
      email: account.email,
      name: account.name,
      role: account.role,
      active: true,
      permissions: account.role === "OWNER" || account.role === "ADMIN" ? ["*"] : SALES_PERMISSIONS,
      updatedAt: now,
      ...(existing ? {} : { createdAt: now })
    };
    await this.store.set(COLLECTIONS.users, userId, user, { merge: true });
    return user;
  }

  assertConfigured() {
    if (!this.env.PASSWORD_LOGIN_ENABLED || !this.env.FIREBASE_WEB_API_KEY || !this.auth) {
      throw new AppError("PASSWORD_LOGIN_NOT_CONFIGURED", "Email/password login is not configured on the server", 503);
    }
  }
}

function tokenResponse(payload, user) {
  return {
    accessToken: payload.idToken,
    refreshToken: payload.refreshToken,
    expiresInSeconds: Number(payload.expiresIn || 3600),
    user: { email: user.email, name: user.name, role: user.role }
  };
}

function firebaseLoginError(payload) {
  const code = String(payload?.error?.message || "").split(" : ")[0];
  if (["EMAIL_NOT_FOUND", "INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS"].includes(code)) {
    return new AppError("INVALID_CREDENTIALS", "Incorrect email or password", 401);
  }
  if (code === "USER_DISABLED") return new ForbiddenError("This Firebase user is disabled");
  if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
    return new AppError("LOGIN_RATE_LIMITED", "Too many login attempts. Try again later.", 429);
  }
  if (code === "OPERATION_NOT_ALLOWED") {
    return new AppError("PASSWORD_LOGIN_DISABLED", "Enable Email/Password sign-in in Firebase Authentication", 503);
  }
  return new AppError("FIREBASE_LOGIN_FAILED", "Firebase login failed", 502);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
