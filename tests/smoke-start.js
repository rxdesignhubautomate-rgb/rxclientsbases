import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const port = 31_000 + (process.pid % 1000);
Object.assign(process.env, {
  NODE_ENV: "production",
  PORT: String(port),
  APP_BASE_URL: `http://127.0.0.1:${port}`,
  ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
  FIREBASE_PROJECT_ID: "rx-smoke-test",
  FIREBASE_CLIENT_EMAIL: "smoke@rx-smoke-test.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  FIREBASE_STORAGE_BUCKET: "rx-smoke-test.appspot.com",
  META_APP_SECRET: "smoke-secret",
  META_VERIFY_TOKEN: "smoke-verify",
  META_ACCESS_TOKEN: "smoke-access",
  META_PHONE_NUMBER_ID: "smoke-phone",
  OPENAI_API_KEY: "smoke-openai",
  WORKERS_ENABLED: "false",
  LEGACY_JOBS_ENABLED: "false"
});

const { server } = await import("../src/server.js");
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== "ok" || body.service !== "rx-communication-crm") throw new Error("Unexpected health response");
  console.log("Production startup smoke check passed");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
