import { useEffect, useState } from 'react';
import { invoke, isDesktop, subscribe } from '../api';

export function useFocusMode(onError: (message: string) => void) {
  const [enabled, setEnabled] = useState(false);
  const [toolsVisible, setToolsVisible] = useState(false);
  useEffect(() => {
    if (!isDesktop) return;
    void invoke('focus-mode', { enabled }).catch((error: Error) => {
      setEnabled(false);
      onError(error.message);
    });
  }, [enabled, onError]);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'focus-ended') setEnabled(false);
      }),
    [],
  );
  useEffect(() => setToolsVisible(false), [enabled]);
  return { enabled, setEnabled, toolsVisible, setToolsVisible };
}
