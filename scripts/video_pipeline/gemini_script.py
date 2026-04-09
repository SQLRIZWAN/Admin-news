"""
AI script generator for KWT News video pipeline.

Priority order:
  1. Gemini AI  — enriched Hindi script with Google Search grounding (best quality)
  2. RSS Fallback — Hindi script built via a short Gemini translation call
  3. English Fallback — plain English if all AI calls fail but RSS exists
  4. Skip        — only if no RSS article AND Gemini fully unavailable
"""

import os
import re
import json
import time
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


# ── Gemini caller ─────────────────────────────────────────────────────────────

def _call_gemini(prompt: str, use_search: bool = True) -> str | None:
    """
    Try each Gemini model in order.
    Returns response text, or None if all models are unavailable.
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
        if cfg['search'] and use_search:
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


# ── RSS Hindi Fallback ────────────────────────────────────────────────────────

def _rss_fallback_script(news_item: dict, category: str, cfg: dict) -> dict:
    """
    Build a Hindi script from the RSS article.
    First tries a short Gemini call to write it in Hindi.
    Falls back to English template if Gemini is unavailable.
    """
    title   = news_item['title'].strip()
    summary = (news_item.get('summary') or title).strip()
    source  = news_item.get('source') or 'KWT News'
    keyword = cfg['search_keyword']

    # ── Try Gemini for Hindi script ───────────────────────────────
    translate_prompt = f"""You are a Hindi news video script writer for KWT News channel.

Convert this news into a 55-65 word Hindi spoken script for a 30-second video.
Write entirely in Hindi (Devanagari script).
Keep it natural and conversational.

News title: {title}
News summary: {summary}
Source: {source}
Category focus: {cfg['gemini_focus']}

Return ONLY valid JSON (no markdown):
{{
  "title": "Hindi headline",
  "summary": "2-3 sentence Hindi summary",
  "script": "55-65 word Hindi spoken script",
  "keywords": ["visual scene keyword 1", "visual scene keyword 2", "visual scene keyword 3"],
  "image_keyword": "single English keyword for thumbnail image search"
}}"""

    try:
        raw = _call_gemini(translate_prompt, use_search=False)
        data = _parse_json(raw) if raw else None
        if data and data.get('script') and data.get('title'):
            print(f"   ℹ️  RSS + Hindi translation via Gemini ({len(data['script'].split())} words)")
            script_words = data['script'].split()
            subtitle_lines = [
                ' '.join(script_words[i:i+5])
                for i in range(0, min(len(script_words), 30), 5)
            ]
            return {
                'title':          data['title'],
                'summary':        data.get('summary', summary[:300]),
                'content':        data.get('summary', summary[:300]),
                'script':         data['script'],
                'keywords':       data.get('keywords', [keyword, 'news']),
                'subtitle_lines': subtitle_lines,
                'image_keyword':  data.get('image_keyword', keyword),
                'source':         source,
                'apply_link':     '',
                'buy_link':       '',
                'skip':           False,
            }
    except Exception as e:
        print(f"   Hindi translation failed: {e}")

    # ── Plain English fallback ────────────────────────────────────
    print(f"   ℹ️  Using English RSS fallback script")
    intro    = f"Here's the latest from {source}. {title}."
    body     = ' '.join(summary.split())
    combined = f"{intro} {body}"
    words    = combined.split()

    if len(words) > 65:
        script = ' '.join(words[:62]) + '.'
    elif len(words) < 30:
        script = combined + " Stay tuned to KWT News for more updates."
    else:
        script = combined

    all_words = script.split()
    subtitle_lines = [
        ' '.join(all_words[i:i+5])
        for i in range(0, min(len(all_words), 30), 5)
    ]
    content = f"{title}\n\n{summary}\n\nSource: {source}"

    return {
        'title':          title,
        'summary':        summary[:300],
        'content':        content,
        'script':         script,
        'keywords':       cfg.get('video_keywords', [keyword, 'news']),
        'subtitle_lines': subtitle_lines,
        'image_keyword':  keyword,
        'source':         source,
        'apply_link':     '',
        'buy_link':       '',
        'skip':           False,
    }


# ── Public entry point ────────────────────────────────────────────────────────

def generate_script(news_item: dict | None, category: str, cfg: dict) -> dict | None:
    """
    Generate a 30-second video script + metadata in Hindi.

    Flow:
      1. Try Gemini AI (with Google Search grounding) → Hindi script
      2. If Gemini unavailable AND news_item exists → RSS + Hindi translation fallback
      3. If both fail / no source → return {'skip': True}

    Returns dict with: title, summary, content, script, keywords,
                       subtitle_lines, image_keyword, source,
                       apply_link, buy_link, skip
    """
    extra_fields = ''
    if category == 'kuwait-jobs':
        extra_fields = '"apply_link": "direct job application URL or empty string",'
    elif category == 'kuwait-offers':
        extra_fields = '"buy_link": "direct product/offer URL or empty string",'

    # Video keywords: prefer category-specific visual keywords
    video_kw_hint = ', '.join(cfg.get('video_keywords', [cfg['search_keyword']]))

    if news_item:
        news_context = (
            f"Title: {news_item['title']}\n"
            f"Summary: {news_item['summary']}\n"
            f"Source: {news_item['source']}\n"
            f"Link: {news_item.get('link', '')}"
        )
        search_instruction = "Use the provided news context AND Google Search to verify and enrich the article."
    else:
        news_context       = f"No RSS article provided. {cfg['gemini_focus']}"
        search_instruction = "Use Google Search to find the most recent relevant news."

    prompt = f"""You are a professional Hindi news video script writer for KWT News, a Kuwait-based Hindi news channel.

