import { useMemo } from 'react';
import type { Annotation } from '../types';
import { inkBounds, inkPathData, inkPaths } from '../reader/ink';

export function InkThumbnail({ annotation }: { annotation: Annotation }) {
  const preview = useMemo(() => {
    const paths = inkPaths(annotation),
      bounds = inkBounds(paths);
    if (!bounds) return null;
    const width = Math.max(160, bounds.width + 24),
      height = Math.max(64, bounds.height + 24);
    return {
      viewBox: `${bounds.left - (width - bounds.width) / 2} ${bounds.top - (height - bounds.height) / 2} ${width} ${height}`,
      path: inkPathData(paths, { x: 0, y: 0 }),
    };
  }, [annotation.points, annotation.paths, annotation.type]);
  if (!preview) return null;
  return (
    <svg className="ink-thumbnail" viewBox={preview.viewBox} aria-hidden="true">
      <path
        d={preview.path}
        fill="none"
        stroke={annotation.color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
