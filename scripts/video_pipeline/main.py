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
    post_news,
    write_automation_log,
    get_automation_config,
    update_automation_config,
)


def _banner(msg: str) -> None:
    print(f"\n{'─'*55}")
    print(f"  {msg}")
    print(f"{'─'*55}")


def run(category: str) -> bool:
    """
    Execute the full pipeline for the given category.
    Returns True if a news article was posted, False if skipped.
    """
    cfg = CATEGORIES.get(category)
    if not cfg:
        print(f"❌  Unknown category: {category}")
        sys.exit(1)

    _banner(f"KWT News Auto Pipeline  |  {cfg['label']}")

    # ── 1. Automation enabled? ───────────────────────────────────────────────
    auto_cfg = get_automation_config(category)
    if not auto_cfg.get('enabled', True):
        print("⏸️   Automation disabled for this category — skipping.")
        write_automation_log(category, 'skipped', reason='automation disabled')
        return False

    # ── 1b. Anti-rapid-fire: skip if we posted this category in the last 25 min ─
    # This prevents parallel runs (e.g. news-watcher + run-all) from posting
    # the same article twice within minutes of each other.
    try:
        recent_same_cat = get_recent_news(category, days=1)
        if recent_same_cat:
            from datetime import datetime, timezone, timedelta
            last_post_ts = recent_same_cat[0].get('timestamp')
            if last_post_ts:
                if hasattr(last_post_ts, 'ToDatetime'):
                    last_post_ts = last_post_ts.ToDatetime()
                elif hasattr(last_post_ts, 'toDatetime'):
                    last_post_ts = last_post_ts.toDatetime()
                if last_post_ts.tzinfo is None:
                    last_post_ts = last_post_ts.replace(tzinfo=timezone.utc)
                age_min = (datetime.now(timezone.utc) - last_post_ts).total_seconds() / 60
                if age_min < 25:
                    print(f"⏱️   Last post was {age_min:.0f} min ago — skipping to prevent rapid duplicate.")
                    write_automation_log(category, 'skipped', reason=f'posted {age_min:.0f}min ago (anti-rapid-fire)')
                    return False
    except Exception as e:
        print(f"   Anti-rapid-fire check skipped: {e}")

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
        dup = check_duplicate(news_item['title'], all_recent, threshold=0.40)
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

        # ── 7. Thumbnail from Pixabay ────────────────────────────────────────
        print("\n🖼️   Step 6 — Getting thumbnail...")
        thumb_keyword = script_data.get('image_keyword') or cfg['search_keyword']
        pixabay_url = get_pixabay_image(thumb_keyword)
        thumbnail_url = upload_image_from_url(pixabay_url)
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
        )

        # ── 9. Upload to Cloudinary ──────────────────────────────────────────
        print("\n☁️   Step 8 — Uploading to Cloudinary...")
        video_url = upload_video(video_path)
        if not video_url:
            raise RuntimeError("Cloudinary video upload failed after all retries")

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
            'title':      script_data['title'],
            'summary':    script_data.get('summary', ''),
            'content':    content,
            'videoUrl':   video_url,
            'thumbnail':  thumbnail_url,
            'imageUrl':   thumbnail_url,
            'category':   category,
            'source':     source_name,
            'sourceLogo': source_logo or '',
            'readTime':   f"{max(1, len(script_data['script'].split()) // 130)} min read",
            'isBreaking': False,
            # Use 'article' so the news feed query includes it.
            # videoUrl field still holds the video — app can play it.
            'mediaType':  'article',
        }

        news_id = post_news(article)
        print(f"      ✅ Posted!  ID: {news_id}")

        # ── 12. Update config + log ──────────────────────────────────────────
        update_automation_config(category, {
            'lastStatus':  'posted',
            'lastNewsId':  news_id,
        })
        write_automation_log(category, 'posted', news_id=news_id, reason='posted successfully')

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
        posted = run(args.category)
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


if __name__ == '__main__':
    main()
