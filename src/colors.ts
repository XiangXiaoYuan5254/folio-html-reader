/** Shared by the toolbar and the isolated document's annotation menu. */
export const annotationColors = [
  { value: '#d49b00', name: '黄色' },
  { value: '#d93b4b', name: '珊瑚色' },
  { value: '#087f72', name: '青色' },
  { value: '#2864d7', name: '蓝色' },
  { value: '#172033', name: '墨色' },
];
export const defaultColor = annotationColors[0].value;
export function normalizeColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}
export function isCustomColor(value: string) {
  return !annotationColors.some((color) => color.value === value.toLowerCase());
}

// Keep the native color input accessible while showing a rainbow and custom swatch.
export const colorPickerStyles = `
.custom-color{position:relative;display:inline-block;flex-shrink:0;width:22px;height:22px;border-radius:50%;background:conic-gradient(#ed334c,#efb620,#7abf32,#1cc6ad,#3684ed,#9254de,#ed334c);box-shadow:inset 0 0 0 1px #00000012;cursor:pointer}
.custom-color[data-selected=true]{outline:1px solid var(--custom-ink);outline-offset:3px}
.custom-color[data-selected=true]::after{content:'';position:absolute;inset:5px;border-radius:50%;background:var(--custom-ink);box-shadow:0 0 0 1.5px #fff;pointer-events:none}
.custom-color input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;opacity:0;cursor:pointer}
.custom-color:focus-within{outline:2px solid var(--accent,#287b71);outline-offset:3px}
`;
