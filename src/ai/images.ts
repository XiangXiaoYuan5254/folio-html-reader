import type { AiProvider, ModelOption } from './types';

// Pictures sent to a model: at most this many per question, none longer than this on a side.
// 1568 px is about where services start shrinking images themselves.
export const maxImages = 6;
const maxSide = 1568;
// What one picture adds to a request, for fitting a conversation into the model's window.
export const imageTokens = 1600;

// Scales a picture down and re-encodes it as JPEG, so a conversation's pictures stay small.
export async function prepareImage(source: Blob | string): Promise<string> {
  const blob = typeof source === 'string' ? blobFromDataUrl(source) : source;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d')!;
    // Transparent areas would turn black in a JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close();
  }
}
// The page's content policy doesn't let fetch() read data: URLs.
function blobFromDataUrl(url: string) {
  const [head, data] = url.split(',', 2);
  const type = head.match(/^data:([^;]+)/)?.[1] || 'image/png';
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}
export const isImageFile = (file: File) => /^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type);

// Model names that take images, and ones known to take text only. A name matching neither
// is sent anyway; the service's answer says if it can't look at pictures.
const textOnly =
  /o1-mini|o3-mini|gpt-3\.5|gpt-oss|embed|whisper|tts|rerank|deepseek(?!.*vl)|qwq|^qwen-(plus|max|turbo|flash|long|coder)|^qwen\d?(\.\d)?-coder|^glm-\d(\.\d)?(-(air|airx|flash|flashx|plus|long|x))?$|glm-z1|moonshot-v1-(8k|32k|128k|auto)$|kimi-k2(?!\.5)/i;
const sees =
  /claude|gemini|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-5|chatgpt|(^|[^\w])o[134](\b|-)|vision|[-_.:]vl|vl[-_.:\d]|vl$|qvq|omni|glm-\d(\.\d)?v|glm-4v|llava|moondream|minicpm-v|gemma-?3|pixtral|mistral-(small|medium)|llama-?4|internvl|step-\dv|grok-4|kimi-k2\.5|kimi-latest|seed-1[.-][568]|seed-2/i;
export function seesImages(
  provider: AiProvider | undefined,
  options?: ModelOption[],
): boolean | undefined {
  if (!provider?.model) return undefined;
  const reported = options?.find((m) => m.id === provider.model)?.images;
  if (typeof reported === 'boolean') return reported;
  // DeepSeek's own service offers no vision model.
  if (provider.preset === 'deepseek') return false;
  // OpenRouter names models "vendor/model".
  const model = provider.model.replace(/^.*\//, '');
  if (textOnly.test(model)) return false;
  if (sees.test(model)) return true;
  if (provider.kind === 'anthropic' || provider.kind === 'codex') return true;
  return undefined;
}
