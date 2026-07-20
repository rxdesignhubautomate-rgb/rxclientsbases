import { describe, expect, it } from "vitest";
import { OtpAuthService, digest } from "../src/services/otp-auth.service.js";
import { MemoryStore } from "./helpers/memory-store.js";

function setup() {
  const store = new MemoryStore();
  const sent = [];
  const mailer = {
    configured: () => true,
    send: async (message) => sent.push(message)
  };
  const env = {
    ORG_ID: "RXDH",
    OTP_LOGIN_ENABLED: true,
    OTP_DELIVERY_EMAIL: "rxdesignlko@gmail.com",
    OTP_HASH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    OTP_TTL_MINUTES: 10,
    OTP_SESSION_HOURS: 12,
    OTP_LOGIN_USERS: "admin@rxdesignhub.com|Admin|OWNER;ankit@rxdesignhub.com|Ankit|SALES"
  };
  const service = new OtpAuthService({
    store,
    mailer,
    env,
    codeGenerator: () => "123456",
    tokenGenerator: () => "rxs_test_session"
  });
  return { store, sent, service };
}

describe("shared-inbox OTP authentication", () => {
  it("sends an OTP only for an approved login ID to the fixed inbox", async () => {
    const { sent, service } = setup();
    const result = await service.requestOtp("Ankit@RXDesignHub.com");
    expect(result.email).toBe("ankit@rxdesignhub.com");
    expect(result.deliveryHint).toBe("rx*********@gmail.com");
    expect(sent).toEqual([{ loginEmail: "ankit@rxdesignhub.com", code: "123456", expiresInMinutes: 10 }]);
    await expect(service.requestOtp("stranger@example.com")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("rejects wrong codes, accepts once, provisions the role and issues a session", async () => {
    const { store, service } = setup();
    await service.requestOtp("ankit@rxdesignhub.com");
    await expect(service.verifyOtp("ankit@rxdesignhub.com", "000000")).rejects.toMatchObject({ code: "INVALID_OTP" });
    const otp = await store.get("loginOtps", digest("ankit@rxdesignhub.com"));
    expect(otp.attempts).toBe(1);

    const result = await service.verifyOtp("ankit@rxdesignhub.com", "123456");
    expect(result.accessToken).toBe("rxs_test_session");
    expect(result.user.role).toBe("SALES");
    const authenticated = await service.authenticateSession(result.accessToken);
    expect(authenticated.email).toBe("ankit@rxdesignhub.com");
    expect(authenticated.permissions).toContain("contacts.read_assigned");
    await expect(service.verifyOtp("ankit@rxdesignhub.com", "123456")).rejects.toMatchObject({ code: "OTP_INVALID_OR_EXPIRED" });
  });

  it("rejects expired OTPs and expired sessions", async () => {
    const { store, service } = setup();
    await service.requestOtp("admin@rxdesignhub.com");
    await store.update("loginOtps", digest("admin@rxdesignhub.com"), { expiresAt: new Date(Date.now() - 1000) });
    await expect(service.verifyOtp("admin@rxdesignhub.com", "123456")).rejects.toMatchObject({ code: "OTP_INVALID_OR_EXPIRED" });

    await service.requestOtp("ankit@rxdesignhub.com");
    const result = await service.verifyOtp("ankit@rxdesignhub.com", "123456");
    await store.update("loginSessions", digest(result.accessToken), { expiresAt: new Date(Date.now() - 1000) });
    await expect(service.authenticateSession(result.accessToken)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("does not consume a correct OTP when user provisioning fails", async () => {
    const { store, service } = setup();
    await service.requestOtp("admin@rxdesignhub.com");
    service.provisionAccount = async () => {
      throw new Error("temporary database failure");
    };

    await expect(service.verifyOtp("admin@rxdesignhub.com", "123456")).rejects.toThrow("temporary database failure");
    const otp = await store.get("loginOtps", digest("admin@rxdesignhub.com"));
    expect(otp.consumed).toBe(false);
  });
});
