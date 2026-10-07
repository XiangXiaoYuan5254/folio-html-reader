// A chat answer as a section of a document's note, so it reads on its own later: the question
// as its heading (a quick action by its name), in full below it when the heading had to
// shorten it, the passage it was asked about, the pictures sent with it, then the answer under
// a label that sets it apart from the question.
const quote = (text: string) =>
  text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');

export const answerLabel = '**AI 回答：**';

export function answerNote(p: {
  question?: { text: string; label?: string; selection?: string };
  // The question's pictures, already kept as note images (their names).
  pictures?: string[];
  answer: string;
  date: string;
}) {
  const asked = p.question?.label ? '' : (p.question?.text || '').trim();
  const firstLine = asked
    .split('\n')
    .find((line) => line.trim())
    ?.replace(/\s+/g, ' ')
    .trim();
  const title =
    p.question?.label ||
    (firstLine ? (firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine) : 'AI 回答');
  const selection = (p.question?.selection || '').trim();
  return [
    `## ${title}（${p.date}）`,
    ...(asked && asked !== title ? ['', quote(`问：${asked}`)] : []),
    ...(selection
      ? ['', quote(`原文：${selection.length > 1000 ? `${selection.slice(0, 1000)}…` : selection}`)]
      : []),
    ...(p.pictures || []).flatMap((name) => ['', `![提问附的图片](note-image:${name})`]),
    // Without a question the heading already says “AI 回答”.
    ...(p.question ? ['', answerLabel] : []),
    '',
    p.answer,
  ].join('\n');
}
