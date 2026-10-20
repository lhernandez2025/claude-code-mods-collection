/** Collapses whitespace and truncates with an ellipsis. */
export const shorten = (text, max = 60) => {
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

