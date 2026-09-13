import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { env } from "./env.js";

let firebase;

export function getFirebase() {
  if (firebase) return firebase;
  const app =
    getApps()[0] ||
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY
      }),
      storageBucket: env.FIREBASE_STORAGE_BUCKET
    });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  firebase = {
    app,
    db,
    auth: getAuth(app),
    bucket: getStorage(app).bucket(),
    FieldValue
  };
  return firebase;
}

export async function checkFirebaseReady() {
  const { db } = getFirebase();
  await db.collection("systemSettings").doc("readiness").get();
  return true;
}
