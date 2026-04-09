"""
AI script generator for KWT News video pipeline.

Priority order:
  1. Gemini AI  — enriched script with Google Search grounding (best quality)
  2. RSS Fallback — script built directly from RSS article   (always works)
  3. Skip        — only if no RSS article AND Gemini unavailable

This means: as long as RSS has a news item, a video WILL be produced.
"""

import os
import re
import json
import time
import textwrap
import requests

GEMINI_BASE = 'https://generativelanguage.googleapis.com/'
MODELS = [
    {'m': 'gemini-2.5-flash',               'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.5-flash-preview-05-20', 'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.0-flash',               'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.0-flash-lite',          'v': 'v1beta', 'search': True},
    {'m': 'gemini-1.5-flash-latest',        'v': 'v1beta', 'search': False},
]

# Any of these in the error message = soft retry (try next model)
_RETRYABLE = (
    'quota', 'rate', 'limit', 'high demand', 'overloaded',
    'try again', 'temporarily', 'unavailable', 'capacity',
    'resource exhausted', 'service unavailable', 'internal',
)


def _is_retryable(msg: str, code: int) -> bool:
    return code in (429, 500, 503) or any(w in msg.lower() for w in _RETRYABLE)


# ── RSS Fallback ─────────────────────────────────────────────────────────────

def _rss_fallback_script(news_item: dict, category: str, cfg: dict) -> dict:
    """
    Build a complete script dict from the RSS article — no AI needed.
    Produces a natural 55-65 word spoken narration from title + summary.
    """
    title   = news_item['title'].strip()
    summary = (news_item.get('summary') or title).strip()
    source  = news_item.get('source') or 'KWT News'
    keyword = cfg['search_keyword']

    # Build spoken script: title intro + trimmed summary, target ~60 words
    intro   = f"Here's the latest from {source}. {title}."
    body    = ' '.join(summary.split())          # collapse whitespace
    combined = f"{intro} {body}"
    words   = combined.split()

    if len(words) > 65:
        script = ' '.join(words[:62]) + '.'
    elif len(words) < 30:
        # Pad with a closing line
        script = combined + f" Stay tuned to KWT News for more updates."
    else:
        script = combined

    # Build subtitle lines (≈5 words each)
    all_words = script.split()
    subtitle_lines = [
        ' '.join(all_words[i:i+5])
        for i in range(0, min(len(all_words), 30), 5)
    ]

    # Short content block (repeat summary, good enough for article body)
    content = f"{title}\n\n{summary}\n\nSource: {source}"

    print(f"   ℹ️  Using RSS fallback script ({len(script.split())} words)")
    return {
        'title':          title,
        'summary':        summary[:300],
        'content':        content,
        'script':         script,
        'keywords':       [keyword, 'news', 'breaking news'],
        'subtitle_lines': subtitle_lines,
        'image_keyword':  keyword,
        'source':         source,
        'apply_link':     '',
        'buy_link':       '',
        'skip':           False,
    }


# ── Gemini caller ─────────────────────────────────────────────────────────────

def _call_gemini(prompt: str) -> str | None:
    """
    Try each Gemini model in order.
    Returns response text, or None if all models are unavailable.
    Raises only on hard errors (bad API key, malformed request).
    """
    key = os.environ.get('GEMINI_API_KEY', '')
    if not key:
        print("   ⚠️  GEMINI_API_KEY not set — skipping AI enrichment")
        return None

    for i, cfg in enumerate(MODELS):
        body = {
            'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
            'generationConfig': {'temperature': 0.65, 'maxOutputTokens': 4096},
        }
        if cfg['search']:
            body['tools'] = [{'google_search': {}}]

        try:
            res = requests.post(
                f"{GEMINI_BASE}{cfg['v']}/models/{cfg['m']}:generateContent?key={key}",
                json=body,
                timeout=90,
            )

            if res.status_code in (429, 500, 503):
                print(f"   Model {cfg['m']} HTTP {res.status_code} — trying next...")
                if i < len(MODELS) - 1:
                    time.sleep(3)
                continue

            data = res.json()

            if 'error' in data:
                msg  = data['error'].get('message', '')
                code = data['error'].get('code', 0)
                if _is_retryable(msg, code):
                    print(f"   Model {cfg['m']}: {msg[:70]} — trying next...")
                    if i < len(MODELS) - 1:
                        time.sleep(3)
                    continue
                # Hard error — don't waste time on other models
                print(f"   ❌ Gemini hard error [{code}]: {msg[:100]}")
                return None

            text = (
                data.get('candidates', [{}])[0]
                    .get('content', {})
                    .get('parts', [{}])[0]
                    .get('text', '')
            )
            if text:
                print(f"   ✅ Gemini model: {cfg['m']}")
                return text

        except requests.exceptions.Timeout:
            print(f"   Model {cfg['m']} timeout — trying next...")
            continue
        except Exception as e:
            if _is_retryable(str(e), 0):
                print(f"   Model {cfg['m']} error ({e}) — trying next...")
                continue
            print(f"   ❌ Unexpected Gemini error: {e}")
            return None

    print("   ⚠️  All Gemini models unavailable")
    return None


