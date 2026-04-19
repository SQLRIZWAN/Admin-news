"""
Firebase Admin SDK helpers:
- Read recent news for duplicate detection
- Post new article to 'news' collection
- Read/write 'automation_config' and 'automation_logs' collections
- Look up source logos from 'logos' collection
"""

import os
import re
import json
import time
import requests
from datetime import datetime, timezone, timedelta

import firebase_admin
from firebase_admin import credentials, firestore

_db = None


def _get_db():
    global _db
    if _db is not None:
        return _db

    if not firebase_admin._apps:
        raw = os.environ.get('FIREBASE_SERVICE_ACCOUNT', '')
        if not raw:
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT secret is not set. "
                "Add it in: GitHub repo → Settings → Secrets → Actions"
            )
        sa = json.loads(raw)
        cred = credentials.Certificate(sa)
        firebase_admin.initialize_app(cred)

    _db = firestore.client()
    return _db


# ── Duplicate detection ──────────────────────────────────────────────────────

_STOP = {
    'the','a','an','is','in','on','at','to','for','of','and','or','but','with',
    'from','by','as','it','its','this','that','was','are','be','been','will',
    'has','have','had','not','no','new','latest','update','breaking','today',
    'now','just','after','over','more','than','kuwait','world','news',
}


def _tokenize(title: str) -> set:
    words = set()
    for w in title.lower().split():
        w = re.sub(r'[^\w]', '', w)
        if len(w) > 2 and w not in _STOP:
            words.add(w)
    return words


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def get_recent_news(category: str, days: int = 7) -> list:
    """Fetch recent news for a single category from Firestore."""
    try:
        db = _get_db()
        since = datetime.now(timezone.utc) - timedelta(days=days)
        snap = (
            db.collection('news')
            .where('category', '==', category)
            .where('timestamp', '>=', since)
            .order_by('timestamp', direction=firestore.Query.DESCENDING)
            .limit(60)
            .get()
        )
        return [{'id': d.id, **d.to_dict()} for d in snap]
    except Exception as e:
        # Common cause: composite index not yet created in Firestore.
        # Safe to return [] — duplicate check will pass and pipeline continues.
        print(f"   ⚠️  get_recent_news error (skipping dedup, will still post): {e}")
        return []


def get_all_recent_news(days: int = 3) -> list:
    """Fetch recent news across ALL categories — for cross-category duplicate check.
    Returns empty list on any error."""
    try:
        db = _get_db()
        since = datetime.now(timezone.utc) - timedelta(days=days)
        snap = (
            db.collection('news')
            .where('timestamp', '>=', since)
            .order_by('timestamp', direction=firestore.Query.DESCENDING)
            .limit(200)
            .get()
        )
        return [{'id': d.id, **d.to_dict()} for d in snap]
    except Exception as e:
        print(f"   ⚠️  get_all_recent_news error (skipping cross-category dedup): {e}")
        return []


def get_used_thumbnail_urls(days: int = 30) -> set:
    """
    Return the set of Pixabay thumbnail URLs used in the last N days.
    Used by clip_fetcher to prevent identical thumbnails across articles.
    """
    try:
        db = _get_db()
        since = datetime.now(timezone.utc) - timedelta(days=days)
        snap = (
            db.collection('news')
            .where('timestamp', '>=', since)
            .order_by('timestamp', direction=firestore.Query.DESCENDING)
            .limit(200)
            .get()
        )
        urls = set()
        for doc in snap:
            d = doc.to_dict()
            for field in ('thumbnail', 'imageUrl'):
                url = d.get(field, '')
                if url and 'pixabay' in url.lower():
                    urls.add(url)
        return urls
    except Exception as e:
        print(f"   ⚠️  get_used_thumbnail_urls error: {e}")
        return set()


def check_duplicate(new_title: str, existing: list, threshold: float = 0.45) -> dict:
    """
    Returns {'is_duplicate': bool, 'matched_title': str, 'score': float}.
    """
    new_tok = _tokenize(new_title)
    for article in existing:
        title = article.get('title', '')
        if not title:
            continue
        score = _jaccard(new_tok, _tokenize(title))
        if score >= threshold:
            return {'is_duplicate': True, 'matched_title': title, 'score': round(score, 3)}
    return {'is_duplicate': False, 'matched_title': '', 'score': 0.0}


