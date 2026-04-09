"""
Text-to-Speech using Microsoft Edge TTS (edge-tts).
Returns word-level timings for subtitle synchronisation.
Uses SSML for natural-sounding Hindi speech (pauses, prosody).
"""

import asyncio
import os
import re
import edge_tts


def _to_ssml(script: str, voice: str) -> str:
    """
    Wrap the script in SSML for more natural, human-sounding speech.
    - Adds natural pauses at punctuation
    - Slight speed reduction (-8%) for clearer news delivery
    - Emphasis on sentence starts
    Works with Edge TTS voices including hi-IN neural voices.
    """
    # Escape XML special characters
    text = script.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    # Add pauses at sentence boundaries
    text = re.sub(r'([।\.!?])\s+', r'\1<break time="450ms"/> ', text)
    text = re.sub(r'([,،])\s+', r'\1<break time="200ms"/> ', text)

    # Wrap in SSML with prosody for natural pace
    ssml = (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="hi-IN">'
        f'<voice name="{voice}">'
        f'<prosody rate="-8%" pitch="-2%">'
        f'{text}'
        f'</prosody>'
        f'</voice>'
        f'</speak>'
    )
    return ssml


async def _generate_async(script: str, output_path: str, voice: str) -> list:
    """Async core: streams audio to file and collects word boundary events."""
    # Use SSML for Hindi voices for more natural delivery
    use_ssml = voice.startswith('hi-IN') or voice.startswith('en-IN')
    text_input = _to_ssml(script, voice) if use_ssml else script

    communicate = edge_tts.Communicate(text_input, voice)
    word_timings = []

    with open(output_path, 'wb') as f:
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                f.write(chunk['data'])
            elif chunk['type'] == 'WordBoundary':
                word_timings.append({
                    'word': chunk['text'],
                    'start': chunk['offset'] / 10_000_000,       # 100-ns units → seconds
                    'duration': chunk['duration'] / 10_000_000,
                })

    return word_timings


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
    # Try SSML first, fall back to plain text if SSML fails
    attempts = [
        (voice, True),                    # Primary voice with SSML
        (voice, False),                   # Primary voice plain text
        ('hi-IN-MadhurNeural', True),     # Hindi male SSML
        ('hi-IN-SwaraNeural', True),      # Hindi female SSML
        ('hi-IN-MadhurNeural', False),    # Hindi male plain
        ('en-US-GuyNeural', False),       # English fallback
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
            # Override SSML decision in _generate_async via monkey-patch approach:
            # directly pick SSML or plain based on attempt
            async def _run(v=v, use_ssml=use_ssml):
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
                                'start': chunk['offset'] / 10_000_000,
                                'duration': chunk['duration'] / 10_000_000,
                            })
                return word_timings

            timings = asyncio.run(_run())
            if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                mode = 'SSML' if use_ssml else 'plain'
                print(f"   Voice: {v} ({mode}) | Words: {len(timings)}")
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
