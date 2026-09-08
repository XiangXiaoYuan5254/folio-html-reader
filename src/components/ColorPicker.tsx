import type { CSSProperties } from 'react';
import { colorPickerStyles, defaultColor, isCustomColor, normalizeColor } from '../colors';

export function ColorPicker({ color, onColor }: { color: string; onColor: (v: string) => void }) {
  return (
    <>
      <style>{colorPickerStyles}</style>
      <label
        className="custom-color"
        data-selected={isCustomColor(color)}
        style={{ '--custom-ink': color } as CSSProperties}
        title={`自定义颜色 · 点击打开选色盘（${color.toUpperCase()}）`}
      >
        <input
          type="color"
          aria-label="自定义颜色"
          value={normalizeColor(color) || defaultColor}
          onChange={(e) => onColor(e.currentTarget.value)}
        />
      </label>
    </>
  );
}
