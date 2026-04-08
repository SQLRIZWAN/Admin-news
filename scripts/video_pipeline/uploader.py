"""
Cloudinary uploader — uploads video and image files.
Uses the unsigned upload preset (sql_admin) from the existing KWT News app.
"""

import os
import time
import requests

CLOUDINARY_CLOUD = 'debp1kjtm'
UPLOAD_PRESET = 'sql_admin'
FOLDER = 'kwt_auto'

VIDEO_UPLOAD_URL = f'https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD}/video/upload'
IMAGE_UPLOAD_URL = f'https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD}/image/upload'


def _upload_with_retry(url: str, data: dict, files: dict, retries: int = 3) -> str | None:
    """Upload to Cloudinary with exponential backoff retry."""
    delay = 5
    for attempt in range(retries):
        try:
            res = requests.post(url, data=data, files=files, timeout=180)
            result = res.json()

            if res.status_code == 200 and result.get('secure_url'):
                return result['secure_url']

            error = result.get('error', {}).get('message', 'Unknown error')
            print(f"   Cloudinary attempt {attempt+1} failed: {error}")

        except requests.exceptions.Timeout:
            print(f"   Cloudinary upload timeout (attempt {attempt+1})")
        except Exception as e:
            print(f"   Cloudinary upload error (attempt {attempt+1}): {e}")

        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2

    return None


def upload_video(video_path: str) -> str | None:
    """
    Upload a video file to Cloudinary.
    Returns the secure URL or None on failure.
    """
    print(f"   Uploading video ({os.path.getsize(video_path)/1024/1024:.1f} MB)...")

    with open(video_path, 'rb') as f:
        url = _upload_with_retry(
            VIDEO_UPLOAD_URL,
            data={
                'upload_preset': UPLOAD_PRESET,
                'folder': FOLDER,
                'resource_type': 'video',
            },
            files={'file': f},
        )

    if url:
        print(f"   ✅ Video uploaded: {url[:70]}...")
    else:
        print("   ❌ Video upload failed after retries")

    return url


def upload_image_from_url(image_url: str) -> str:
    """
    Upload a remote image URL to Cloudinary (for thumbnail control).
    Returns the Cloudinary URL or the original URL as fallback.
    """
    try:
        res = requests.post(
            IMAGE_UPLOAD_URL,
            data={
                'upload_preset': UPLOAD_PRESET,
                'folder': FOLDER,
                'file': image_url,
            },
            timeout=30,
        )
        result = res.json()
        if res.status_code == 200 and result.get('secure_url'):
            return result['secure_url']
    except Exception as e:
        print(f"   Thumbnail upload skipped: {e}")

    # Return original Pixabay URL as fallback
    return image_url
