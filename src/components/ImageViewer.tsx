import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// A picture shown over the window; a click or Escape closes it.
export function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  // A long picture (a whole whiteboard) is shown at full width and scrolls.
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return createPortal(
    <div
      className={`image-viewer${tall ? ' tall' : ''}`}
      role="dialog"
      aria-label="查看图片"
      onClick={onClose}
    >
      <img
        src={src}
        alt=""
        onLoad={(e) =>
          setTall(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth * 1.6)
        }
      />
    </div>,
    document.body,
  );
}
