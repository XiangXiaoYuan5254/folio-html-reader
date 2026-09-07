export type NoteSize = { width: number; height: number };

export function stickyNoteSize(value: unknown): NoteSize {
  const size = (value && typeof value === 'object' ? value : {}) as Partial<NoteSize>;
  return {
    width:
      typeof size.width === 'number' && Number.isFinite(size.width)
        ? Math.max(220, Math.min(600, size.width))
        : 300,
    height:
      typeof size.height === 'number' && Number.isFinite(size.height)
        ? Math.max(130, Math.min(800, size.height))
        : 200,
  };
}
