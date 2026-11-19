import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryView, PaperDialog, type PaperTarget } from './LibraryView';
import { isPaperFile } from './shared';
import { reloadLibrary, useToast } from './store';
// 页间's own look: its themes, its buttons, menus and dialogs, then the library's.
import '../../../src/themes.css';
import '../../../src/styles.css';
import '../../../src/theme-styles.css';
import './library.css';

// The page wears the theme 页间 wears.
folio.on('theme', (t: { dark: boolean; accent: string; id: string; bold?: boolean }) => {
  const root = document.documentElement;
  root.dataset.theme = t.id || (t.dark ? 'night' : 'default');
  root.dataset.scheme = t.dark ? 'dark' : 'light';
  root.dataset.style = t.bold ? 'bold' : 'classic';
});

function Page() {
  const [dialog, setDialog] = useState<PaperTarget | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const toast = useToast();
  useEffect(() => {
    void reloadLibrary();
    // What the background script asks of the page: a paper's record, or adding a document
    // (chosen in the file tree's menu).
    return folio.on('request', (data: any) => {
      if (typeof data?.edit === 'string') setDialog({ id: data.edit });
      else if (data?.add && typeof data.add.title === 'string') setDialog({ draft: data.add });
    });
  }, []);
  // The project's documents, to tie to a paper: read when the dialog opens.
  useEffect(() => {
    if (!dialog) return;
    void folio.documents
      .list()
      .then((all) => setFiles(all.filter((f) => isPaperFile(f.kind)).map((f) => f.path)))
      .catch(() => setFiles([]));
  }, [dialog]);
  return (
    <>
      <LibraryView
        onEdit={(id) => setDialog({ id })}
        onNew={() => setDialog({ draft: { title: '' } })}
      />
      {dialog ? (
        <PaperDialog
          key={JSON.stringify(dialog)}
          target={dialog}
          files={files}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {toast ? (
        <div key={toast.id} className={`library-toast${toast.error ? ' error' : ''}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
