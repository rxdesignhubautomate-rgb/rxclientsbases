let app;
let startupFailure;
let startupDebug;
let bootstrapPromise;

async function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      try {
        const [{ createApp }, { assertStartupEnv }] = await Promise.all([
          import("../src/app.js"),
          import("../src/config/env.js")
        ]);
        assertStartupEnv();
        app = createApp();
      } catch (error) {
        startupFailure = publicStartupFailure(error);
        startupDebug = {
          name: error?.name || "Error",
          code: error?.code || null,
          message: String(error?.message || "Unknown startup error").slice(0, 2000),
          stack: String(error?.stack || "").split("\n").slice(0, 12)
        };
        console.error("vercel_bootstrap_failed", startupDebug);
      }
    })();
  }
  await bootstrapPromise;
}

export default async function handler(req, res) {
  await bootstrap();
  if (startupFailure) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    const body = {
      success: false,
      error: startupFailure,
      help: "Correct the Production environment variables in Vercel, then redeploy."
    };
    // Set DEBUG_STARTUP=true in Vercel env to see the real error in the HTTP response.
    // REMOVE / set to false once the deploy is fixed.
    if (String(process.env.DEBUG_STARTUP).toLowerCase() === "true") {
      body.debug = startupDebug;
      body.envPresence = envPresence();
    }
    return res.end(JSON.stringify(body, null, 2));
  }
  return app(req, res);
}

function envPresence() {
  const keys = [
    "NODE_ENV",
    "APP_BASE_URL",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_STORAGE_BUCKET",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
    "META_ACCESS_TOKEN",
    "META_PHONE_NUMBER_ID",
    "OPENAI_API_KEY",
    "AI_DEFAULT_MODE",
    "TRUST_PROXY",
    "WORKERS_ENABLED",
    "ENABLE_LEGACY_DUAL_WRITE",
    "USE_NEW_CRM_READS",
    "LEGACY_JOBS_ENABLED",
    "ALLOWED_ORIGINS"
  ];
  const out = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) {
      out[key] = "MISSING";
    } else if (key === "FIREBASE_PRIVATE_KEY") {
      out[key] = {
        length: value.length,
        startsWithBeginMarker: value.trimStart().startsWith("-----BEGIN"),
        wrappedInQuotes: /^["'].*["']$/s.test(value.trim()),
        hasEscapedNewlines: value.includes("\\n"),
        hasRealNewlines: value.includes("\n"),
        endsWithEndMarker: value.trimEnd().endsWith("-----END PRIVATE KEY-----")
      };
    } else if (/TOKEN|SECRET|KEY/.test(key)) {
      out[key] = `present(len=${value.length})`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function publicStartupFailure(error) {
  const message = String(error?.message || "Application startup failed");
  if (/private key|PEM/i.test(message)) {
    return {
      code: "INVALID_FIREBASE_PRIVATE_KEY",
      message: "FIREBASE_PRIVATE_KEY is not valid. Paste the service-account private_key without surrounding JSON quotes. Escaped \\n characters are supported."
    };
  }
  if (/Missing required environment variables:/i.test(message) || /Invalid environment configuration:/i.test(message)) {
    return { code: "INVALID_ENVIRONMENT", message: message.slice(0, 500) };
  }
  if (error?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/i.test(message)) {
    return { code: "MODULE_NOT_FOUND", message: message.slice(0, 500) };
  }
  return {
    code: "STARTUP_FAILED",
    message: "Application startup failed. Open the Vercel function logs and locate vercel_bootstrap_failed."
  };
}