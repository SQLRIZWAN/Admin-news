# KWT News — Admin Panel

Admin dashboard for the **kwt-news** Firebase project: article management,
ads, comments, users, push notifications, social-media queue, and the
fully-automated AI news publishing pipeline (GitHub Actions + Python).

- **Frontend**: React 18 (JSX pre-compiled to `app.compiled.js` by Babel).
- **Backend**: Firebase (Firestore + Auth + Hosting).
- **Automation**: Python pipeline running in GitHub Actions on cron schedules.
- **CI/CD**: `deploy.yml` builds the JSX and deploys Firestore indexes, rules
  and hosting on every push to `main`.

---

## One-time setup (zero-click thereafter)

### 1. Confirm GitHub secrets
Repo → **Settings → Secrets and variables → Actions** → verify these exist:

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase admin credentials (full JSON contents of a service-account key file). Used by CI deploy and the Python pipeline. |
| `GEMINI_API_KEY` | Gemini AI for script generation. |
| `PEXELS_API_KEY` | Pexels video clips. |
| `PIXABAY_API_KEY` | Pixabay images + video fallback. |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | YouTube upload. |
| `X_API_KEY`, `X_API_SECRET` | X/Twitter posting. |

### 2. Grant the service account index permissions
Firestore indexes and rules can only be deployed by a principal with the
**Cloud Datastore Index Admin** role. Do this once:

1. Open https://console.cloud.google.com/iam-admin/iam?project=kwt-news
2. Find the principal matching the `client_email` from your
   `FIREBASE_SERVICE_ACCOUNT` JSON.
3. Click the pencil → **Add another role** → select
   **Cloud Datastore Index Admin**. Save.
4. (Also recommended) **Firebase Rules Admin**, **Firebase Hosting Admin**.

### 3. (One-shot) Backfill legacy docs missing `timestamp`
The admin dashboard uses server-side `orderBy('timestamp')`, which silently
omits docs missing that field. Run this **once** to populate any legacy docs:

```bash
cd scripts
npm install
FIREBASE_SERVICE_ACCOUNT="$(cat /path/to/service-account.json)" \
  npm run backfill:timestamps
```

Idempotent — safe to re-run.

### 4. First deploy
Push any change to `main` — the `deploy.yml` workflow will:

1. `npm ci` (root) and `npm run build` (Babel compiles `app_jsx.jsx` → `app.compiled.js`).
2. `firebase deploy --only firestore:indexes,firestore:rules,hosting`.

After that, **every push to `main`** that touches the admin panel auto-deploys.

---

## Local dev

```bash
# Install babel
npm install

# Recompile after editing app_jsx.jsx
npm run build

# Open index.html in a browser (or `npx serve .`)

# Deploy manually if needed
npm run deploy             # all: build + indexes + rules + hosting
npm run deploy:indexes     # only firestore indexes
npm run deploy:rules       # only firestore rules
npm run deploy:hosting     # only Firebase Hosting
```

## Automation pipeline

Cron-triggered GitHub Actions post AI-generated news videos to Firestore:

| Workflow | Schedule (UTC) | Category |
|---|---|---|
| `.github/workflows/auto-world.yml`     | every 2 hours | world |
| `.github/workflows/auto-kuwait.yml`    | 03:00 & 15:00 | kuwait |
| `.github/workflows/auto-jobs.yml`      | 06:00 every 2 days | kuwait-jobs |
| `.github/workflows/auto-offers.yml`    | 07:00 daily | kuwait-offers |
| `.github/workflows/auto-funny.yml`     | 17:00 daily | funny-news-meme |
| `.github/workflows/news-watcher.yml`   | every 30 min | breaking-news watcher |
| `.github/workflows/run-all.yml`        | manual dispatch | all categories |
| `.github/workflows/test-pipeline.yml`  | manual dispatch | selected category |
| `.github/workflows/deploy.yml`         | on push to main | Firestore + Hosting deploy |

The pipeline (`scripts/video_pipeline/main.py`) is **fail-closed**: if
anti-rapid-fire or pipeline-lock checks error out, the run is skipped rather
than risking duplicates. The next scheduled run recovers automatically.

## Firestore schema

See `firestore.indexes.json` for all composite indexes (auto-deployed).
Key collections:
- `news` — articles (published immediately by the pipeline)
- `automation_config`, `automation_logs` — automation state and history
- `pipeline_locks` — prevents parallel runs
- `social_accounts`, `social_media_queue` — social posting credentials and queue
- `logos`, `ads`, `comments`, `users`, `fcm_tokens`, `notification_history`

---

## Troubleshooting

**"The query requires an index"** — `deploy.yml` was expected to create it.
Open https://console.firebase.google.com/project/kwt-news/firestore/indexes
and confirm the index is `Enabled` (can take 2–10 minutes for new indexes).

**Admin panel writes fail with `permission-denied`** — check the user is
logged in (email + password) and `firestore.rules` have been deployed
(`npm run deploy:rules`).

**Auto-publish not running** — check GitHub Actions → recent workflow runs.
If `automation_logs` shows `skipped: anti-rapid-fire check failed`, the
Firestore query errored — see the workflow logs for the underlying error.
