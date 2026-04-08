// Firebase Admin SDK helpers for reading and writing to Firestore

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

let db;

function getDb() {
  if (db) return db;

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  db = getFirestore();
  return db;
}

/**
 * Fetch recent news for a category (last N days).
 * @param {string} category
 * @param {number} days
 * @returns {Promise<Array>}
 */
export async function getRecentNews(category, days = 7) {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const snap = await db.collection('news')
    .where('category', '==', category)
    .where('timestamp', '>=', Timestamp.fromDate(since))
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Add a news article to Firestore.
 * @param {object} article
 * @returns {Promise<string>} doc id
 */
export async function addNews(article) {
  const db = getDb();
  const ref = await db.collection('news').add({
    ...article,
    timestamp: Timestamp.now(),
    views: 0,
    likes: 0,
    commentCount: 0,
    hidden: false,
    aiGenerated: true,
  });
  return ref.id;
}

/**
 * Get automation config for a category.
 * @param {string} category
 * @returns {Promise<object>}
 */
export async function getAutomationConfig(category) {
  const db = getDb();
  const doc = await db.collection('automation_config').doc(category).get();
  if (!doc.exists) return { enabled: true }; // default: enabled
  return doc.data();
}

/**
 * Update automation config after a run.
 * @param {string} category
 * @param {object} update
 */
export async function updateAutomationConfig(category, update) {
  const db = getDb();
  await db.collection('automation_config').doc(category).set(update, { merge: true });
}

/**
 * Write a log entry to automation_logs collection.
 * @param {object} entry
 */
export async function writeLog(entry) {
  const db = getDb();
  await db.collection('automation_logs').add({
    ...entry,
    timestamp: Timestamp.now(),
  });
}
