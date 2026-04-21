#!/usr/bin/env node
/**
 * Idempotent backfill: populate missing `timestamp` on legacy `news` docs.
 *
 * Why: the admin dashboard / public site use server-side
 * `orderBy('timestamp','desc')`. Firestore silently omits docs missing the
 * sort field, so any legacy doc without `timestamp` would vanish from lists.
 * This script finds those docs and sets `timestamp = createdAt || now`.
 *
 * Idempotent via a marker doc (`_meta/backfill_status`) — once a clean pass
 * is complete, subsequent runs skip quickly. Safe to run on every CI deploy.
 *
 * Usage (CI or local):
 *     FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node backfill-timestamps.js
 *
 * Flags:
 *     --force   ignore the marker doc and do a full rescan
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

const FORCE = process.argv.includes('--force');
const MARKER_COL = '_meta';
const MARKER_DOC = 'backfill_status';
// Bump this when the backfill logic changes, to force a re-run.
const BACKFILL_VERSION = 1;

function getDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT env var is required (JSON string).');
    process.exit(1);
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  return getFirestore();
}

async function readMarker(db) {
  try {
    const snap = await db.collection(MARKER_COL).doc(MARKER_DOC).get();
    return snap.exists ? snap.data() : null;
  } catch {
    return null;
  }
}

async function writeMarker(db, stats) {
  try {
    await db.collection(MARKER_COL).doc(MARKER_DOC).set({
      version: BACKFILL_VERSION,
      lastRunAt: FieldValue.serverTimestamp(),
      ...stats,
    }, { merge: true });
  } catch (e) {
    console.warn('   (could not write marker doc — continuing):', e.message);
  }
}

async function main() {
  const db = getDb();

  const marker = await readMarker(db);
  if (!FORCE && marker && marker.version === BACKFILL_VERSION && marker.pendingCount === 0) {
    console.log(`✓ Backfill already complete (version ${marker.version}). Pass --force to rescan.`);
    return;
  }

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
    const ts = (fallback && typeof fallback.toDate === 'function')
      ? fallback
      : FieldValue.serverTimestamp();

    writer.update(doc.ref, { timestamp: ts });
    fixed++;
    pending++;

    if (pending >= 400) {
      await writer.commit();
      writer = db.batch();
      pending = 0;
      console.log(`  … committed batch, total fixed so far: ${fixed}`);
    }
  }

  if (pending > 0) await writer.commit();

  console.log('\n📊 Backfill complete');
  console.log(`    Total docs scanned:    ${total}`);
  console.log(`    Already had timestamp: ${alreadyOk}`);
  console.log(`    Backfilled:            ${fixed}`);

  await writeMarker(db, { totalScanned: total, fixed, pendingCount: 0 });
}

main().catch(e => {
  console.error('❌ Backfill failed:', e);
  process.exit(1);
});
