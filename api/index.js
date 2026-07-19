let app;
let startupFailure;
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
        console.error("vercel_bootstrap_failed", {
          name: error?.name || "Error",
          message: String(error?.message || "Unknown startup error").slice(0, 1000)
        });
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
    return res.end(JSON.stringify({
      success: false,
      error: startupFailure,
      help: "Correct the Production environment variables in Vercel, then redeploy."
    }));
  }
  return app(req, res);
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
  return {
    code: "STARTUP_FAILED",
    message: "Application startup failed. Open the Vercel function logs and locate vercel_bootstrap_failed."
  };
}