# ── Logos ────────────────────────────────────────────────────────────────────

def _domain_from_source(source_name: str) -> str:
    """Guess a domain from a source name (e.g. 'BBC News' → 'bbc.com')."""
    _MAP = {
        'bbc': 'bbc.com', 'aljazeera': 'aljazeera.com', 'al jazeera': 'aljazeera.com',
        'reuters': 'reuters.com', 'nytimes': 'nytimes.com', 'new york times': 'nytimes.com',
        'cnn': 'cnn.com', 'guardian': 'theguardian.com', 'ap news': 'apnews.com',
        'arab times': 'arabtimesonline.com', 'kuwait times': 'kuwaittimes.com',
        'kuna': 'kuna.net.kw', 'gulf news': 'gulfnews.com', 'bayt': 'bayt.com',
        'gulftalent': 'gulftalent.com', 'the onion': 'theonion.com',
    }
    s = source_name.lower()
    for key, domain in _MAP.items():
        if key in s:
            return domain
    # Fallback: convert "BBC News" → "bbcnews.com"  (rough guess)
    slug = re.sub(r'[^a-z0-9]', '', s.split()[0])
    return f"{slug}.com" if slug else ''


def _fetch_clearbit_logo(source_name: str) -> str:
    """Try Clearbit logo API for the source domain. Returns URL if accessible."""
    domain = _domain_from_source(source_name)
    if not domain:
        return ''
    url = f"https://logo.clearbit.com/{domain}"
    try:
        r = requests.get(url, timeout=8)
        if r.status_code == 200 and len(r.content) > 500:
            return url
    except Exception:
        pass
    return ''


def _save_logo_to_collection(source_name: str, logo_url: str) -> None:
    """Save a discovered logo to the Firestore logos collection for future use."""
    try:
        db = _get_db()
        db.collection('logos').add({
            'name': source_name,
            'url': logo_url,
            'autoAdded': True,
            'createdAt': firestore.SERVER_TIMESTAMP,
        })
        print(f"   ✅ Auto-saved logo for '{source_name}' to collection")
    except Exception as e:
        print(f"   Logo save error: {e}")


def get_source_logo(source_name: str) -> str:
    """
    Look up the source logo URL from the Firestore 'logos' collection.
    If not found, tries Clearbit logo API and saves result to collection.
    Returns logo URL string or empty string if not found.
    """
    if not source_name:
        return ''
    try:
        db = _get_db()
        snap = db.collection('logos').limit(100).get()
        name_lower = source_name.lower()
        for doc in snap:
            data = doc.to_dict()
            logo_name = (data.get('name') or '').lower()
            if logo_name and (logo_name in name_lower or name_lower in logo_name):
                return data.get('url', '')
    except Exception as e:
        print(f"   Logo collection error: {e}")

    # Not in collection — try auto-fetch from Clearbit
    print(f"   🔍 Logo not in collection, trying Clearbit for '{source_name}'...")
    clearbit_url = _fetch_clearbit_logo(source_name)
    if clearbit_url:
        print(f"   ✅ Clearbit logo found: {clearbit_url}")
        _save_logo_to_collection(source_name, clearbit_url)
        return clearbit_url

    print(f"   — No logo found for '{source_name}'")
    return ''


# ── Post news ────────────────────────────────────────────────────────────────

