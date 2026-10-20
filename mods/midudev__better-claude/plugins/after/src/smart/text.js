// Tiny, dependency-free fuzzy matching tuned for short task descriptions in English and Spanish.

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'me', 'us', 'please', 'task',
  'tasks', 'item', 'one', 'thing', 'stuff', 'about', 'some', 'all', 'is', 'be', 'are', 'was',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'al', 'en', 'con',
  'para', 'por', 'que', 'lo', 'le', 'les', 'se', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'este',
  'esta', 'esto', 'ese', 'esa', 'eso', 'tarea', 'tareas', 'cosa', 'porfa', 'favor'
])

const SUFFIXES = [
  ['ciones', 'cion'], ['ations', 'ate'], ['ation', 'ate'], ['iendo', ''], ['ando', ''],
  ['mente', ''], ['ings', ''], ['ing', ''], ['ies', 'y'], ['ers', ''], ['es', ''], ['ed', ''],
  ['er', ''], ['ar', ''], ['ir', ''], ['s', '']
]

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize (text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export const tokenize = (text) => normalize(text).split(' ').filter(Boolean)

export const keywords = (text) => tokenize(text).filter(word => word.length > 1 && !STOPWORDS.has(word))

/** Very small suffix stripper; good enough to match "adding"/"add" or "tests"/"test". */
export function stem (word) {
  for (const [suffix, replacement] of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length) + replacement
    }
  }
  return word
}

const commonPrefix = (a, b) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** 0..1 similarity between two normalized words. */
export function wordSimilarity (a, b) {
  if (a === b) return 1
  const sa = stem(a)
  const sb = stem(b)
  if (sa === sb) return 0.9
  // One word (or its stem) is a prefix of the other: "read"/"readme", "añadir"/"añade"
  const isPrefix = (x, y) => {
    const shorter = Math.min(x.length, y.length)
    return shorter >= 3 && commonPrefix(x, y) === shorter
  }
  if (isPrefix(a, b) || isPrefix(sa, sb)) return 0.8
  const prefix = commonPrefix(a, b)
  if (prefix >= 5 && prefix >= Math.min(a.length, b.length) * 0.75) return 0.7
  return 0
}

const coverage = (from, to) =>
  from.reduce((sum, word) => sum + Math.max(0, ...to.map(other => wordSimilarity(word, other))), 0) / from.length

/**
 * How well `query` describes `target` (0..1). Weighted towards the query being fully
 * explained by the target, because users refer to tasks with a few of their words.
 */
export function similarity (query, target) {
  const q = keywords(query)
  const t = keywords(target)
  if (q.length === 0 || t.length === 0) return 0
  return 0.7 * coverage(q, t) + 0.3 * coverage(t, q)
}

/** Items sorted by similarity to `query`, best first. */
export function rank (query, items) {
  return items
    .map(item => ({ item, score: similarity(query, item.text) }))
    .sort((a, b) => b.score - a.score)
}

/**
 * The single item `query` clearly refers to, or null when there is no good match
 * or when two items are too close to call.
 */
export function bestMatch (query, items, { min = 0.6, margin = 0.12 } = {}) {
  const [first, second] = rank(query, items)
  if (!first || first.score < min) return null
  if (second && first.score - second.score < margin) return null
  return first
}
