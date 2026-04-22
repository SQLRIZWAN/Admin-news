"""
Social Media Auto-Poster for KWT News.

Reads platform credentials from Firestore 'social_accounts' collection.
Called from main.py after a news article is posted to Firebase.
Uploads the news video to all connected social media platforms sequentially.

Supported platforms:
  - YouTube  : google-api-python-client + OAuth2 refresh token
  - Instagram : instagrapi library (session cookie JSON)
  - Facebook  : Graph API with Page Access Token
  - TikTok    : Cookie-based (MVP — placeholder with clear skip message)
  - X         : tweepy v4 with OAuth1 tokens
"""

import os
import json
import time
import requests

from firebase_poster import _get_db
from firebase_admin import firestore


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_account(platform: str) -> dict:
    """Fetch social account config from Firestore. Returns {} if not connected."""
    try:
        db = _get_db()
        doc = db.collection('social_accounts').document(platform).get()
        if doc.exists:
            data = doc.to_dict()
            if data.get('connected') and (data.get('accessToken') or data.get('cookieData')):
                return data
    except Exception as e:
        print(f"   social_accounts read error ({platform}): {e}")
    return {}


def _create_queue_entry(db, news_id: str, news_title: str, video_url: str,
                         thumbnail_url: str, platforms: list) -> str:
    """Write a social_media_queue document and return its ID."""
    ref = db.collection('social_media_queue').add({
        'newsId':       news_id,
        'newsTitle':    news_title,
        'videoUrl':     video_url,
        'thumbnailUrl': thumbnail_url,
        'platforms':    platforms,
        'status':       'processing',
        'createdAt':    firestore.SERVER_TIMESTAMP,
        'processedAt':  None,
        'results':      {},
    })
    return ref[1].id


def _update_queue_result(db, queue_id: str, platform: str,
                          success: bool, detail: str = '', post_id: str = '') -> None:
    """Update per-platform result in the queue document."""
    try:
        db.collection('social_media_queue').document(queue_id).update({
            f'results.{platform}': {
                'success': success,
                'postId':  post_id,
                'detail':  detail[:300],
            }
        })
    except Exception as e:
        print(f"   Queue update error ({platform}): {e}")


# ── Platform Uploaders ────────────────────────────────────────────────────────

def post_to_youtube(account: dict, video_path: str, title: str,
                    description: str, thumbnail_url: str) -> dict:
    """
    Upload video to YouTube using stored OAuth2 refresh token.
    Requires env secrets: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET.
    Firestore field used: accessToken (refresh token).
    """
    try:
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request

        client_id     = os.environ.get('YOUTUBE_CLIENT_ID', '')
        client_secret = os.environ.get('YOUTUBE_CLIENT_SECRET', '')
        refresh_token = account.get('accessToken', '')

        if not client_id or not client_secret or not refresh_token:
            return {'success': False, 'error': 'Missing YouTube credentials (client_id/secret/refresh_token)'}

        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri='https://oauth2.googleapis.com/token',
            client_id=client_id,
            client_secret=client_secret,
        )
        creds.refresh(Request())

        youtube = build('youtube', 'v3', credentials=creds)

        body = {
            'snippet': {
                'title':           title[:100],
                'description':     description[:5000],
                'tags':            ['Kuwait', 'KWT News', 'Hindi News', 'News'],
                'categoryId':      '25',   # News & Politics
                'defaultLanguage': 'hi',
            },
            'status': {
                'privacyStatus':           'public',
                'selfDeclaredMadeForKids': False,
            },
        }
        media = MediaFileUpload(video_path, mimetype='video/mp4', resumable=True, chunksize=5 * 1024 * 1024)
        request = youtube.videos().insert(part='snippet,status', body=body, media_body=media)

        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                print(f"   YouTube upload: {int(status.progress() * 100)}%")

        video_id = response.get('id', '')
        if video_id:
            return {'success': True, 'postId': video_id,
                    'detail': f'https://youtube.com/watch?v={video_id}'}
        return {'success': False, 'error': 'No video ID returned'}

    except Exception as e:
        print(f"   YouTube post error: {e}")
        return {'success': False, 'error': str(e)[:300]}


