// Pixabay image search helper

const PIXABAY_BASE = 'https://pixabay.com/api/';

/**
 * Search Pixabay for a relevant image URL.
 * Falls back to a generic placeholder if nothing found.
 * @param {string} keyword
 * @returns {Promise<string>} image URL
 */
export async function getImage(keyword) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) {
    console.warn('PIXABAY_API_KEY not set, using placeholder');
    return `https://placehold.co/1280x720/1a2d4a/e8edf5?text=${encodeURIComponent(keyword)}`;
  }

  const query = encodeURIComponent(keyword.slice(0, 80));
  const url = `${PIXABAY_BASE}?key=${key}&q=${query}&image_type=photo&safesearch=true&orientation=horizontal&min_width=800&per_page=5&order=latest`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.hits && data.hits.length > 0) {
      // Prefer larger webformatURL
      return data.hits[0].largeImageURL || data.hits[0].webformatURL;
    }

    // Retry with shorter/simplified keyword
    const shortKeyword = keyword.split(' ').slice(0, 2).join(' ');
    if (shortKeyword !== keyword) return getImage(shortKeyword);

  } catch (e) {
    console.error('Pixabay error:', e.message);
  }

  return `https://placehold.co/1280x720/1a2d4a/e8edf5?text=${encodeURIComponent(keyword)}`;
}
