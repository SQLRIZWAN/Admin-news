"""
Text-to-Speech using Microsoft Edge TTS (edge-tts).
Returns word-level timings for subtitle synchronisation.
"""

import asyncio
import os
import edge_tts


async def _generate_async(script: str, output_path: str, voice: str) -> list:
    """Async core: streams audio to file and collects word boundary events."""
    communicate = edge_tts.Communicate(script, voice)
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


def generate_tts(script: str, output_path: str, voice: str = 'en-US-GuyNeural') -> list:
    """
    Generate TTS audio and return word timings.

    Args:
        script: Text to convert to speech
        output_path: Where to save the MP3 file
        voice: Edge TTS voice name

    Returns:
        List of dicts: [{word, start, duration}, ...]
    """
    # Retry with fallback voice on failure
    voices_to_try = [voice, 'en-US-GuyNeural', 'en-US-AriaNeural']
    seen = set()
    voices_to_try = [v for v in voices_to_try if not (v in seen or seen.add(v))]

    last_err = None
    for v in voices_to_try:
        try:
            timings = asyncio.run(_generate_async(script, output_path, v))
            if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                print(f"   Voice: {v} | Words timed: {len(timings)}")
                return timings
        except Exception as e:
            last_err = e
            print(f"   TTS voice {v} failed: {e}, trying next...")
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
