import { invoke } from '../api';
import { errorText } from './client';

// Listening in a voice conversation where there is no macOS helper (Windows). The page opens
// the microphone with the browser's echo canceller on, which takes out the teacher's voice
// played here, and sends it at 16 kHz to electron/hearing.cjs; what is heard comes back as the
// helper's events. `ears` is 'local' to write it down on this computer, or a speech service.

let mic: MediaStream | null = null;
let ctx: AudioContext | null = null;
let starting = 0;

function close() {
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  void ctx?.close().catch(() => {});
  ctx = null;
}

export async function hear(on: boolean, locale: string, ears: string) {
  const attempt = ++starting;
  close();
  // The listener first: the first time, it downloads its model while the microphone waits.
  await invoke('hearing', { type: 'listen', on, locale, ears });
  if (!on || attempt !== starting) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    void invoke('hearing', { type: 'listen', on: false }).catch(() => {});
    const denied = e instanceof DOMException && e.name === 'NotAllowedError';
    throw Error(
      denied
        ? '没有麦克风权限：请在 Windows「设置 › 隐私和安全性 › 麦克风」里允许桌面应用使用麦克风'
        : `麦克风打不开：${errorText(e)}`,
    );
  }
  if (attempt !== starting) return void stream.getTracks().forEach((t) => t.stop());
  mic = stream;
  const audio = new AudioContext({ sampleRate: 16000 });
  ctx = audio;
  try {
    await audio.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
  } catch (e) {
    // Closed meanwhile by listening again or stopping.
    if (ctx !== audio) return;
    throw e;
  }
  if (ctx !== audio) return;
  const node = new AudioWorkletNode(audio, 'folio-mic', { numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) =>
    void invoke('hearing', { type: 'audio', pcm: new Uint8Array(e.data) }).catch(() => {});
  audio.createMediaStreamSource(stream).connect(node);
}

export function muteHearing(on: boolean) {
  mic?.getAudioTracks().forEach((t) => (t.enabled = !on));
  return invoke('hearing', { type: 'mute', on });
}

export function stopHearing() {
  starting++;
  close();
}
