"""
RSS feed fetcher — returns the most recent, unique news item from category feeds.
"""

import feedparser
import re
import time

# Minimum summary length to consider a feed entry valid
MIN_SUMMARY_LEN = 30


def _clean_html(text: str) -> str:
    """Strip HTML tags from text."""
    return re.sub(r'<[^>]+>', ' ', text or '').strip()


def _entry_to_item(entry, source_name: str) -> dict:
    """Convert a feedparser entry to a standardised news item dict."""
    title = _clean_html(entry.get('title', ''))
    summary = _clean_html(
        entry.get('summary', '') or entry.get('description', '')
    )
    link = entry.get('link', '')
    published = entry.get('published', '') or entry.get('updated', '')

    return {
        'title': title,
        'summary': summary[:500],
        'link': link,
        'published': published,
        'source': source_name,
    }


def _source_name_from_url(url: str) -> str:
    """Derive a readable source name from a feed URL."""
    match = re.search(r'https?://(?:www\.)?([^/]+)', url)
    if match:
        domain = match.group(1)
        # Strip common TLDs
        name = re.sub(r'\.(com|net|org|kw|ae|sa|qa)$', '', domain)
        return name.replace('-', ' ').replace('.', ' ').title()
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
            feed = feedparser.parse(feed_url)
            entries = feed.entries

            if not entries:
                continue

            source_name = (
                feed.feed.get('title', '') or _source_name_from_url(feed_url)
            )

            for entry in entries[:5]:   # Check top 5 entries
                item = _entry_to_item(entry, source_name)
                if item['title'] and len(item['summary']) >= MIN_SUMMARY_LEN:
                    print(f"   RSS source: {source_name}")
                    return item

        except Exception as e:
            print(f"   RSS error ({feed_url}): {e}")
            continue

    return None