{search_instruction}

NEWS CONTEXT:
{news_context}

CATEGORY FOCUS: {cfg['gemini_focus']}

TASK: Write a complete 30-second Hindi news video script.

CRITICAL RULES:
1. Write the "script" field ENTIRELY IN HINDI (Devanagari script) — this is for Hindi voice-over.
2. The "title" and "summary" fields should also be in Hindi.
3. "content" (article body) can be in Hindi or English — 300-500 words journalistic style.
4. The "script" must be 55-65 words (comfortable 30-second speaking pace).
5. Only use REAL, VERIFIED news. Do NOT fabricate anything.
6. If no relevant real news found for this category, return {{"skip": true}}.
7. "keywords" must be VISUAL SCENE descriptions for stock footage search (e.g., "{video_kw_hint}").
8. "image_keyword" must be a single English word/phrase for thumbnail image search.

Return ONLY valid JSON (no markdown code blocks):
{{
  "title": "Hindi headline",
  "summary": "2-3 sentence Hindi summary",
  "content": "Full article body (300-500 words)",
  "script": "55-65 word Hindi spoken narration in Devanagari",
  "keywords": ["visual scene 1", "visual scene 2", "visual scene 3"],
  "subtitle_lines": ["Hindi line one", "Hindi line two", "Hindi line three", "Hindi line four"],
  "image_keyword": "english thumbnail keyword",
  "source": "Publication name",
  {extra_fields}
  "skip": false
}}"""

    # ── Try Gemini ────────────────────────────────────────────────
    try:
        raw  = _call_gemini(prompt)
        data = _parse_json(raw) if raw else None

        if data and not data.get('skip'):
            data.setdefault('title',          news_item['title']  if news_item else 'News Update')
            data.setdefault('summary',        news_item.get('summary', '') if news_item else '')
            data.setdefault('content',        data.get('summary', ''))
            data.setdefault('script',         data.get('summary', '')[:300])
            data.setdefault('keywords',       cfg.get('video_keywords', [cfg['search_keyword']]))
            data.setdefault('subtitle_lines', [])
            data.setdefault('image_keyword',  cfg['search_keyword'])
            data.setdefault('source',         news_item['source'] if news_item else 'KWT News')
            data.setdefault('apply_link',     '')
            data.setdefault('buy_link',       '')
            data['skip'] = False
            return data

        if data and data.get('skip'):
            # Gemini says no news — if RSS gave us something, still post it
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
