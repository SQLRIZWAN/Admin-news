"""
RSS feed fetcher — returns the most recent, unique news item from category feeds.
Uses requests for proper timeout + browser User-Agent (many feeds block feedparser's UA).
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


def get_latest_news(rss_feeds: list) -> dict | None:
    """
    Fetch RSS feeds in order and return the first valid, recent news item.
    Returns None if no feeds are available or all fail.
    """
    if not rss_feeds:
        return None

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

            for entry in entries[:8]:   # Check top 8 entries
                item = _entry_to_item(entry, source_name)
                if item['title'] and len(item['summary']) >= MIN_SUMMARY_LEN:
                    print(f"   ✅ RSS: {source_name} — {item['title'][:60]}")
                    return item

        except Exception as e:
            print(f"   RSS error ({feed_url[:50]}): {e}")
            continue

    print("   ⚠️  All RSS feeds returned no usable items")
    return None
