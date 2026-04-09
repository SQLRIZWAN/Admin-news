"""
RSS feed fetcher — returns the most recent, category-relevant news item.
Uses requests for proper timeout + browser User-Agent (many feeds block feedparser's UA).
Filters entries by category keywords so Kuwait-Jobs doesn't return BBC Business finance news.
"""

import re
import feedparser
import requests

# Minimum summary length to consider a feed entry valid
MIN_SUMMARY_LEN = 30

# Browser-like headers so feeds don't block the bot
_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
}


def _fetch_feed(url: str) -> feedparser.FeedParserDict:
    """Download feed content with browser headers and timeout, then parse."""
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=12, allow_redirects=True)
        if resp.status_code == 200 and resp.content:
            return feedparser.parse(resp.content)
    except Exception:
        pass
    # Fallback: let feedparser try directly
    try:
        return feedparser.parse(url)
    except Exception:
        return feedparser.FeedParserDict()


def _clean_html(text: str) -> str:
    """Strip HTML tags from text."""
    return re.sub(r'<[^>]+>', ' ', text or '').strip()


def _entry_to_item(entry, source_name: str) -> dict:
    """Convert a feedparser entry to a standardised news item dict."""
    title = _clean_html(entry.get('title', ''))
    summary = _clean_html(
        entry.get('summary', '') or entry.get('description', '') or entry.get('content', [{}])[0].get('value', '')
    )
    link = entry.get('link', '')
    published = entry.get('published', '') or entry.get('updated', '')

    return {
        'title': title,
        'summary': summary[:600],
        'link': link,
        'published': published,
        'source': source_name,
    }


def _source_name_from_url(url: str) -> str:
    """Derive a readable source name from a feed URL."""
    match = re.search(r'https?://(?:www\.)?([^/]+)', url)
    if match:
        domain = match.group(1)
        name = re.sub(r'\.(com|net|org|kw|ae|sa|qa|co|uk)$', '', domain)
        name = re.sub(r'\.', ' ', name)
        return name.replace('-', ' ').title()
    return 'KWT News'


def _matches_keywords(item: dict, keywords: list) -> bool:
    """Return True if item title or summary contains at least one keyword."""
    if not keywords:
        return True  # No filter — accept everything
    text = (item['title'] + ' ' + item['summary']).lower()
    return any(kw.lower() in text for kw in keywords)


def get_latest_news(rss_feeds: list, filter_keywords: list = None) -> dict | None:
    """
    Fetch RSS feeds in order and return the first relevant, recent news item.

    filter_keywords: list of words that must appear in title or summary.
    If no entry matches the keywords, falls back to the first valid entry
    (so the pipeline still runs and lets Gemini enrich it appropriately).

    Returns None if no feeds are available or all fail.
    """
    if not rss_feeds:
        return None

    filter_keywords = filter_keywords or []
    best_unfiltered = None  # Fallback if nothing matches keywords

    for feed_url in rss_feeds:
        try:
            feed = _fetch_feed(feed_url)
            entries = feed.get('entries', [])

            if not entries:
                print(f"   RSS empty: {feed_url[:60]}")
                continue

            source_name = (
                feed.get('feed', {}).get('title', '') or _source_name_from_url(feed_url)
            )

            for entry in entries[:10]:   # Check top 10 entries
                item = _entry_to_item(entry, source_name)
                if not item['title'] or len(item['summary']) < MIN_SUMMARY_LEN:
                    continue

                if _matches_keywords(item, filter_keywords):
                    print(f"   ✅ RSS match: {source_name} — {item['title'][:60]}")
                    return item

                # Save first valid entry as fallback even if no keyword match
                if best_unfiltered is None:
                    best_unfiltered = item

        except Exception as e:
            print(f"   RSS error ({feed_url[:50]}): {e}")
            continue

    # When category keywords were specified but NOTHING matched:
    # Return None so Gemini generates the correct category content from scratch.
    # Returning a wrong-category RSS article causes duplicate cross-category news
    # (e.g., both Kuwait-Jobs and Kuwait-Offers get the same BBC Business article).
    if filter_keywords:
        print(f"   ⚠️  No category-matching RSS entry — Gemini will generate from scratch")
        return None

    # No filter specified — use first valid entry as context
    if best_unfiltered:
        print(f"   ⚠️  No usable RSS entry — using first valid: {best_unfiltered['title'][:60]}")
        return best_unfiltered

    print("   ⚠️  All RSS feeds returned no usable items")
    return None
