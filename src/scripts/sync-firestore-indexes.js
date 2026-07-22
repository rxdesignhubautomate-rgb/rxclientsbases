import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const dryRun = process.argv.includes("--dry-run");
const projectId = process.env.FIREBASE_PROJECT_ID;
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!projectId || !credentialsPath) {
  throw new Error("FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS are required");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const definition = JSON.parse(await fs.readFile(path.join(root, "firestore.indexes.json"), "utf8"));
const auth = new GoogleAuth({
  keyFilename: credentialsPath,
  scopes: ["https://www.googleapis.com/auth/datastore"]
});

const groups = Map.groupBy(definition.indexes || [], (index) => index.collectionGroup);
let existingCount = 0;
let missingCount = 0;
let createdCount = 0;
let readyCount = 0;
let buildingCount = 0;

for (const [collectionGroup, desiredIndexes] of groups) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/collectionGroups/${encodeURIComponent(collectionGroup)}/indexes`;
  const response = await auth.request({ url: baseUrl, method: "GET" });
  const existingIndexes = response.data.indexes || [];

  for (const desired of desiredIndexes) {
    const current = existingIndexes.find((candidate) => sameIndex(candidate, desired));
    if (current) {
      existingCount += 1;
      const state = current.state || "UNKNOWN";
      if (state === "READY") readyCount += 1;
      else buildingCount += 1;
      console.log(`exists  [${state}] ${collectionGroup} ${describe(desired)}`);
      continue;
    }

    missingCount += 1;
    console.log(`missing ${collectionGroup} ${describe(desired)}`);
    if (!dryRun) {
      await auth.request({
        url: baseUrl,
        method: "POST",
        data: {
          queryScope: desired.queryScope || "COLLECTION",
          fields: withDocumentName(desired.fields || [])
        }
      });
      createdCount += 1;
      console.log(`created ${collectionGroup} ${describe(desired)}`);
    }
  }
}

console.log(JSON.stringify({ dryRun, configured: definition.indexes?.length || 0, existing: existingCount, ready: readyCount, building: buildingCount, missing: missingCount, created: createdCount }));

function sameIndex(current, desired) {
  if ((current.queryScope || "COLLECTION") !== (desired.queryScope || "COLLECTION")) return false;
  const currentFields = (current.fields || []).filter((field) => field.fieldPath !== "__name__");
  const desiredFields = desired.fields || [];
  return currentFields.length === desiredFields.length && currentFields.every((field, index) => {
    const wanted = desiredFields[index];
    return field.fieldPath === wanted.fieldPath
      && (field.order || null) === (wanted.order || null)
      && (field.arrayConfig || null) === (wanted.arrayConfig || null);
  });
}

function withDocumentName(fields) {
  if (fields.some((field) => field.fieldPath === "__name__")) return fields;
  const lastOrdered = [...fields].reverse().find((field) => field.order);
  return [...fields, { fieldPath: "__name__", order: lastOrdered?.order || "ASCENDING" }];
}

function describe(index) {
  return (index.fields || []).map((field) => `${field.fieldPath}:${field.order || field.arrayConfig}`).join(",");
}
