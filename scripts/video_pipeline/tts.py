"""
Text-to-Speech using Microsoft Edge TTS (edge-tts).
Returns word-level timings for subtitle synchronisation.
Uses SSML for natural-sounding Hindi speech (pauses, prosody).
"""

import asyncio
import json
import os
import re
import edge_tts


def _clean_for_tts(script: str) -> str:
    """
    Strip JSON artifacts, markdown code blocks, and programming syntax
    from a script before passing to TTS. Prevents the voice from reading
    JSON keys, backticks, braces, or markdown formatting aloud.
    """
    if not script:
        return ''

    s = script.strip()

    # If it looks like a JSON object, try to extract the 'script' field
    if s.startswith('{') or '```' in s:
        try:
            cleaned_s = re.sub(r'```(?:json)?\s*', '', s).replace('```', '').strip()
            data = json.loads(cleaned_s)
            if isinstance(data, dict) and data.get('script'):
                return _clean_for_tts(data['script'])
        except Exception:
            pass

    # Strip markdown code fences (```...```)
    s = re.sub(r'```[\s\S]*?```', ' ', s)
    # Strip inline backtick code
    s = re.sub(r'`[^`]*`', ' ', s)
    # Strip JSON key-value patterns: "key": "value" or "key": true/false/number
    s = re.sub(r'"[a-zA-Z_]+"\s*:\s*(?:"[^"]*"|\[[^\]]*\]|true|false|null|-?\d+\.?\d*)', ' ', s)
    # Strip remaining braces / brackets
    s = re.sub(r'[{}\[\]]', ' ', s)
    # Strip markdown headers (## Heading)
    s = re.sub(r'^#{1,6}\s+', '', s, flags=re.MULTILINE)
    # Strip markdown bullets
    s = re.sub(r'^[\*\-\+]\s+', '', s, flags=re.MULTILINE)
    # Strip bold/italic markers but keep text
    s = re.sub(r'\*{1,3}([^*]+)\*{1,3}', r'\1', s)
    # Collapse whitespace
    s = ' '.join(s.split())
    return s.strip()


def _to_ssml(script: str, voice: str) -> str:
    """
    Wrap the already-cleaned script in SSML for natural news-anchor speech.
    Caller must clean the script before passing here.

    IMPORTANT: Hindi voices (hi-IN-*) do NOT support mstts:express-as
    style="newscast" — using it causes Microsoft's TTS service to reject the
    request and return empty audio. Use prosody-only SSML for Hindi voices.
    English voices (en-US-*, en-GB-*) support newscast style.
    """
    # Escape XML special characters (script is already clean — no JSON/markdown)
    text = script.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    # Natural pauses at Hindi/English sentence boundaries
    text = re.sub(r'([।\.!?])\s+', r'\1<break time="450ms"/> ', text)
    text = re.sub(r'([,،;])\s+',   r'\1<break time="180ms"/> ', text)
    # Add natural breathing pause every ~25 words
    words = text.split(' ')
    chunked = []
    for i, w in enumerate(words):
        chunked.append(w)
        if (i + 1) % 25 == 0 and i < len(words) - 1:
            chunked.append('<break time="250ms"/>')
    text = ' '.join(chunked)

    is_hindi = 'hi-IN' in voice or 'hi-in' in voice.lower()
    lang = 'hi-IN' if is_hindi else 'en-US'

    if is_hindi:
        # Hindi voices: prosody only (rate slightly slower for clear diction)
        inner = (
            f'<prosody rate="-8%" pitch="+3%" volume="loud">'
            f'{text}'
            f'</prosody>'
        )
        ssml = (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{lang}">'
            f'<voice name="{voice}">'
            f'{inner}'
            f'</voice>'
            f'</speak>'
        )
    else:
        # English voices: newscast style is supported
        inner = (
            f'<mstts:express-as style="newscast">'
            f'<prosody rate="-5%" pitch="+2%" volume="loud">'
            f'{text}'
            f'</prosody>'
            f'</mstts:express-as>'
        )
        ssml = (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{lang}">'
            f'<voice name="{voice}">'
            f'{inner}'
            f'</voice>'
            f'</speak>'
        )
    return ssml


def generate_tts(script: str, output_path: str, voice: str = 'hi-IN-MadhurNeural') -> list:
    """
    Generate TTS audio and return word timings.

    Args:
        script: Text to convert to speech (Hindi or English)
        output_path: Where to save the MP3 file
        voice: Edge TTS voice name (default: Hindi Male)

    Returns:
        List of dicts: [{word, start, duration}, ...]
    """
    # Strip any JSON/code artifacts ONCE before any processing
    script = _clean_for_tts(script)
    if not script:
        raise ValueError("Script is empty after cleaning — nothing to convert to speech")

    # Try SSML first (most natural), then plain text fallbacks.
    # Hindi SSML uses prosody-only (no mstts:express-as newscast — not supported for hi-IN).
    # Plain Hindi comes before English so we never fall to English if Hindi is reachable.
    attempts = [
        (voice, True),                     # Requested voice with SSML (primary)
        ('hi-IN-MadhurNeural', True),      # Hindi male SSML
        ('hi-IN-SwaraNeural', True),       # Hindi female SSML
        (voice, False),                    # Requested voice plain text
        ('hi-IN-MadhurNeural', False),     # Hindi male plain
        ('hi-IN-SwaraNeural', False),      # Hindi female plain
        ('en-US-GuyNeural', False),        # English last resort only
    ]
    seen = set()
    unique_attempts = []
    for v, ssml in attempts:
        key = f"{v}-{ssml}"
        if key not in seen:
            seen.add(key)
            unique_attempts.append((v, ssml))

    last_err = None
    for v, use_ssml in unique_attempts:
        try:
            async def _run(v=v, use_ssml=use_ssml):
                # Script is already cleaned — pass directly to _to_ssml without re-cleaning
                text_input = _to_ssml(script, v) if use_ssml else script
                communicate = edge_tts.Communicate(text_input, v)
                word_timings = []
                with open(output_path, 'wb') as f:
                    async for chunk in communicate.stream():
                        if chunk['type'] == 'audio':
                            f.write(chunk['data'])
                        elif chunk['type'] == 'WordBoundary':
                            word_timings.append({
                                'word': chunk['text'],
                                'start': chunk['offset'] / 10_000_000,       # 100-ns → seconds
                                'duration': chunk['duration'] / 10_000_000,
                            })
                return word_timings

            timings = asyncio.run(_run())
            if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                mode = 'SSML-newscast' if use_ssml else 'plain'
                print(f"   ✅ Voice: {v} ({mode}) | Words: {len(timings)}")
                return timings
        except Exception as e:
            last_err = e
            print(f"   TTS {v}: {e} — trying next...")
            # Remove partial file
            if os.path.exists(output_path):
                os.remove(output_path)
            continue

    raise Exception(f"All TTS voices failed. Last error: {last_err}")


def group_subtitles(word_timings: list, words_per_line: int = 5) -> list:
    """
    Group word timings into subtitle chunks for on-screen display.

    Returns:
        List of dicts: [{text, start, end}, ...]
    """
    if not word_timings:
        return []

    chunks = []
    for i in range(0, len(word_timings), words_per_line):
        group = word_timings[i:i + words_per_line]
        chunks.append({
            'text': ' '.join(w['word'] for w in group),
            'start': group[0]['start'],
            'end': group[-1]['start'] + group[-1]['duration'],
        })

    return chunks