def post_news(article: dict) -> str:
    """
    Add a news article to the 'news' Firestore collection.
    Returns the new document ID.
    """
    db = _get_db()
    ts = firestore.SERVER_TIMESTAMP
    doc = {
        # Article fields
        'title':          article.get('title', ''),
        'summary':        article.get('summary', ''),
        'content':        article.get('content', ''),
        'videoUrl':       article.get('videoUrl', ''),
        'videoPublicId':  article.get('videoPublicId', ''),
        'thumbnail':      article.get('thumbnail', ''),
        'imageUrl':       article.get('imageUrl', ''),
        'imagePublicId':  article.get('imagePublicId', ''),
        'category':       article.get('category', ''),
        'source':         article.get('source', 'KWT News'),
        'sourceLogo':     article.get('sourceLogo', ''),
        'readTime':       article.get('readTime', '1 min read'),
        'mediaType':      article.get('mediaType', 'video'),
        'isBreaking':     article.get('isBreaking', False),
        # Always published immediately, visible in app
        'hidden':       False,
        'published':    True,
        'status':       'published',
        # Auto-post metadata
        'aiGenerated':  True,
        'autoPosted':   True,
        # Counters
        'views':        0,
        'likes':        0,
        'commentCount': 0,
        # Timestamp
        'timestamp':    ts,
        'createdAt':    ts,
    }
    # Retry up to 3 times with backoff — guards against transient Firestore errors
    delay = 3
    last_err = None
    for attempt in range(3):
        try:
            ref = db.collection('news').add(doc)
            return ref[1].id
        except Exception as e:
            last_err = e
            print(f"   Firestore write attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                time.sleep(delay)
                delay *= 2
    raise RuntimeError(f"Firestore post_news failed after 3 attempts: {last_err}")


# ── Pipeline lock (prevents parallel duplicate posts) ────────────────────────

def acquire_pipeline_lock(category: str, ttl_seconds: int = 600) -> bool:
    """
    Atomic Firestore transaction lock to prevent parallel pipeline runs
    from posting the same category simultaneously (e.g. run-all.yml matrix).
    Returns True if the lock was acquired, False if another run holds it.
    Fails open (returns True) if Firestore is unavailable — better to post
    than silently skip.
    """
    try:
        db = _get_db()
        lock_ref = db.collection('pipeline_locks').document(category)

        @firestore.transactional
        def _try_acquire(transaction):
            snap = lock_ref.get(transaction=transaction)
            now = datetime.now(timezone.utc)
            if snap.exists:
                data = snap.to_dict()
                expires_at = data.get('expires_at')
                if expires_at:
                    if isinstance(expires_at, str):
                        try:
                            expires_at = datetime.fromisoformat(expires_at)
                        except Exception:
                            expires_at = None
                    if expires_at:
                        if expires_at.tzinfo is None:
                            expires_at = expires_at.replace(tzinfo=timezone.utc)
                        if expires_at > now:
                            return False  # lock held by another run
            expires = now + timedelta(seconds=ttl_seconds)
            transaction.set(lock_ref, {
                'category': category,
                'acquired_at': now.isoformat(),
                'expires_at': expires.isoformat(),
                'run_id': os.environ.get('GITHUB_RUN_ID', 'local'),
            })
            return True

        return _try_acquire(db.transaction())
    except Exception as e:
        print(f"   ⚠️  Pipeline lock error (fail-open): {e}")
        return True  # fail open — post rather than silently skip


def release_pipeline_lock(category: str) -> None:
    """Release the pipeline lock for the given category after a successful run."""
    try:
        _get_db().collection('pipeline_locks').document(category).delete()
    except Exception:
        pass


# ── Automation config ────────────────────────────────────────────────────────

def get_automation_config(category: str) -> dict:
    """Return automation config for a category (defaults to enabled=True)."""
    try:
        db = _get_db()
        doc = db.collection('automation_config').document(category).get()
        if doc.exists:
            return doc.to_dict()
    except Exception as e:
        print(f"   Config read error: {e}")
    return {'enabled': True}


def update_automation_config(category: str, update: dict) -> None:
    """Merge-update the automation config for a category."""
    try:
        db = _get_db()
        db.collection('automation_config').document(category).set(
            {**update, 'lastRun': firestore.SERVER_TIMESTAMP},
            merge=True,
        )
    except Exception as e:
        print(f"   Config update error: {e}")


# ── Logging ──────────────────────────────────────────────────────────────────

def write_automation_log(
    category: str,
    status: str,
    news_id: str = '',
    reason: str = '',
) -> None:
    """Write a run record to the 'automation_logs' collection."""
    try:
        db = _get_db()
        db.collection('automation_logs').add({
            'category': category,
            'status': status,
            'newsId': news_id,
            'reason': reason,
            'timestamp': firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        print(f"   Log write error: {e}")
