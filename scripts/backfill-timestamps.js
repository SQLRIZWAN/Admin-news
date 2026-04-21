#!/usr/bin/env node
/**
 * One-shot: backfill missing `timestamp` field on legacy `news` docs.
 *
 * Why: the admin dashboard / site move to server-side orderBy('timestamp', 'desc')
 * for speed. Firestore's orderBy silently drops docs missing the sort field, so
 * any legacy doc without `timestamp` would vanish from the list. This script
 * finds those docs and sets `timestamp = createdAt || publishedAt || now`.
 *
 * Usage (local):
 *     cd scripts
 *     npm install
 *     FIREBASE_SERVICE_ACCOUNT="$(cat /path/to/sa.json)" npm run backfill:timestamps
 *
 * Idempotent. Safe to re-run.
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

function getDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT env var is required (JSON string).');
    process.exit(1);
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  return getFirestore();
}

async function main() {
  const db = getDb();
  console.log('🔍 Scanning `news` collection for docs missing `timestamp`…');

  const snap = await db.collection('news').get();
  const total = snap.size;
  let fixed = 0;
  let alreadyOk = 0;
  let writer = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.timestamp) { alreadyOk++; continue; }

    const fallback = d.createdAt || d.publishedAt || d.updatedAt || d.date || d.time;
    const ts = fallback instanceof Timestamp
      ? fallback
      : (fallback && typeof fallback.toDate === 'function')
        ? fallback
        : FieldValue.serverTimestamp();

    writer.update(doc.ref, { timestamp: ts });
    fixed++;
    pending++;

    // Flush every 400 writes (Firestore batch limit is 500)
    if (pending >= 400) {
      await writer.commit();
      writer = db.batch();
      pending = 0;
      console.log(`  … committed batch, total fixed so far: ${fixed}`);
    }
  }

  if (pending > 0) await writer.commit();

  console.log('\n📊 Backfill complete');
  console.log(`    Total docs scanned: ${total}`);
  console.log(`    Already had timestamp: ${alreadyOk}`);
  console.log(`    Backfilled: ${fixed}`);
}

main().catch(e => {
  console.error('❌ Backfill failed:', e);
  process.exit(1);
});
