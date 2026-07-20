import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import { COLLECTIONS, USER_ROLES } from "../config/constants.js";
import { AppError, ForbiddenError } from "../utils/errors.js";

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
  "orders.write"
];

export class OtpAuthService {
  constructor({ store, mailer, env, codeGenerator, tokenGenerator }) {
    this.store = store;
    this.mailer = mailer;
    this.env = env;
    this.codeGenerator = codeGenerator || (() => String(randomInt(100000, 1000000)));
    this.tokenGenerator = tokenGenerator || (() => `rxs_${randomBytes(32).toString("base64url")}`);
    this.accounts = parseAccounts(env.OTP_LOGIN_USERS);
  }

  async requestOtp(rawEmail) {
    this.assertConfigured();
    const email = normalizeEmail(rawEmail);
    const account = this.accounts.get(email);
    if (!account) throw new ForbiddenError("This login ID is not approved for the CRM");

    const otpId = digest(email);
    const existing = await this.store.get(COLLECTIONS.loginOtps, otpId);
    const currentTime = Date.now();
    const nextAllowedAt = toDate(existing?.nextAllowedAt)?.getTime() || 0;
    if (nextAllowedAt > currentTime) {
      throw new AppError("OTP_RATE_LIMITED", "Please wait before requesting another OTP", 429);
    }

    const code = this.codeGenerator();
    const requestedAt = new Date(currentTime);
    const expiresAt = new Date(currentTime + this.env.OTP_TTL_MINUTES * 60_000);
    await this.store.set(COLLECTIONS.loginOtps, otpId, {
      email,
      codeHash: this.hashOtp(email, code),
      requestedAt,
      expiresAt,
      nextAllowedAt: new Date(currentTime + 60_000),
      attempts: 0,
      consumed: false
    });

    try {
      await this.mailer.send({ loginEmail: email, code, expiresInMinutes: this.env.OTP_TTL_MINUTES });
    } catch (error) {
      await this.store.update(COLLECTIONS.loginOtps, otpId, { consumed: true, deliveryFailedAt: new Date(), nextAllowedAt: new Date() });
      if (error instanceof AppError) throw error;
      throw new AppError("OTP_DELIVERY_FAILED", "OTP email could not be sent", 502);
    }

    return {
      email,
      expiresInSeconds: this.env.OTP_TTL_MINUTES * 60,
      deliveryHint: maskEmail(this.env.OTP_DELIVERY_EMAIL)
    };
  }

  async verifyOtp(rawEmail, rawCode) {
    this.assertConfigured();
    const email = normalizeEmail(rawEmail);
    const code = String(rawCode || "").trim();
    const account = this.accounts.get(email);
    if (!account) throw new ForbiddenError("This login ID is not approved for the CRM");
    if (!/^\d{6}$/.test(code)) throw new AppError("INVALID_OTP", "Enter the 6-digit OTP", 400);

    const otpId = digest(email);
    const verification = await this.store.runTransaction(async (tx) => {
      const otp = await tx.get(COLLECTIONS.loginOtps, otpId);
      if (!otp || otp.consumed) return new AppError("OTP_INVALID_OR_EXPIRED", "OTP is invalid or expired", 401);
      if ((toDate(otp.expiresAt)?.getTime() || 0) < Date.now()) {
        await tx.update(COLLECTIONS.loginOtps, otpId, { consumed: true, expiredAt: new Date() });
        return new AppError("OTP_INVALID_OR_EXPIRED", "OTP is invalid or expired", 401);
      }
      const attempts = Number(otp.attempts || 0);
      if (attempts >= 5) return new AppError("OTP_ATTEMPTS_EXCEEDED", "Too many incorrect attempts. Request a new OTP.", 429);
      if (!safeEqual(otp.codeHash, this.hashOtp(email, code))) {
        await tx.update(COLLECTIONS.loginOtps, otpId, { attempts: attempts + 1, lastFailedAt: new Date() });
        return new AppError("INVALID_OTP", "Incorrect OTP", 401);
      }
      await tx.update(COLLECTIONS.loginOtps, otpId, { consumed: true, consumedAt: new Date(), attempts });
      return null;
    });
    if (verification) throw verification;

    const provisioned = await Promise.all([...this.accounts.values()].map((approved) => this.provisionAccount(approved)));
    const user = provisioned.find((candidate) => candidate.email === account.email);
    const token = this.tokenGenerator();
    const expiresAt = new Date(Date.now() + this.env.OTP_SESSION_HOURS * 60 * 60_000);
    await this.store.set(COLLECTIONS.loginSessions, digest(token), {
      userId: user.userId,
      orgId: user.orgId,
      email: user.email,
      createdAt: new Date(),
      expiresAt,
      revoked: false
    });
    return {
      accessToken: token,
      expiresInSeconds: this.env.OTP_SESSION_HOURS * 60 * 60,
      user: { email: user.email, name: user.name, role: user.role }
    };
  }

  async authenticateSession(token) {
    const session = await this.store.get(COLLECTIONS.loginSessions, digest(token));
    if (!session || session.revoked || (toDate(session.expiresAt)?.getTime() || 0) <= Date.now()) {
      throw new AppError("UNAUTHENTICATED", "Invalid or expired authentication token", 401);
    }
    const user = await this.store.get(COLLECTIONS.users, session.userId);
    if (!user || user.active !== true || user.orgId !== session.orgId) {
      throw new ForbiddenError("User is disabled or not provisioned");
    }
    return user;
  }

  async provisionAccount(account) {
    const found = await this.store.find(COLLECTIONS.users, {
      filters: [["email", "==", account.email]],
      limit: 10
    });
    const existing = found.items.find((candidate) => candidate.orgId === this.env.ORG_ID);
    const userId = existing?.userId || existing?.id || `USR_${ulid()}`;
    const now = new Date();
    const user = {
      userId,
      orgId: this.env.ORG_ID,
      firebaseUid: existing?.firebaseUid || `otp:${digest(account.email).slice(0, 32)}`,
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

  hashOtp(email, code) {
    return createHmac("sha256", this.env.OTP_HASH_SECRET || "").update(`${email}:${code}`).digest("hex");
  }

  assertConfigured() {
    if (!this.env.OTP_LOGIN_ENABLED || !this.env.OTP_HASH_SECRET || !this.mailer.configured()) {
      throw new AppError("OTP_NOT_CONFIGURED", "OTP login is not configured on the server", 503);
    }
  }
}

export function parseAccounts(value) {
  const accounts = new Map();
  for (const item of String(value || "").split(";").filter(Boolean)) {
    const [rawEmail, rawName, rawRole] = item.split("|");
    const email = normalizeEmail(rawEmail);
    const name = String(rawName || "").trim();
    const role = String(rawRole || "").trim().toUpperCase();
    if (!email || !name || !USER_ROLES.includes(role)) throw new Error(`Invalid OTP_LOGIN_USERS entry: ${item}`);
    accounts.set(email, { email, name, role });
  }
  return accounts;
}

export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function maskEmail(value) {
  const [local, domain] = String(value || "").split("@");
  if (!local || !domain) return "registered RX inbox";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}
