#!/usr/bin/env python3
"""
KWT News Automated Video Pipeline
===================================
Flow: RSS feed → Gemini script → Edge-TTS audio → Pexels/Pixabay clips
      → MoviePy video edit → Cloudinary upload → Firebase post

Usage:
    python main.py --category=kuwait
    python main.py --category=world
    python main.py --category=kuwait-jobs
    python main.py --category=kuwait-offers
    python main.py --category=funny-news-meme
"""

import argparse
import os
import sys
import tempfile
import traceback
from pathlib import Path

from config import CATEGORIES
from rss_fetcher import get_latest_news
from gemini_script import generate_script
from tts import generate_tts
from clip_fetcher import download_clips, get_pixabay_image
from video_editor import create_video
from uploader import upload_video, upload_image_from_url
from firebase_poster import (
    get_recent_news,
    get_all_recent_news,
    check_duplicate,
    get_source_logo,
    get_used_thumbnail_urls,
    post_news,
    write_automation_log,
    get_automation_config,
    update_automation_config,
    acquire_pipeline_lock,
    release_pipeline_lock,
)


def _banner(msg: str) -> None:
    print(f"\n{'─'*55}")
    print(f"  {msg}")
    print(f"{'─'*55}")


def run(category: str, breaking_only: bool = False) -> bool:
    """
    Execute the full pipeline for the given category.
    breaking_only=True: only post if Gemini marks isBreaking=True.
    Returns True if a news article was posted, False if skipped.
    """
    cfg = CATEGORIES.get(category)
    if not cfg:
        print(f"❌  Unknown category: {category}")
        sys.exit(1)

    _banner(f"KWT News Auto Pipeline  |  {cfg['label']}")

    # Validate required environment variables before starting pipeline
    required_secrets = {
        'FIREBASE_SERVICE_ACCOUNT': 'Firebase admin credentials',
        'GEMINI_API_KEY': 'Gemini AI API key',
        'PEXELS_API_KEY': 'Pexels video search API key',
        'PIXABAY_API_KEY': 'Pixabay image/video search API key',
    }
    missing = [k for k, v in required_secrets.items() if not os.environ.get(k)]
    if missing:
        print(f"❌  Missing required secrets: {', '.join(missing)}")
        print(f"    Configure these in GitHub repo → Settings → Secrets → Actions")
        sys.exit(1)

    # ── 1. Automation enabled? ───────────────────────────────────────────────
    auto_cfg = get_automation_config(category)
    if not auto_cfg.get('enabled', True):
        print("⏸️   Automation disabled for this category — skipping.")
        write_automation_log(category, 'skipped', reason='automation disabled')
        return False

    # ── 1c. Pipeline lock (prevent parallel duplicate posts) ─────────────────
    if not acquire_pipeline_lock(category, ttl_seconds=600):
        print(f"🔒  Pipeline lock held by another run for '{category}' — skipping.")
        write_automation_log(category, 'skipped', reason='pipeline lock held by another run')
        return False

    # ── 1b. Anti-rapid-fire: skip if we posted this category in the last 15 min ─
    # This prevents parallel runs (e.g. news-watcher + run-all) from posting
    # the same article twice within minutes of each other.
    # Fail-CLOSED: if the check itself errors (missing index, network, etc.),
    # we skip this run rather than risk a duplicate. Next scheduled run recovers.
    try:
        recent_same_cat = get_recent_news(category, days=1)
        if recent_same_cat:
            from datetime import datetime, timezone
            last_post_ts = recent_same_cat[0].get('timestamp')
            if last_post_ts:
                if hasattr(last_post_ts, 'ToDatetime'):
                    last_post_ts = last_post_ts.ToDatetime()
                elif hasattr(last_post_ts, 'toDatetime'):
                    last_post_ts = last_post_ts.toDatetime()
                if last_post_ts.tzinfo is None:
                    last_post_ts = last_post_ts.replace(tzinfo=timezone.utc)
                age_min = (datetime.now(timezone.utc) - last_post_ts).total_seconds() / 60
                if age_min < 15:
                    print(f"⏱️   Last post was {age_min:.0f} min ago — skipping to prevent rapid duplicate.")
                    write_automation_log(category, 'skipped', reason=f'posted {age_min:.0f}min ago (anti-rapid-fire)')
                    release_pipeline_lock(category)
                    return False
    except Exception as e:
        print(f"   ❌ Anti-rapid-fire check failed — skipping run to avoid duplicate risk: {e}")
        write_automation_log(category, 'skipped', reason=f'anti-rapid-fire check failed: {str(e)[:120]}')
        release_pipeline_lock(category)
        return False

    # ── 2. Fetch latest news from RSS ────────────────────────────────────────
    print("\n📡  Step 1 — Fetching RSS...")
    news_item = get_latest_news(
        cfg['rss_feeds'],
        filter_keywords=cfg.get('filter_keywords', []),
    )

    if news_item:
        print(f"      Found: {news_item['title'][:70]}")
    else:
        print("      No RSS result — Gemini will search for news directly.")

    # ── 3. Duplicate check (cross-category, last 3 days) ────────────────────
    if news_item:
        print("\n🔍  Step 2 — Duplicate check (all categories, last 3 days)...")
        all_recent = get_all_recent_news(days=3)
        dup = check_duplicate(news_item['title'], all_recent, threshold=0.55)
        if dup['is_duplicate']:
            print(f"      Duplicate ({dup['score']:.2f}): {dup['matched_title'][:60]}")
            write_automation_log(
                category, 'skipped',
                reason=f"duplicate of: {dup['matched_title'][:80]}"
            )
            return False
        print(f"      ✅ Not a duplicate (checked {len(all_recent)} recent articles across all categories)")

    # ── 4. Generate script (AI + fallback) ──────────────────────────────────────
    print("\n🤖  Step 3 — Generating script (Gemini AI → RSS fallback)...")
    script_data = generate_script(news_item, category, cfg)

    if not script_data or script_data.get('skip'):
        print("      No news found from any source — skipping this run.")
        write_automation_log(category, 'skipped', reason='no news from RSS or AI')
        return False

    # ── 4b. Breaking-only mode filter ───────────────────────────────────────
    is_breaking = bool(script_data.get('isBreaking', False))
    if breaking_only and not is_breaking:
        print(f"⏭️   Breaking-only mode: news is not breaking — skipping.")
        write_automation_log(category, 'skipped', reason='breaking-only mode: not a breaking event')
        return False
    if is_breaking:
        print(f"⚡  Gemini marked this as BREAKING NEWS")

    words = len(script_data['script'].split())
    print(f"      Title: {script_data['title'][:60]}")
    print(f"      Script ({words} words): {script_data['script'][:70]}...")

    # ── Work inside a temp directory ─────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # ── 5. Edge-TTS audio ────────────────────────────────────────────────
        print("\n🎙️   Step 4 — Generating TTS audio (Edge-TTS)...")
        audio_path = str(tmpdir / 'audio.mp3')
        word_timings = generate_tts(
            script_data['script'],
            audio_path,
            voice=cfg.get('voice', 'en-US-GuyNeural'),
        )

        # ── 6. Download video clips ──────────────────────────────────────────
        print("\n🎬  Step 5 — Downloading video clips (Pexels / Pixabay)...")
        clips_dir = tmpdir / 'clips'
        clips_dir.mkdir()
        clip_paths = download_clips(
            keywords=script_data.get('keywords', [cfg['search_keyword']]),
            dest_dir=str(clips_dir),
            max_clips=5,
        )
        if not clip_paths:
            print("   ⚠️  No video clips downloaded — video will use black background (continuing...)")

        # ── 7. Thumbnail from Pixabay ────────────────────────────────────────
        print("\n🖼️   Step 6 — Getting thumbnail...")
        thumb_keyword = script_data.get('image_keyword') or cfg['search_keyword']
        used_thumb_urls = get_used_thumbnail_urls(days=30)
        pixabay_url = get_pixabay_image(thumb_keyword, used_urls=used_thumb_urls)
        thumb_upload = upload_image_from_url(pixabay_url)
        thumbnail_url = thumb_upload['url']
        thumbnail_public_id = thumb_upload.get('public_id', '')
        print(f"      Thumbnail: {thumbnail_url[:70]}")

        # ── 8. Assemble video ────────────────────────────────────────────────
        print("\n✂️   Step 7 — Assembling video (MoviePy)...")
        source_name = script_data.get('source') or (
            news_item['source'] if news_item else 'KWT News'
        )
        video_path = str(tmpdir / 'news_video.mp4')
        create_video(
            clip_paths=clip_paths,
            audio_path=audio_path,
            word_timings=word_timings,
            output_path=video_path,
            source_name=source_name,
            category_label=cfg['label'],
            category_color=cfg['color'],
            title=script_data['title'],
        )

        # ── 9. Upload to Cloudinary ──────────────────────────────────────────
        print("\n☁️   Step 8 — Uploading to Cloudinary...")
        video_upload = upload_video(video_path)
        if not video_upload:
            raise RuntimeError("Cloudinary video upload failed after all retries")
        video_url = video_upload['url']
        video_public_id = video_upload.get('public_id', '')

        # ── 10. Source logo ──────────────────────────────────────────────────
        print("\n🏷️   Step 9 — Looking up source logo (Firestore logos)...")
        source_logo = get_source_logo(source_name)
        print(f"      Source: {source_name} | Logo: {'✅ found' if source_logo else '— not found'}")

        # ── 11. Build article & post ─────────────────────────────────────────
        print("\n📤  Step 10 — Posting to Firebase...")

        content = script_data.get('content', '') or script_data.get('summary', '')

        # Append special links for Jobs / Offers categories
        if category == 'kuwait-jobs' and script_data.get('apply_link'):
            content += f"\n\n🔗 **Apply Here:** {script_data['apply_link']}"
        if category == 'kuwait-offers' and script_data.get('buy_link'):
            content += f"\n\n🛒 **Buy / View Offer:** {script_data['buy_link']}"

        article = {
            'title':          script_data['title'],
            'summary':        script_data.get('summary', ''),
            'content':        content,
            'videoUrl':       video_url,
            'videoPublicId':  video_public_id,
            'thumbnail':      thumbnail_url,
            'imageUrl':       thumbnail_url,
            'imagePublicId':  thumbnail_public_id,
            'category':       category,
            'source':         source_name,
            'sourceLogo':     source_logo or '',
            'readTime':       f"{max(1, len(script_data['script'].split()) // 130)} min read",
            'isBreaking':     is_breaking,
            # Use 'article' so the news feed query includes it.
            # videoUrl field still holds the video — app can play it.
            'mediaType':      'article',
        }

        news_id = post_news(article)
        print(f"      ✅ Posted!  ID: {news_id}")

        # ── 12. Update config + log ──────────────────────────────────────────
        update_automation_config(category, {
            'lastStatus':  'posted',
            'lastNewsId':  news_id,
        })
        write_automation_log(category, 'posted', news_id=news_id, reason='posted successfully')

        # ── 13. Social media posting ─────────────────────────────────────────
        print("\n📱  Step 11 — Posting to social media (non-fatal)...")
        social_results = {}
        social_status = 'skipped'
        try:
            from social_poster import post_to_all_platforms
            social_results = post_to_all_platforms(
                news_id=news_id,
                news_title=script_data['title'],
                video_path=video_path,
                video_url=video_url,
                thumbnail_url=thumbnail_url,
                description=content[:1000],
            )
            if social_results is None:
                social_results = {}
            if social_results:
                successes = [r for r in social_results.values() if isinstance(r, dict) and r.get('success')]
                if len(successes) == len(social_results):
                    social_status = 'done'
                elif successes:
                    social_status = 'partial'
                else:
                    social_status = 'failed'
        except Exception as e:
            print(f"   ⚠️  Social posting error (non-fatal): {e}")
            import traceback
            traceback.print_exc()
            social_status = 'failed'
            social_results = {'error': str(e)[:300]}

        # Persist social-posting outcome back onto the news doc so admin UI can show it.
        try:
            from firebase_poster import _get_db
            from firebase_admin import firestore as _fs
            _get_db().collection('news').document(news_id).update({
                'socialPostStatus': social_status,
                'socialPostedAt':   _fs.SERVER_TIMESTAMP,
                'socialResults':    social_results,
            })
        except Exception as e:
            print(f"   ⚠️  Failed to update socialPostStatus on news doc: {e}")

    # Release pipeline lock so next scheduled run can proceed
    release_pipeline_lock(category)

    _banner(f"✅  Pipeline complete — {cfg['label']}")
    return True


