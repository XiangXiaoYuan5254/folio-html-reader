export function penCursor(color: string) {
  const ink = /^#[\da-f]{6}$/i.test(color) ? color : '#334155';
  const ticks = 'M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g fill="none" stroke-linecap="round">
      <circle cx="16" cy="16" r="10" stroke="white" stroke-width="3.5" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/>
      <circle cx="16" cy="16" r="10" stroke="${ink}" stroke-width="1.8" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/>
      <path d="${ticks}" stroke="white" stroke-width="3.8"/>
      <path d="${ticks}" stroke="#20262e" stroke-width="2"/>
    </g>
    <circle cx="16" cy="16" r="2.5" fill="${ink}" stroke="white" stroke-width=".7"/>
  </svg>`;
  // The center dot is the hotspot; the ring remains clear of the actual ink point.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
}
