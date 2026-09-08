export const zoomPresets = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function zoomAfterWheel(current: number, delta: number) {
  const scale = current || 1;
  const next = scale * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.002);
  return Math.round(Math.max(0.25, Math.min(4, next)) * 1000) / 1000;
}

export function zoomLabel(zoom: number) {
  return `${Math.round(zoom * 1000) / 10}%`;
}