def main():
    parser = argparse.ArgumentParser(description='KWT News Automated Video Pipeline')
    parser.add_argument(
        '--category',
        required=True,
        choices=list(CATEGORIES.keys()),
        help='News category to process',
    )
    parser.add_argument(
        '--breaking-only',
        action='store_true',
        default=False,
        help='Breaking news watcher mode: only post if truly high-importance news found',
    )
    args = parser.parse_args()

    # In breaking-only mode, use a shorter duplicate window (6 hours instead of 3 days)
    # and only post if something genuinely new is happening
    if args.breaking_only:
        print("🚨  BREAKING NEWS WATCHER MODE — only high-importance events will be posted")

    try:
        posted = run(args.category, breaking_only=args.breaking_only)
        sys.exit(0)

    except Exception as exc:
        print(f"\n❌  Pipeline crashed: {exc}")
        traceback.print_exc()
        try:
            write_automation_log(args.category, 'error', reason=str(exc)[:300])
            update_automation_config(args.category, {'lastStatus': 'error'})
        except Exception:
            pass
        sys.exit(1)

    finally:
        # Always release the pipeline lock, even on crash, so the next scheduled
        # run isn't blocked until the TTL (600s) expires.
        try:
            release_pipeline_lock(args.category)
        except Exception:
            pass


if __name__ == '__main__':
    main()
