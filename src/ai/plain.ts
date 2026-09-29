// Citations in replies, and replies turned into plain text.
const citePattern = /<cite(?:\s+doc="([^"]*)")?\s*>([\s\S]*?)<\/cite>/g;
export function citations(text: string) {
  return [...text.matchAll(citePattern)].map((m) => ({ doc: m[1] || '', quote: m[2].trim() }));
}
export const citeKey = (doc: string, quote: string) => `${doc}\u0000${quote}`;
// For notes and copies: citations become quoted text.
export function plainCites(text: string) {
  return text.replace(citePattern, (_, __, quote) => `「${quote.trim()}」`);
}
// Highlight notes are plain text: Markdown marks from a reply are removed.
export function plainText(text: string) {
  return plainCites(text)
    .replace(/```[\w-]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
