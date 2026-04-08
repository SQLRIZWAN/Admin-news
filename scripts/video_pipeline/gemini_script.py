"""
Gemini AI script generator.
Takes a raw news item + category config and returns structured JSON
with title, summary, content, 30-sec script, keywords, etc.
"""

import os
import re
import json
import requests

GEMINI_BASE = 'https://generativelanguage.googleapis.com/'
MODELS = [
    {'m': 'gemini-2.5-flash',               'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.5-flash-preview-05-20', 'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.0-flash',               'v': 'v1beta', 'search': True},
    {'m': 'gemini-2.0-flash-lite',          'v': 'v1beta', 'search': True},
    {'m': 'gemini-1.5-flash-latest',        'v': 'v1beta', 'search': False},
]


def _call_gemini(prompt: str) -> str:
    """Call Gemini API with google_search grounding. Returns raw text."""
    key = os.environ['GEMINI_API_KEY']

    for cfg in MODELS:
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
            data = res.json()

            if 'error' in data:
                msg = data['error'].get('message', '')
                code = data['error'].get('code', 0)
                if code == 429 or any(w in msg.lower() for w in ('quota', 'rate', 'limit')):
                    print(f"   Model {cfg['m']} quota hit, trying next...")
                    continue
                raise Exception(f"Gemini API error: {msg}")

            text = data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
            if text:
                return text

        except requests.exceptions.Timeout:
            print(f"   Model {cfg['m']} timeout, trying next...")
            continue
        except Exception as e:
            if 'quota' in str(e).lower():
                continue
            raise

    raise Exception("All Gemini models failed or returned empty")


def _parse_json(text: str) -> dict | None:
    """Parse JSON from Gemini response (handles markdown fences)."""
    if not text:
        return None
    # Direct parse
    try:
        return json.loads(text.strip())
    except Exception:
        pass
    # Strip markdown fences
    stripped = re.sub(r'```(?:json)?\s*', '', text, flags=re.IGNORECASE)
    stripped = stripped.replace('```', '').strip()
    try:
        return json.loads(stripped)
    except Exception:
        pass
    # Extract first {...} block
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    return None


def generate_script(news_item: dict | None, category: str, cfg: dict) -> dict | None:
    """
    Generate a 30-second video script + metadata from a news item.
    Falls back to Gemini Search if news_item is None.

    Returns dict with keys:
        title, summary, content, script, keywords,
        subtitle_lines, image_keyword, source,
        apply_link (jobs), buy_link (offers), skip (bool)
    """
    if news_item:
        news_context = (
            f"Title: {news_item['title']}\n"
            f"Summary: {news_item['summary']}\n"
            f"Source: {news_item['source']}\n"
            f"Link: {news_item.get('link', '')}"
        )
        search_instruction = "Use the provided news context AND Google Search to verify and enrich the article."
    else:
        news_context = f"No RSS article provided. {cfg['gemini_focus']}"
        search_instruction = "Use Google Search to find the most recent relevant news."

    # Category-specific extras
    extra_fields = ''
    if category == 'kuwait-jobs':
        extra_fields = '"apply_link": "direct job application URL or empty string",'
    elif category == 'kuwait-offers':
        extra_fields = '"buy_link": "direct product/offer URL or empty string",'

    prompt = f"""
You are a professional news video script writer for KWT News, a Kuwait-based news channel.

{search_instruction}

NEWS CONTEXT:
{news_context}

CATEGORY FOCUS: {cfg['gemini_focus']}

TASK: Write a complete 30-second news video script.

CRITICAL RULES:
1. ONLY use REAL, VERIFIED news from today or very recently. Do NOT fabricate.
2. If no relevant real news found, return {{"skip": true}}.
3. The "script" field must be 55-65 words (comfortable 30-second speaking pace).
4. Keywords must be specific and visual (for finding video clips).
5. Subtitle lines must be short (4-6 words each) for on-screen display.

Return ONLY valid JSON (no markdown, no explanation):
{{
  "title": "Clear, engaging article headline",
  "summary": "2-3 sentence article summary",
  "content": "Full article body (350-500 words, journalistic style)",
  "script": "The 30-second spoken narration (55-65 words)",
  "keywords": ["visual keyword 1", "visual keyword 2", "visual keyword 3"],
  "subtitle_lines": ["Short line one", "Short line two", "Short line three", "Short line four", "Short line five"],
  "image_keyword": "best single keyword for thumbnail image",
  "source": "Source publication name",
  {extra_fields}
  "skip": false
}}
"""

    try:
        raw = _call_gemini(prompt)
        data = _parse_json(raw)

        if not data:
            print("   ⚠️  Could not parse Gemini JSON response")
            return None

        if data.get('skip'):
            return {'skip': True}

        # Fill in defaults for any missing fields
        data.setdefault('title', news_item['title'] if news_item else 'News Update')
        data.setdefault('summary', news_item.get('summary', '') if news_item else '')
        data.setdefault('content', data.get('summary', ''))
        data.setdefault('script', data.get('summary', '')[:300])
        data.setdefault('keywords', [cfg['search_keyword']])
        data.setdefault('subtitle_lines', [])
        data.setdefault('image_keyword', cfg['search_keyword'])
        data.setdefault('source', news_item['source'] if news_item else 'KWT News')
        data.setdefault('apply_link', '')
        data.setdefault('buy_link', '')
        data['skip'] = False

        return data

    except Exception as e:
        print(f"   ❌ Gemini script generation failed: {e}")
        raise
