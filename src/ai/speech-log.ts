import { invoke, isDesktop } from '../api';
import { soundKey } from './board-sound';

export async function logSpeechFailure(
  board: string,
  text: string,
  stage: string,
  message: string,
) {
  if (!isDesktop) return;
  try {
    await invoke('speech-diagnostic', { board, textHash: await soundKey(text), stage, message });
  } catch {
    /* Diagnostics must not interrupt playback. */
  }
}
