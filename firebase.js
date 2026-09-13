import admin from "firebase-admin";
import { config } from "./config.js";

let app;

export function getDb() {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebaseProjectId,
        clientEmail: config.firebaseClientEmail,
        privateKey: config.firebasePrivateKey
      })
    });
  }

  return admin.firestore(app);
}

export const FieldValue = admin.firestore.FieldValue;
