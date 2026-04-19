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


def _upload_with_retry(url: str, data: dict, files: dict, retries: int = 3) -> dict | None:
    """Upload to Cloudinary with exponential backoff retry.
    Returns {'url': secure_url, 'public_id': public_id} on success, None on failure.
    """
    delay = 5
    for attempt in range(retries):
        try:
            res = requests.post(url, data=data, files=files, timeout=180)
            result = res.json()

            if res.status_code == 200 and result.get('secure_url'):
                return {'url': result['secure_url'], 'public_id': result.get('public_id', '')}

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


def upload_video(video_path: str) -> dict | None:
    """
    Upload a video file to Cloudinary.
    Returns {'url': ..., 'public_id': ...} or None on failure.
    """
    print(f"   Uploading video ({os.path.getsize(video_path)/1024/1024:.1f} MB)...")

    with open(video_path, 'rb') as f:
        result = _upload_with_retry(
            VIDEO_UPLOAD_URL,
            data={
                'upload_preset': UPLOAD_PRESET,
                'folder': FOLDER,
                'resource_type': 'video',
            },
            files={'file': f},
        )

    if result:
        print(f"   ✅ Video uploaded: {result['url'][:70]}... (id: {result['public_id']})")
    else:
        print("   ❌ Video upload failed after retries")

    return result


def upload_image_from_url(image_url: str) -> dict:
    """
    Upload a remote image URL to Cloudinary (for thumbnail control).
    Returns {'url': ..., 'public_id': ...} with public_id='' if we had to fall back to the original URL.
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
            return {'url': result['secure_url'], 'public_id': result.get('public_id', '')}
    except Exception as e:
        print(f"   Thumbnail upload skipped: {e}")

    # Return original Pixabay URL as fallback (no public_id — can't destroy externally)
    return {'url': image_url, 'public_id': ''}