# ── JSON parser ───────────────────────────────────────────────────────────────

def _parse_json(text: str) -> dict | None:
    if not text:
        return None
    try:
        return json.loads(text.strip())
    except Exception:
        pass
    stripped = re.sub(r'```(?:json)?\s*', '', text, flags=re.IGNORECASE).replace('```', '').strip()
    try:
        return json.loads(stripped)
    except Exception:
        pass
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    return None


# ── Public entry point ────────────────────────────────────────────────────────

def generate_script(news_item: dict | None, category: str, cfg: dict) -> dict | None:
    """
    Generate a 30-second video script + metadata.

    Flow:
      1. Try Gemini AI (with Google Search grounding)
      2. If Gemini unavailable AND news_item exists → RSS fallback
      3. If both fail / no source → return {'skip': True}

    Returns dict with: title, summary, content, script, keywords,
                       subtitle_lines, image_keyword, source,
                       apply_link, buy_link, skip
    """
    # ── Build Gemini prompt ───────────────────────────────────────
    if news_item:
        news_context      = (
            f"Title: {news_item['title']}\n"
            f"Summary: {news_item['summary']}\n"
            f"Source: {news_item['source']}\n"
            f"Link: {news_item.get('link', '')}"
        )
        search_instruction = "Use the provided news context AND Google Search to verify and enrich the article."
    else:
        news_context       = f"No RSS article provided. {cfg['gemini_focus']}"
        search_instruction = "Use Google Search to find the most recent relevant news."

    extra_fields = ''
    if category == 'kuwait-jobs':
        extra_fields = '"apply_link": "direct job application URL or empty string",'
    elif category == 'kuwait-offers':
        extra_fields = '"buy_link": "direct product/offer URL or empty string",'

    prompt = f"""You are a professional news video script writer for KWT News, a Kuwait-based news channel.

{search_instruction}

NEWS CONTEXT:
{news_context}

CATEGORY FOCUS: {cfg['gemini_focus']}

TASK: Write a complete 30-second news video script.

RULES:
1. Only use REAL, VERIFIED news. Do NOT fabricate anything.
2. If no relevant real news found, return {{"skip": true}}.
3. The "script" field: 55-65 words (comfortable 30-second speaking pace).
4. Keywords: specific and visual (for finding stock video clips).
5. Subtitle lines: 4-6 words each for on-screen display.

Return ONLY valid JSON:
{{
  "title": "Clear engaging headline",
  "summary": "2-3 sentence summary",
  "content": "Full article body (300-500 words, journalistic style)",
  "script": "30-second spoken narration (55-65 words)",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "subtitle_lines": ["Line one", "Line two", "Line three", "Line four"],
  "image_keyword": "single best thumbnail keyword",
  "source": "Publication name",
  {extra_fields}
  "skip": false
}}"""

    # ── Try Gemini ────────────────────────────────────────────────
    try:
        raw  = _call_gemini(prompt)
        data = _parse_json(raw) if raw else None

        if data and not data.get('skip'):
            # Fill any missing fields
            data.setdefault('title',          news_item['title']   if news_item else 'News Update')
            data.setdefault('summary',        news_item.get('summary', '') if news_item else '')
            data.setdefault('content',        data.get('summary', ''))
            data.setdefault('script',         data.get('summary', '')[:300])
            data.setdefault('keywords',       [cfg['search_keyword']])
            data.setdefault('subtitle_lines', [])
            data.setdefault('image_keyword',  cfg['search_keyword'])
            data.setdefault('source',         news_item['source']  if news_item else 'KWT News')
            data.setdefault('apply_link',     '')
            data.setdefault('buy_link',       '')
            data['skip'] = False
            return data

        if data and data.get('skip'):
            # Gemini said "no news found" — if RSS gave us something, still post it
            if news_item:
                print("   ℹ️  Gemini returned skip but RSS article exists — using fallback")
                return _rss_fallback_script(news_item, category, cfg)
            return {'skip': True}

    except Exception as e:
        print(f"   ❌ Gemini call failed: {e}")

    # ── Gemini unavailable — try RSS fallback ─────────────────────
    if news_item:
        return _rss_fallback_script(news_item, category, cfg)

    # ── No RSS, no AI — nothing to post ──────────────────────────
    print("   ⏭️  No RSS article and AI unavailable — skipping this run")
    return {'skip': True}
