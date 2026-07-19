import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { config } from "./config.js";

let app;

export function getDb() {
  if (!app) {
    app = getApps()[0] || initializeApp({
      credential: cert({
        projectId: config.firebaseProjectId,
        clientEmail: config.firebaseClientEmail,
        privateKey: config.firebasePrivateKey
      })
    });
  }
  return getFirestore(app);
}

export { FieldValue };
