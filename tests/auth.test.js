import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuthenticate } from "../src/middleware/authenticate.js";
import { authorizeRole } from "../src/middleware/authorize.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { MemoryStore } from "./helpers/memory-store.js";

function appWith(users, tokens) {
  const store = new MemoryStore({ users });
  const auth = { verifyIdToken: async (token) => {
    if (!tokens[token]) throw new Error("invalid");
    return tokens[token];
  } };
  const app = express();
  app.use((req, _res, next) => { req.id = "test-request"; next(); });
  app.get("/private", createAuthenticate({ auth, store }), (req, res) => res.json(req.auth));
  app.get("/admin", createAuthenticate({ auth, store }), authorizeRole("ADMIN"), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

function appWithOtpSession(user) {
  const store = new MemoryStore({ users: { [user.userId]: user } });
  const otpAuth = { authenticateSession: async (token) => {
    if (token !== "rxs_valid") throw new Error("invalid");
    return user;
  } };
  const auth = { verifyIdToken: async () => { throw new Error("Firebase fallback must not run"); } };
  const app = express();
  app.use((req, _res, next) => { req.id = "test-request"; next(); });
  app.get("/private", createAuthenticate({ auth, store, otpAuth }), (req, res) => res.json(req.auth));
  app.use(errorHandler);
  return app;
}

describe("Firebase authentication and authorization", () => {
  const users = {
    admin: { userId: "USR_ADMIN", orgId: "RXDH", firebaseUid: "uid-admin", role: "ADMIN", active: true, permissions: [] },
    sales: { userId: "USR_SALES", orgId: "RXDH", firebaseUid: "uid-sales", role: "SALES", active: true, permissions: ["leads.read_assigned"] },
    disabled: { userId: "USR_DISABLED", orgId: "RXDH", firebaseUid: "uid-disabled", role: "SALES", active: false, permissions: [] }
  };
  const tokens = {
    admin: { uid: "uid-admin", orgId: "RXDH" },
    sales: { uid: "uid-sales", orgId: "RXDH" },
    disabled: { uid: "uid-disabled", orgId: "RXDH" },
    crossOrg: { uid: "uid-sales", orgId: "OTHER" }
  };

  it("denies unauthenticated and disabled users", async () => {
    expect((await request(appWith(users, tokens)).get("/private")).status).toBe(401);
    expect((await request(appWith(users, tokens)).get("/private").set("Authorization", "Bearer disabled")).status).toBe(403);
  });

  it("rejects cross-organization token claims", async () => {
    expect((await request(appWith(users, tokens)).get("/private").set("Authorization", "Bearer crossOrg")).status).toBe(403);
  });

  it("allows ADMIN and restricts SALES from admin operations", async () => {
    expect((await request(appWith(users, tokens)).get("/admin").set("Authorization", "Bearer admin")).status).toBe(200);
    expect((await request(appWith(users, tokens)).get("/admin").set("Authorization", "Bearer sales")).status).toBe(403);
  });

  it("accepts a valid shared-inbox OTP session without Firebase Authentication", async () => {
    const user = users.sales;
    const response = await request(appWithOtpSession(user)).get("/private").set("Authorization", "Bearer rxs_valid");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ userId: "USR_SALES", role: "SALES", orgId: "RXDH" });
  });
});
