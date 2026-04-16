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
FPS = 30

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
    y = size[1] - th - 115   # raised 60px to clear lower-third chyron + ticker
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
    """Create the static top-bar overlay: KwtNews.com branding left, category badge right."""
    w, h = size
    bar_height = 72
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Gradient from top (dark, like a real news broadcast)
    for y in range(bar_height):
        alpha = int(230 * (1 - y / bar_height))
        draw.line([(0, y), (w, y)], fill=(0, 0, 0, alpha))

    # Bottom accent bar (orange line, 3px)
    draw.line([(0, bar_height - 3), (w, bar_height - 3)], fill=(245, 166, 35, 255), width=3)

    font_lg = _get_font(26)
    font_dot = _get_font(26)
    font_sm = _get_font(18)

    # KwtNews.com branding (left side) — white "KwtNews" + orange ".com"
    brand_x = 18
    brand_y = 18
    draw.text((brand_x, brand_y), "KwtNews", fill=(255, 255, 255, 245), font=font_lg)
    kwt_bbox = draw.textbbox((brand_x, brand_y), "KwtNews", font=font_lg)
    dot_x = kwt_bbox[2]
    draw.text((dot_x, brand_y), ".com", fill=(245, 166, 35, 245), font=font_dot)

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
        fill=(*cat_rgb, 220),
    )
    draw.text((bx, by), badge_text, fill=(15, 15, 15, 255), font=font_sm)

    return np.array(img)


def _make_lower_third_frame(
    title: str,
    source: str,
    size: tuple = VIDEO_SIZE,
) -> np.ndarray:
    """
    Professional news lower-third chyron anchored at the bottom.
    Layout (bottom up, 8px from edge):
      - Source name bar: dark navy, 26px tall
      - Title bar: dark blue with orange accent stripe, 44px tall
    Total: ~78px block.
    """
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font_title  = _get_font(26)
    font_source = _get_font(15)

    # Truncate title to fit
    max_chars = 68
    display_title = title if len(title) <= max_chars else title[:max_chars - 1] + '…'

    bar_w     = w - 32        # 16px margin on each side
    bar_x     = 16
    bot_edge  = h - 8         # 8px from bottom

    # Source bar (dark navy, semi-transparent)
    src_h = 26
    src_y = bot_edge - src_h
    draw.rectangle([bar_x, src_y, bar_x + bar_w, src_y + src_h], fill=(8, 18, 40, 210))
    # Left accent tick
    draw.rectangle([bar_x, src_y, bar_x + 4, src_y + src_h], fill=(245, 166, 35, 255))
    draw.text((bar_x + 10, src_y + 5), f'SOURCE: {source.upper()}', fill=(160, 190, 220, 220), font=font_source)

    # Title bar (dark blue, semi-transparent)
    title_h = 44
    title_y = src_y - title_h
    draw.rectangle([bar_x, title_y, bar_x + bar_w, title_y + title_h], fill=(12, 28, 60, 235))
    # Left orange accent stripe (6px)
    draw.rectangle([bar_x, title_y, bar_x + 6, title_y + title_h], fill=(245, 166, 35, 255))
    # Title text (white)
    draw.text((bar_x + 14, title_y + 9), display_title, fill=(235, 242, 255, 255), font=font_title)

    return np.array(img)


def _make_news_ticker_frame(
    text: str,
    size: tuple = VIDEO_SIZE,
) -> np.ndarray:
    """
    Static news ticker strip at the very bottom (28px height).
    Shows a 'LIVE' badge and scrolling headline text (static v1).
    """
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    strip_h = 28
    strip_y = h - strip_h

    # Background strip
    draw.rectangle([0, strip_y, w, h], fill=(6, 14, 35, 225))
    # Orange top border
    draw.line([(0, strip_y), (w, strip_y)], fill=(245, 166, 35, 255), width=2)

    font_badge = _get_font(12)
    font_text  = _get_font(14)

    # LIVE badge (red)
    badge_w = 46
    draw.rectangle([0, strip_y, badge_w, h], fill=(195, 28, 28, 245))
    draw.text((7, strip_y + 7), 'LIVE', fill=(255, 255, 255, 255), font=font_badge)

    # Ticker text (truncated to fit single line)
    max_text = text[:120] if len(text) > 120 else text
    draw.text((badge_w + 10, strip_y + 6), max_text, fill=(210, 225, 245, 235), font=font_text)

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
    title: str = '',
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

    # --- Lower-third chyron (shown for first 6 seconds) ---
    lower_third_clips = []
    ticker_clips = []
    if title:
        lt_duration = min(6.0, total_duration)
        lt_arr = _make_lower_third_frame(title, source_name)
        lt_clip = _make_image_clip_from_rgba(lt_arr, duration=lt_duration, start=0.5)
        lower_third_clips.append(lt_clip)
        # Static news ticker (full video duration)
        ticker_arr = _make_news_ticker_frame(title)
        ticker_clips.append(_make_image_clip_from_rgba(ticker_arr, duration=total_duration, start=0))

    # --- Composite ---
    layers = [base, top_bar] + subtitle_clips + lower_third_clips + ticker_clips
    final = CompositeVideoClip(layers, size=VIDEO_SIZE)
    final = final.set_audio(audio)
    final = final.set_duration(total_duration)

    # --- Export ---
    print(f"   Rendering {output_path}...")
    final.write_videofile(
        output_path,
        fps=FPS,
        codec='libx264',
        bitrate='4000k',       # 4 Mbps — good HD quality for 1280×720
        audio_codec='aac',
        audio_bitrate='192k',  # Clear audio
        temp_audiofile=output_path + '.tmp.m4a',
        remove_temp=True,
        threads=2,             # Parallel encoding on GitHub Actions runner
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
    for clip in lower_third_clips + ticker_clips:
        try:
            clip.close()
        except Exception:
            pass

    print(f"   ✅ Video saved: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB")
