"""
Video editor — assembles video clips + audio + subtitles into a final MP4.
Uses MoviePy 1.0.x with PIL-based subtitle rendering (no ImageMagick required).
"""

import os
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── Pillow 10+ compatibility ──────────────────────────────────────────────────
# MoviePy 1.0.3 uses PIL.Image.ANTIALIAS internally; it was removed in Pillow 10.
# Monkey-patch it back so MoviePy doesn't crash on resize.
if not hasattr(Image, 'ANTIALIAS'):
    Image.ANTIALIAS = Image.LANCZOS  # LANCZOS is the modern equivalent

from tts import group_subtitles

VIDEO_SIZE = (1280, 720)
FPS = 25

# Font paths to try (Ubuntu GitHub runner has DejaVu fonts)
FONT_PATHS = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
]


def _get_font(size: int):
    for fp in FONT_PATHS:
        try:
            return ImageFont.truetype(fp, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _hex_to_rgb(hex_color: str) -> tuple:
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def _make_subtitle_frame(text: str, size: tuple = VIDEO_SIZE) -> np.ndarray:
    """Create a transparent RGBA frame with subtitle text at the bottom."""
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _get_font(36)

    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    x = (size[0] - tw) // 2
    y = size[1] - th - 55
    pad = 14

    # Semi-transparent background
    draw.rounded_rectangle(
        [x - pad, y - pad, x + tw + pad, y + th + pad],
        radius=10,
        fill=(0, 0, 0, 185),
    )
    # White text
    draw.text((x, y), text, fill=(255, 255, 255, 255), font=font)

    return np.array(img)


def _make_top_bar_frame(
    source_name: str,
    category_label: str,
    category_color: str,
    size: tuple = VIDEO_SIZE,
) -> np.ndarray:
    """Create the static top-bar overlay: source name left, category badge right."""
    w, h = size
    bar_height = 72
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Gradient from top
    for y in range(bar_height):
        alpha = int(210 * (1 - y / bar_height))
        draw.line([(0, y), (w, y)], fill=(0, 0, 0, alpha))

    font_lg = _get_font(22)
    font_sm = _get_font(18)

    # Source name (left side)
    draw.text((18, 22), f"📺  {source_name}", fill=(255, 255, 255, 220), font=font_lg)

    # Category badge (right side)
    badge_text = category_label
    bbox = draw.textbbox((0, 0), badge_text, font=font_sm)
    bw = bbox[2] - bbox[0]
    bh = bbox[3] - bbox[1]
    bx = w - bw - 32
    by = 20

    cat_rgb = _hex_to_rgb(category_color)
    draw.rounded_rectangle(
        [bx - 10, by - 6, bx + bw + 10, by + bh + 6],
        radius=14,
        fill=(*cat_rgb, 210),
    )
    draw.text((bx, by), badge_text, fill=(15, 15, 15, 255), font=font_sm)

    return np.array(img)


def _make_image_clip_from_rgba(rgba_array: np.ndarray, duration: float, start: float = 0.0):
    """Convert a PIL RGBA numpy array to a MoviePy ImageClip with mask."""
    from moviepy.editor import ImageClip

    rgb = rgba_array[:, :, :3]
    alpha = rgba_array[:, :, 3] / 255.0

    clip = (
        ImageClip(rgb)
        .set_start(start)
        .set_duration(duration)
    )
    mask = (
        ImageClip(alpha, ismask=True)
        .set_start(start)
        .set_duration(duration)
    )
    return clip.set_mask(mask)


def _build_base_video(clip_paths: list, target_duration: float):
    """
    Load video clips and concatenate/loop to reach target_duration.
    Resizes all clips to VIDEO_SIZE.
    Falls back to a black clip if nothing is available.
    """
    from moviepy.editor import VideoFileClip, concatenate_videoclips, ColorClip

    clips = []
    for path in clip_paths:
        try:
            c = (
                VideoFileClip(path, audio=False)
                .resize(VIDEO_SIZE)
                .without_audio()
            )
            clips.append(c)
        except Exception as e:
            print(f"   Skipping clip {path}: {e}")

    if not clips:
        print("   ⚠️  No usable clips — using black background")
        return ColorClip(VIDEO_SIZE, color=(10, 20, 40), duration=target_duration)

    # Concatenate, loop if shorter than needed
    combined = concatenate_videoclips(clips, method='compose')
    if combined.duration < target_duration:
        # Loop by concatenating again
        repeats = int(target_duration / combined.duration) + 2
        combined = concatenate_videoclips([combined] * repeats, method='compose')

    return combined.subclip(0, target_duration)


def create_video(
    clip_paths: list,
    audio_path: str,
    word_timings: list,
    output_path: str,
    source_name: str = 'KWT News',
    category_label: str = '🇰🇼 Kuwait',
    category_color: str = '#34d399',
) -> None:
    """
    Assemble the final news video:
      - Video clips (looped to audio duration)
      - Audio track (Edge-TTS)
      - Subtitle overlays (from word_timings)
      - Top-bar overlay (source + category badge)

    Args:
        clip_paths:      Local paths to downloaded video clips
        audio_path:      Path to Edge-TTS MP3 file
        word_timings:    Word boundary timings from TTS
        output_path:     Where to write the final MP4
        source_name:     News source name
        category_label:  Category display name with emoji
        category_color:  Category hex color
    """
    from moviepy.editor import AudioFileClip, CompositeVideoClip

    # --- Audio ---
    audio = AudioFileClip(audio_path)
    # Use exact audio duration — adding a buffer causes MoviePy to read
    # beyond the audio file end and crash with "Accessing time t=X > clip duration"
    total_duration = audio.duration

    print(f"   Audio duration: {audio.duration:.1f}s → video: {total_duration:.1f}s")

    # --- Base video ---
    base = _build_base_video(clip_paths, total_duration)

    # --- Top bar overlay (static, full duration) ---
    top_bar_arr = _make_top_bar_frame(source_name, category_label, category_color)
    top_bar = _make_image_clip_from_rgba(top_bar_arr, duration=total_duration, start=0)

    # --- Subtitles ---
    subtitle_clips = []
    chunks = group_subtitles(word_timings, words_per_line=5)
    for chunk in chunks:
        sub_arr = _make_subtitle_frame(chunk['text'])
        duration = max(0.3, chunk['end'] - chunk['start'])
        sub_clip = _make_image_clip_from_rgba(sub_arr, duration=duration, start=chunk['start'])
        subtitle_clips.append(sub_clip)

    # --- Composite ---
    layers = [base, top_bar] + subtitle_clips
    final = CompositeVideoClip(layers, size=VIDEO_SIZE)
    final = final.set_audio(audio)
    final = final.set_duration(total_duration)

    # --- Export ---
    print(f"   Rendering {output_path}...")
    final.write_videofile(
        output_path,
        fps=FPS,
        codec='libx264',
        audio_codec='aac',
        temp_audiofile=output_path + '.tmp.m4a',
        remove_temp=True,
        verbose=False,
        logger=None,
    )

    # Cleanup
    try:
        audio.close()
    except Exception:
        pass
    try:
        base.close()
    except Exception:
        pass
    for sub in subtitle_clips:
        try:
            sub.close()
        except Exception:
            pass

    print(f"   ✅ Video saved: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB")
