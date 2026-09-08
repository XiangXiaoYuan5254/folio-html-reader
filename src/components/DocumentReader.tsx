import { forwardRef, useEffect, useState } from 'react';
import { documentUrl, invoke } from '../api';
import type { OpenDocument } from '../types';
import { ReaderFrame } from './ReaderFrame';
import type { ReaderHandle, ReaderProps } from './ReaderFrame';

// Each visible document owns its preview. Changing the active pane must not
// navigate either iframe or reset its scroll, selection, or in-progress edits.
export const DocumentReader = forwardRef<
  ReaderHandle,
  Omit<ReaderProps, 'url'> & {
    doc: OpenDocument;
    onError: (message: string) => void;
  }
>(function DocumentReader({ doc, onError, ...props }, ref) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (doc.draft === doc.source) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<string>('preview', { path: doc.path, source: doc.draft })
        .then((url) => {
          if (!cancelled) setPreview(url);
        })
        .catch((e) => {
          if (!cancelled) onError(e.message);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc.path, doc.draft, doc.source, onError]);
  return (
    <ReaderFrame
      ref={ref}
      {...props}
      kind={doc.kind}
      url={preview || documentUrl(doc.path, doc.preview)}
    />
  );
});
