import fs from "node:fs/promises";
import path from "node:path";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const flags = parseFlags(process.argv.slice(2));
if (!flags["service-account"]) {
  throw new Error(
    "Usage: node src/scripts/diagnose-storage-bucket.js --service-account=<path> [--bucket=<name>]",
  );
}

const serviceAccount = JSON.parse(
  await fs.readFile(path.resolve(String(flags["service-account"])), "utf8"),
);
const projectId = serviceAccount.project_id;
const candidates = [
  flags.bucket,
  `${projectId}.firebasestorage.app`,
  `${projectId}.appspot.com`,
].filter(Boolean);
const app = initializeApp(
  { credential: cert(serviceAccount) },
  `storage-diagnostic-${Date.now()}`,
);

try {
  const results = [];
  for (const bucketName of [...new Set(candidates)]) {
    try {
      const [metadata] = await getStorage(app).bucket(bucketName).getMetadata();
      results.push({
        bucket: bucketName,
        exists: true,
        location: metadata.location || null,
        storageClass: metadata.storageClass || null,
      });
    } catch (error) {
      results.push({
        bucket: bucketName,
        exists: false,
        code: Number(error.code) || null,
        message: String(error.message || error).slice(0, 200),
      });
    }
  }
  console.log(JSON.stringify({ projectId, results }, null, 2));
} finally {
  await deleteApp(app);
}

function parseFlags(argumentsList) {
  return Object.fromEntries(
    argumentsList
      .filter((argument) => argument.startsWith("--") && argument.includes("="))
      .map((argument) => {
        const [key, ...rest] = argument.slice(2).split("=");
        return [key, rest.join("=")];
      }),
  );
}
