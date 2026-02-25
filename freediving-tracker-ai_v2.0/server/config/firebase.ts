import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// For production, you should use a service account JSON file
// or environment variables for the service account details.
// Here we assume the environment is already authenticated via ADC 
// or we use the project ID if running in a Google environment.

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    databaseURL: process.env.VITE_FIREBASE_DATABASE_URL,
  });
}

export const db = admin.firestore();
export const rtdb = admin.database();
export const auth = admin.auth();
