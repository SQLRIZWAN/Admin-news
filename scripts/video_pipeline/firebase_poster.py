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

def get_source_logo(source_name: str) -> str:
    """
    Look up the source logo URL from the Firestore 'logos' collection.
    Does a case-insensitive partial-name match.
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
        print(f"   Logo lookup error: {e}")
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
        'title':        article.get('title', ''),
        'summary':      article.get('summary', ''),
        'content':      article.get('content', ''),
        'videoUrl':     article.get('videoUrl', ''),
        'thumbnail':    article.get('thumbnail', ''),
        'imageUrl':     article.get('imageUrl', ''),
        'category':     article.get('category', ''),
        'source':       article.get('source', 'KWT News'),
        'sourceLogo':   article.get('sourceLogo', ''),
        'readTime':     article.get('readTime', '1 min read'),
        'mediaType':    article.get('mediaType', 'video'),
        'isBreaking':   article.get('isBreaking', False),
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
    ref = db.collection('news').add(doc)
    return ref[1].id


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
