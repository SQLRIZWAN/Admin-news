# KWT News — Admin Panel

Admin dashboard for the **kwt-news** Firebase project.

- **Hosting**: GitHub Pages → https://sqlrizwan.github.io/Admin-news/
- **Backend**: Firebase (Firestore + Auth).
- **Frontend**: React 18 (JSX precompiled to `app.compiled.js` by Babel in CI).
- **Automation**: Python pipeline on GitHub Actions cron schedules.

---

## Zero-click setup

**Push to `main` → everything deploys.**

| Workflow | Triggers | What it does |
|---|---|---|
| `pages.yml`   | push touches `app_jsx.jsx`, `index.html`, `package*.json`, `babel.config.json` | Runs `npm ci` → `npm run build` → publishes to GitHub Pages. |
| `deploy.yml`  | push touches `firestore.*`, `firebase.json`, the workflow itself | Runs one-shot backfill (idempotent), then deploys Firestore indexes + rules. Attempts IAM self-elevation once. |
| `pages build and deployment` | legacy Pages workflow (disabled — we use `pages.yml`) | n/a |

### Required GitHub secrets
Repo → **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase admin credentials (full JSON of a service-account key). Used by the automation pipeline and `deploy.yml`. |
| `GEMINI_API_KEY` | Gemini AI for script generation. |
| `PEXELS_API_KEY` | Pexels video clips. |
| `PIXABAY_API_KEY` | Pixabay images + video fallback. |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | YouTube upload. |
| `X_API_KEY`, `X_API_SECRET` | X/Twitter posting. |

### If `deploy.yml` shows a permissions error on Firestore
The SA needs IAM roles. The workflow tries to self-elevate; if that fails,
the deploy step posts the exact error and fix URL as a commit comment.
Grant the SA **Firebase Admin** once at
https://console.cloud.google.com/iam-admin/iam?project=kwt-news
and re-run the workflow.

Pages publishing and the automation pipeline work independently — they don't
need Firestore admin IAM.

---

## Local dev

```bash
npm install               # installs Babel
npm run build             # compiles app_jsx.jsx → app.compiled.js
npx serve .               # serves the admin panel locally
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
| `.github/workflows/deploy.yml`         | push to main (firestore files) | Firestore indexes + rules |
| `.github/workflows/pages.yml`          | push to main (frontend files)  | GitHub Pages build + deploy |

The pipeline (`scripts/video_pipeline/main.py`) is **fail-closed**: if
anti-rapid-fire or pipeline-lock checks error out, the run is skipped
rather than risking duplicates. The next scheduled run recovers automatically.

## Firestore schema

See `firestore.indexes.json` for all composite indexes. Key collections:
- `news` — articles (published immediately by the pipeline)
- `automation_config`, `automation_logs` — automation state and history
- `pipeline_locks` — prevents parallel runs
- `social_accounts`, `social_media_queue` — social posting credentials and queue
- `logos`, `ads`, `comments`, `users`, `fcm_tokens`, `notification_history`

---

## Troubleshooting

**Admin panel shows old JS** — Pages CDN caches. Open the site with
`?v=<timestamp>` or do a hard refresh. The `pages.yml` workflow rebuilds
`app.compiled.js` on every relevant push, so the next publish busts the cache.

**"The query requires an index"** — `deploy.yml` creates Firestore indexes
automatically on push. If permissions prevent it (see commit comment),
grant the SA Firebase Admin role once.

**Admin panel writes fail with `permission-denied`** — check the user is
logged in (email + password) and `firestore.rules` have been deployed.

**Auto-publish not running** — check GitHub Actions → recent workflow runs.
If `automation_logs` shows `skipped: anti-rapid-fire check failed`, the
Firestore query errored — see the workflow logs for the underlying error.
