export type NoteSize = { width: number; height: number };

export const STICKY_MIN_WIDTH = 180;
export const STICKY_MIN_HEIGHT = 100;
export const TEXT_MIN_WIDTH = 60;

// New text boxes reuse the width of the last one the reader resized.
export function textNoteWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(TEXT_MIN_WIDTH, Math.min(600, value))
    : 160;
}

export function stickyNoteSize(value: unknown): NoteSize {
  const size = (value && typeof value === 'object' ? value : {}) as Partial<NoteSize>;
  return {
    width:
      typeof size.width === 'number' && Number.isFinite(size.width)
        ? Math.max(STICKY_MIN_WIDTH, Math.min(600, size.width))
        : 300,
    height:
      typeof size.height === 'number' && Number.isFinite(size.height)
        ? Math.max(STICKY_MIN_HEIGHT, Math.min(800, size.height))
        : 200,
  };
}
