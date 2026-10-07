import { answerLabel } from '../ai/note-block';

// Where the part of a note holding `find` starts, to scroll to it: the heading above it (past
// quotes, pictures and the answer label, such as a saved answer's question), so its whole
// section shows, or else the start of its line. -1 when the note doesn't have it.
// The last match counts, as the same answer may be saved twice; if the text was edited since,
// its first line (when long enough to be telling) is looked for instead.
export function sectionAt(doc: string, find: string) {
  const text = find.trim();
  if (!text) return -1;
  let at = doc.lastIndexOf(text);
  if (at === -1) {
    const first = text.split('\n').find((line) => line.trim())?.trim() || '';
    if (first.length >= 6) at = doc.lastIndexOf(first);
  }
  if (at === -1) return -1;
  at = doc.lastIndexOf('\n', at - 1) + 1;
  const lines = doc.slice(0, at).split('\n');
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) return lines.slice(0, i).join('\n').length + (i ? 1 : 0);
    if (line && line !== answerLabel && !line.startsWith('>') && !line.startsWith('![')) break;
  }
  return at;
}
