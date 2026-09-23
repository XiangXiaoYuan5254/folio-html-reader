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
    // Source mode always previews the draft: previews carry source offsets for picking.
    live?: boolean;
  }
>(function DocumentReader({ doc, onError, live = false, ...props }, ref) {
  const [preview, setPreview] = useState<string | null>(null);
  const hasPreview = !!preview;
  // Depend on the previewed text only, so saving (which changes doc.source) doesn't reload it.
  const draft = live || doc.draft !== doc.source ? doc.draft : null;
  useEffect(() => {
    if (draft === null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    // Render the first preview at once; later edits wait until typing pauses.
    const timer = setTimeout(
      () => {
        invoke<string>('preview', { path: doc.path, source: draft })
          .then((url) => {
            if (!cancelled) setPreview(url);
          })
          .catch((e) => {
            if (!cancelled) onError(e.message);
          });
      },
      hasPreview ? 500 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc.path, draft, onError]);
  return (
    <ReaderFrame
      ref={ref}
      {...props}
      kind={doc.kind}
      url={preview || documentUrl(doc.path, doc.preview)}
    />
  );
});
