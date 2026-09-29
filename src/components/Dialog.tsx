import { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
export type DialogOptions = {
  title: string;
  message?: string;
  initial?: string;
  input?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (value: string) => unknown | Promise<unknown>;
  // Called when the dialog is dismissed without confirming.
  onCancel?: () => void;
};
export function Dialog({ options, onClose }: { options: DialogOptions; onClose: () => void }) {
  const [value, setValue] = useState(options.initial || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const cancel = () => {
    options.onCancel?.();
    onClose();
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) cancel();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await options.onConfirm(value);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) cancel();
        }}
      >
        <div className="dialog-heading">
          <h2 id="dialog-title">
            {options.danger ? <AlertTriangle size={19} /> : null}
            {options.title}
          </h2>
          <button type="button" className="icon-button" aria-label="取消" onClick={cancel}>
            <X size={18} />
          </button>
        </div>
        {options.message ? <p>{options.message}</p> : null}
        {options.input ? (
          <input
            ref={input}
            aria-label={options.title}
            value={value}
            required
            onChange={(e) => setValue(e.target.value)}
          />
        ) : null}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>
            取消
          </button>
          <button className={`primary-button ${options.danger ? 'danger' : ''}`} disabled={busy}>
            {busy ? '处理中…' : options.confirmLabel || '确定'}
          </button>
        </div>
      </form>
    </div>
  );
}
