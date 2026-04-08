// Duplicate detection using Jaccard similarity on title tokens

const STOP_WORDS = new Set([
  'the','a','an','is','in','on','at','to','for','of','and','or','but','with',
  'from','by','as','it','its','this','that','was','are','be','been','will',
  'has','have','had','not','no','new','news','latest','update','breaking',
  'today','now','just','after','over','more','than','kuwait','world','كويت',
  'في','من','على','إلى','وال','هذا','ذلك','بعد',
]);

/**
 * Tokenize title into a set of meaningful lowercase words.
 * @param {string} title
 * @returns {Set<string>}
 */
function tokenize(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\sأ-ي]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/**
 * Jaccard similarity between two sets.
 * @param {Set} a
 * @param {Set} b
 * @returns {number} 0..1
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if a new article title is a duplicate of any existing articles.
 * @param {string} newTitle
 * @param {Array<{title: string}>} existingArticles
 * @param {number} threshold - similarity threshold (default 0.45)
 * @returns {{ isDuplicate: boolean, matchedTitle?: string }}
 */
export function checkDuplicate(newTitle, existingArticles, threshold = 0.45) {
  const newTokens = tokenize(newTitle);

  for (const article of existingArticles) {
    if (!article.title) continue;
    const existingTokens = tokenize(article.title);
    const score = jaccard(newTokens, existingTokens);
    if (score >= threshold) {
      return { isDuplicate: true, matchedTitle: article.title, score };
    }
  }

  return { isDuplicate: false };
}
