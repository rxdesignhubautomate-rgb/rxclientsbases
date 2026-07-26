import { describe, expect, it, vi } from "vitest";
import { PasswordAuthService } from "../src/services/password-auth.service.js";
import { MemoryStore } from "./helpers/memory-store.js";

const env = {
  ORG_ID: "RXDH",
  PASSWORD_LOGIN_ENABLED: true,
  FIREBASE_WEB_API_KEY: "test-web-api-key",
  OTP_LOGIN_USERS: "admin@rxdesignhub.com|Admin|OWNER;ankit@rxdesignhub.com|Ankit|SALES"
};

function jsonResponse(body, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

describe("Firebase email/password authentication", () => {
  it("signs in an approved Firebase user and links the CRM user record", async () => {
    const store = new MemoryStore({
      users: {
        existing: {
          userId: "existing",
          orgId: "RXDH",
          firebaseUid: "otp:old-placeholder",
          email: "ankit@rxdesignhub.com",
          name: "Ankit",
          role: "SALES",
          active: true,
          permissions: []
        }
      }
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      idToken: "firebase-id-token",
      refreshToken: "firebase-refresh-token",
      expiresIn: "3600",
      localId: "firebase-uid-ankit",
      email: "ankit@rxdesignhub.com"
    }));
    const auth = { verifyIdToken: vi.fn().mockResolvedValue({ uid: "firebase-uid-ankit", email: "ankit@rxdesignhub.com" }) };
    const service = new PasswordAuthService({ store, auth, env, fetchImpl });

    const result = await service.login("Ankit@RXDesignHub.com", "575757");

    expect(result).toMatchObject({ accessToken: "firebase-id-token", refreshToken: "firebase-refresh-token", user: { role: "SALES" } });
    expect((await store.get("users", "existing")).firebaseUid).toBe("firebase-uid-ankit");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("accounts:signInWithPassword"), expect.objectContaining({ method: "POST" }));
  });

  it("returns a safe error for incorrect Firebase credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, false, 400));
    const service = new PasswordAuthService({ store: new MemoryStore(), auth: {}, env, fetchImpl });

    await expect(service.login("admin@rxdesignhub.com", "wrong-password")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401
    });
  });

  it("refreshes an existing Firebase session without asking for the password again", async () => {
    const store = new MemoryStore({
      users: {
        admin: {
          userId: "admin",
          orgId: "RXDH",
          firebaseUid: "firebase-uid-admin",
          email: "admin@rxdesignhub.com",
          name: "Admin",
          role: "OWNER",
          active: true,
          permissions: ["*"]
        }
      }
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      id_token: "refreshed-id-token",
      refresh_token: "refreshed-refresh-token",
      expires_in: "3600"
    }));
    const auth = { verifyIdToken: vi.fn().mockResolvedValue({ uid: "firebase-uid-admin", email: "admin@rxdesignhub.com" }) };
    const service = new PasswordAuthService({ store, auth, env, fetchImpl });

    const result = await service.refresh("existing-refresh-token-value");

    expect(result).toMatchObject({ accessToken: "refreshed-id-token", refreshToken: "refreshed-refresh-token", user: { role: "OWNER" } });
  });
});