def post_to_instagram(account: dict, video_path: str, caption: str,
                       thumbnail_url: str) -> dict:
    """
    Post Reel to Instagram using instagrapi session cookies.
    Firestore field used: cookieData (JSON with session settings).
    """
    try:
        from instagrapi import Client

        cookie_raw = account.get('cookieData', '')
        if not cookie_raw:
            return {'success': False, 'error': 'No Instagram session cookie configured'}

        session_data = cookie_raw
        if isinstance(cookie_raw, str):
            try:
                session_data = json.loads(cookie_raw)
            except Exception:
                # Treat as plain sessionid value
                session_data = {'sessionid': cookie_raw.strip()}

        cl = Client()
        cl.set_settings(session_data)
        cl.delay_range = [1, 3]

        media = cl.clip_upload(video_path, caption=caption[:2200])
        return {
            'success': True,
            'postId':  str(media.pk),
            'detail':  f'https://instagram.com/p/{media.code}',
        }

    except Exception as e:
        print(f"   Instagram post error: {e}")
        return {'success': False, 'error': str(e)[:300]}


def post_to_tiktok(account: dict, video_path: str, title: str) -> dict:
    """
    Post to TikTok via cookie-based session (MVP placeholder).
    TikTok's official Content Posting API requires app approval.
    Cookie-based implementation requires platform-specific HTTP work.
    """
    print("   ⚠️  TikTok posting: cookie-based upload not yet fully implemented.")
    print("       To enable: ensure cookieData is set in Firestore social_accounts/tiktok")
    print("       and implement the TikTok upload flow using the stored cookies.")
    return {'success': False, 'error': 'TikTok upload requires manual implementation per-session'}


def post_to_facebook(account: dict, video_path: str, title: str,
                      description: str) -> dict:
    """
    Upload video to Facebook Page via Graph API.
    Firestore fields used: accessToken (Page Access Token), pageId.
    """
    try:
        token   = account.get('accessToken', '')
        page_id = account.get('pageId', '')

        if not token:
            return {'success': False, 'error': 'No Facebook Page Access Token configured'}
        if not page_id:
            return {'success': False, 'error': 'No Facebook Page ID configured'}

        with open(video_path, 'rb') as f:
            resp = requests.post(
                f'https://graph.facebook.com/{page_id}/videos',
                data={
                    'access_token': token,
                    'title':        title[:255],
                    'description':  description[:1000],
                },
                files={'source': f},
                timeout=180,
            )
        data = resp.json()
        vid_id = data.get('id', '')
        if vid_id:
            return {'success': True, 'postId': vid_id,
                    'detail': f'https://facebook.com/{page_id}/videos/{vid_id}'}
        return {'success': False, 'error': str(data.get('error', data))[:300]}

    except Exception as e:
        print(f"   Facebook post error: {e}")
        return {'success': False, 'error': str(e)[:300]}


