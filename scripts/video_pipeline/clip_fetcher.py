"""
Video clip and thumbnail fetcher.
Primary source: Pexels (video)
Fallback: Pixabay (video then image)
"""

import os
import random
import re
import requests
import urllib.request
from pathlib import Path

PEXELS_BASE = 'https://api.pexels.com/videos/search'
PIXABAY_VIDEO_BASE = 'https://pixabay.com/api/videos/'
PIXABAY_IMG_BASE = 'https://pixabay.com/api/'

# Max MB per video clip download
MAX_CLIP_MB = 40
# Preferred video width range
MIN_WIDTH, MAX_WIDTH = 640, 1920


def _pexels_search(keyword: str, per_page: int = 6) -> list:
    """Search Pexels for video clips. Returns list of download URLs."""
    key = os.environ.get('PEXELS_API_KEY', '')
    if not key:
        return []

    try:
        res = requests.get(
            PEXELS_BASE,
            headers={'Authorization': key},
            params={
                'query': keyword,
                'per_page': per_page,
                'orientation': 'landscape',
                'size': 'large',   # Request HD clips (720p/1080p) for better quality
            },
            timeout=20,
        )
        data = res.json()
        urls = []
        for video in data.get('videos', []):
            files = video.get('video_files', [])
            # Pick best file within our width range
            best = None
            for f in sorted(files, key=lambda x: x.get('width', 0), reverse=True):
                w = f.get('width', 0)
                if MIN_WIDTH <= w <= MAX_WIDTH and f.get('link'):
                    best = f['link']
                    break
            if best:
                urls.append(best)
        return urls
    except Exception as e:
        print(f"   Pexels error ({keyword}): {e}")
        return []


def _pixabay_video_search(keyword: str, per_page: int = 5) -> list:
    """Search Pixabay for video clips. Returns list of download URLs."""
    key = os.environ.get('PIXABAY_API_KEY', '')
    if not key:
        return []

    try:
        res = requests.get(
            PIXABAY_VIDEO_BASE,
            params={
                'key': key,
                'q': keyword,
                'per_page': per_page,
                'video_type': 'film',
            },
            timeout=20,
        )
        data = res.json()
        urls = []
        for hit in data.get('hits', []):
            videos = hit.get('videos', {})
            # Prefer medium quality
            for quality in ('medium', 'large', 'small'):
                url = videos.get(quality, {}).get('url', '')
                if url:
                    urls.append(url)
                    break
        return urls
    except Exception as e:
        print(f"   Pixabay video error ({keyword}): {e}")
        return []


def _download_clip(url: str, dest_path: str) -> bool:
    """Download a single video clip. Returns True on success."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as response:
            # Check content-length if available
            content_length = response.headers.get('Content-Length')
            if content_length and int(content_length) > MAX_CLIP_MB * 1024 * 1024:
                print(f"   Skipping clip (too large: {int(content_length)//1024//1024} MB)")
                return False
            data = response.read()
            with open(dest_path, 'wb') as f:
                f.write(data)
        return os.path.getsize(dest_path) > 10_000
    except Exception as e:
        print(f"   Download error: {e}")
        return False


def download_clips(keywords: list, dest_dir: str, max_clips: int = 5) -> list:
    """
    Download video clips for a list of keywords.
    Returns list of local file paths.
    """
    collected_urls = []

    for kw in keywords[:3]:
        # Try Pexels first
        urls = _pexels_search(kw, per_page=4)
        if not urls:
            # Fallback to Pixabay
            urls = _pixabay_video_search(kw, per_page=4)
        collected_urls.extend(urls)
        if len(collected_urls) >= max_clips * 2:
            break

    # Download up to max_clips
    clip_paths = []
    seen = set()
    for i, url in enumerate(collected_urls):
        if len(clip_paths) >= max_clips:
            break
        if url in seen:
            continue
        seen.add(url)

        ext = '.mp4' if '.mp4' in url.lower() else '.mp4'
        dest = os.path.join(dest_dir, f'clip_{i:02d}{ext}')
        print(f"   Downloading clip {i+1}: {url[:60]}...")
        if _download_clip(url, dest):
            clip_paths.append(dest)

    print(f"   Downloaded {len(clip_paths)}/{max_clips} clips")
    return clip_paths


def get_pixabay_image(keyword: str, used_urls: set = None) -> str:
    """
    Get a news-relevant Pixabay image URL for use as thumbnail.
    Tries multiple keyword variations to avoid unrelated images.
    Pass used_urls (set of already-used Pixabay URLs) to avoid duplicate thumbnails.
    """
    key = os.environ.get('PIXABAY_API_KEY', '')
    if not key:
        return f"https://placehold.co/1280x720/1a2d4a/e8edf5?text=News"

    # Build a list of keyword variations to try, from most specific to most generic
    words = keyword.strip().split()
    candidates = [keyword]
    if len(words) > 2:
        candidates.append(' '.join(words[:2]))  # first 2 words
    if len(words) > 1:
        candidates.append(words[0])             # first word only
    # Always try topic + "news" as final attempt before giving up
    candidates.append(f"{words[0]} news" if words else 'news')

    # Categories that often cause wrong images — add "news" to force editorial results
    _NEWS_BOOST = ['cat','dog','puppy','kitten','baby','food','flower','animal']
    base = keyword.lower()
    needs_boost = any(w in base for w in _NEWS_BOOST)

    for q in candidates:
        if needs_boost:
            q = q + ' news'
        try:
            res = requests.get(
                PIXABAY_IMG_BASE,
                params={
                    'key': key,
                    'q': q[:80],
                    'image_type': 'photo',
                    'safesearch': 'true',
                    'orientation': 'horizontal',
                    'min_width': 800,
                    'per_page': 10,
                    'order': 'popular',
                    'editors_choice': 'false',
                    # Vary the page so we don't get the exact same image every run
                    'page': random.randint(1, 3),
                },
                timeout=15,
            )
            data = res.json()
            hits = data.get('hits', [])
            if hits:
                # Filter out already-used URLs to avoid duplicate thumbnails
                available = [
                    h for h in hits
                    if h.get('largeImageURL', '') not in (used_urls or set())
                       and h.get('webformatURL', '') not in (used_urls or set())
                ] or hits  # fallback: ignore exclusion if all results are used
                pick = random.randint(0, min(2, len(available) - 1))
                url = available[pick].get('largeImageURL') or available[pick].get('webformatURL', '')
                if url:
                    print(f"   Thumbnail: '{q}' → found (hit #{pick+1})")
                    return url
        except Exception as e:
            print(f"   Pixabay image error ({q}): {e}")
            continue

    # Final fallback: dark news-styled placeholder
    label = keyword.replace(' ', '+')[:30]
    return f"https://placehold.co/1280x720/0f2a45/60a5fa?text=KWT+News"