def post_to_x(account: dict, video_path: str, title: str) -> dict:
    """
    Post video to X (Twitter) using tweepy.
    Firestore field: accessToken stored as 'API_KEY|API_SECRET|ACCESS|ACCESS_SECRET'.
    """
    try:
        import tweepy

        token_str = account.get('accessToken', '')
        parts = token_str.split('|')
        if len(parts) != 4:
            return {'success': False, 'error': 'X tokens must be stored as KEY|SECRET|ACCESS|ACCESS_SECRET'}

        api_key, api_secret, access_token, access_secret = [p.strip() for p in parts]

        auth = tweepy.OAuth1UserHandler(api_key, api_secret, access_token, access_secret)
        api  = tweepy.API(auth)

        # Upload media (async for video)
        print("   X: uploading video media...")
        media = api.media_upload(
            filename=video_path,
            media_category='tweet_video',
            chunked=True,
        )

        # Wait for video processing
        media_id = media.media_id
        for _ in range(15):
            status = api.get_media_upload_status(media_id)
            state  = status.processing_info.get('state', '')
            if state == 'succeeded':
                break
            if state == 'failed':
                return {'success': False, 'error': 'X video processing failed'}
            time.sleep(5)

        # Post tweet
        client = tweepy.Client(
            consumer_key=api_key,
            consumer_secret=api_secret,
            access_token=access_token,
            access_token_secret=access_secret,
        )
        tweet_text = title[:277] + '...' if len(title) > 277 else title
        tweet = client.create_tweet(text=tweet_text, media_ids=[media_id])
        tweet_id = tweet.data.get('id', '')
        return {
            'success': True,
            'postId':  str(tweet_id),
            'detail':  f'https://x.com/i/web/status/{tweet_id}',
        }

    except Exception as e:
        print(f"   X post error: {e}")
        return {'success': False, 'error': str(e)[:300]}


# ── Main Orchestrator ─────────────────────────────────────────────────────────

PLATFORM_POSTERS = {
    'youtube':   post_to_youtube,
    'instagram': post_to_instagram,
    'tiktok':    post_to_tiktok,
    'facebook':  post_to_facebook,
    'x':         post_to_x,
}


def post_to_all_platforms(
    news_id: str,
    news_title: str,
    video_path: str,
    video_url: str,
    thumbnail_url: str,
    description: str = '',
) -> dict:
    """
    Post the news video to all connected social media platforms.
    Called from main.py after firebase_poster.post_news() succeeds.

    - Checks each platform in Firestore 'social_accounts'
    - Creates a 'social_media_queue' document for tracking
    - Posts sequentially, updates Firestore after each platform
    - Non-fatal: errors on individual platforms don't abort others

    Returns: dict of {platform: result}
    """
    try:
        db = _get_db()
    except Exception as e:
        print(f"   ⚠️  Social poster: could not connect to Firestore: {e}")
        return {}

    # Determine which platforms are connected
    connected = []
    platform_accounts = {}
    for platform in PLATFORM_POSTERS:
        acc = _get_account(platform)
        if acc:
            connected.append(platform)
            platform_accounts[platform] = acc

    if not connected:
        print("   📢 No social accounts connected — skipping social posting.")
        return {}

    print(f"\n📱  Social posting to: {', '.join(connected)}")

    # Create queue tracking document
    queue_id = _create_queue_entry(
        db, news_id, news_title, video_url, thumbnail_url, connected
    )

    all_results = {}
    for platform in connected:
        acc = platform_accounts[platform]
        poster = PLATFORM_POSTERS[platform]
        print(f"\n   Posting to {platform}...")
        try:
            if platform == 'youtube':
                result = poster(acc, video_path, news_title, description, thumbnail_url)
            elif platform == 'instagram':
                result = poster(acc, video_path, description, thumbnail_url)
            elif platform == 'tiktok':
                result = poster(acc, video_path, news_title)
            elif platform == 'facebook':
                result = poster(acc, video_path, news_title, description)
            elif platform == 'x':
                result = poster(acc, video_path, news_title)
            else:
                result = {'success': False, 'error': f'Unknown platform: {platform}'}
        except Exception as e:
            result = {'success': False, 'error': str(e)[:300]}

        all_results[platform] = result
        _update_queue_result(
            db, queue_id, platform,
            result.get('success', False),
            result.get('detail', result.get('error', '')),
            result.get('postId', ''),
        )

        icon = '✅' if result.get('success') else '❌'
        msg  = result.get('detail') or result.get('error') or ''
        print(f"   {icon} {platform}: {msg[:80]}")

    # Mark queue entry complete
    try:
        db.collection('social_media_queue').document(queue_id).update({
            'status':      'completed',
            'processedAt': firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass

    success_count = sum(1 for r in all_results.values() if r.get('success'))
    print(f"\n   📊 Social: {success_count}/{len(connected)} platforms posted")
    return all_results
