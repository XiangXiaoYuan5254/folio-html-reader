import { useSyncExternalStore } from 'react';
import { invoke, isDesktop, subscribe } from '../api';
import { plainText } from './board';
import { currentAiConfig, errorText } from './client';
import { codexVoice } from './codex-voice';
import { hear, muteHearing, stopHearing } from './page-hearing';
import type { CloudVoice } from './types';

// How the whiteboard teacher talks: silently with captions, out loud while the student
// types, or in a voice conversation where the student talks too and can cut in. On macOS a
// helper process does the speaking and listening on this computer (electron/speech.cjs).
// Elsewhere (Windows) the page's own speech synthesis speaks, and the page's microphone is
// listened to by electron/hearing.cjs: written down on this computer, or by a speech service
// the student has a key for (`ears`). With a Codex login the teacher can be one of ChatGPT's
// voices instead, which also does its own listening (codex-voice.ts). With a speech
// service's key (通义百炼, 豆包语音, MiniMax) it can read its script in one of that service's
// voices, made in electron/cloud-voice.cjs and played like the system's.

export type VoiceMode = 'off' | 'speak' | 'talk';
export type VoiceOption = {
  id: string;
  name: string;
  lang: string;
  // 1 default, 2 enhanced, 3 premium.
  quality: number;
  // Voices made for fun (whispering, robots, cartoon grandparents), not for teaching.
  novelty?: boolean;
};

// `voice` is a system voice's id, `codex:<name>` for a ChatGPT voice, which says the script
// in its own words, or `cloud:<service>:<voice>` for a speech service's voice. `ears`: who writes down what the
// student says where the page listens, 'local' or a speech service.
type Settings = { mode: VoiceMode; voice: string; ears: string };
export const codexPrefix = 'codex:';
export const cloudPrefix = 'cloud:';
const settingsKey = 'folio.board-voice';
function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null');
    const mode = ['off', 'speak', 'talk'].includes(saved?.mode) ? saved.mode : 'off';
    return {
      mode,
      voice: typeof saved?.voice === 'string' ? saved.voice : '',
      ears: typeof saved?.ears === 'string' ? saved.ears : 'local',
    };
  } catch {
    return { mode: 'off', voice: '', ears: 'local' };
  }
}
let settings = loadSettings();
const settingsListeners = new Set<() => void>();
export function setVoiceSettings(patch: Partial<Settings>) {
  const before = settings;
  settings = { ...settings, ...patch };
  // A sentence on its way in the old voice is not finished in the new one, and the one
  // that listened stops.
  if (settings.voice !== before.voice) {
    codex.hush();
    if (chosen) void chosen.then((s) => s.hush());
    const was = before.voice.startsWith(codexPrefix);
    if (was !== settings.voice.startsWith(codexPrefix)) {
      if (was) {
        void codex.listen(false);
        // It would go on with what it was saying until its session ends.
        codex.stop();
      } else if (known?.hearing) void hear(false, '', '').catch(() => {});
      else if (isDesktop) void invoke('speech-listen', { on: false }).catch(() => {});
    }
  }
  // A ChatGPT voice goes on talking until its session ends.
  if (settings.mode === 'off' && before.mode !== 'off') codex.stop();
  try {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  } catch {}
  settingsListeners.forEach((l) => l());
}
export function useVoiceSettings() {
  return useSyncExternalStore(
    (l) => {
      settingsListeners.add(l);
      return () => settingsListeners.delete(l);
    },
    () => settings,
  );
}

// What this computer can do: the helper speaks and listens; without it the page speaks and,
// with `hearing`, the page's microphone is listened to. `codex` are the ChatGPT voices a
// Codex login offers.
export type Support = { helper: boolean; hearing: boolean; voices: VoiceOption[]; codex: string[] };
let support: Promise<Support> | null = null;
function pageVoices(): Promise<VoiceOption[]> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([]);
  const list = () =>
    speechSynthesis
      .getVoices()
      .filter((v) => /^(zh|en)/i.test(v.lang))
      .map((v) => ({
        id: v.voiceURI,
        name: v.name,
        lang: v.lang,
        quality: /natural|premium|neural|online/i.test(v.name) ? 2 : 1,
      }));
  if (speechSynthesis.getVoices().length) return Promise.resolve(list());
  // Voices load after the page does.
  return new Promise((resolve) => {
    const done = () => resolve(list());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}
async function codexVoices() {
  try {
    const status = await invoke('ai-codex-status');
    return status?.account ? await invoke<string[]>('codex-voice', { type: 'voices' }) : [];
  } catch {
    return [];
  }
}
export function speechSupport(): Promise<Support> {
  const page = async () => ({
    helper: false,
    hearing: false,
    voices: await pageVoices(),
    codex: [],
  });
  return (support ||= (
    isDesktop
      ? invoke<Omit<Support, 'codex'>>('speech-voices')
          .then(async (s) => {
            console.debug('[voice] helper voices', Math.round(performance.now())); // DEBUG
            return s;
          })
          .then(async (s) => ({
            ...s,
            voices: s.helper ? s.voices : await pageVoices(),
            codex: await codexVoices(),
          }))
      : page()
  )
    .catch(page)
    .then((s) => {
      console.debug('[voice] support', Math.round(performance.now()), s.codex.join(',')); // DEBUG
      return (known = s);
    }));
}
export function useSpeechSupport() {
  return useSyncExternalStore(
    (l) => {
      void speechSupport().then((s) => {
        known = s;
        l();
      });
      return () => {};
    },
    () => known,
  );
}
let known: Support | null = null;

const hasHan = (s: string) => /\p{Script=Han}/u.test(s);
// The voices for a language, best first: the reader's pick, then the finest the system has,
// mainland Chinese before other Chinese.
export function voicesFor(voices: VoiceOption[], lang: 'zh' | 'en') {
  const rank = (v: VoiceOption) =>
    (v.novelty ? 0 : 100) +
    v.quality * 10 +
    (lang === 'zh' ? (/^zh[-_]CN/i.test(v.lang) ? 5 : 0) : /^en[-_]US/i.test(v.lang) ? 5 : 0) +
    (/tingting|婷婷|lili|yu-?shu|samantha|ava|xiaoxiao|huihui/i.test(v.name) ? 2 : 0);
  return voices
    .filter((v) => v.lang.toLowerCase().startsWith(lang))
    .sort((a, b) => rank(b) - rank(a));
}
function voiceFor(text: string, voices: VoiceOption[]) {
  if (hasHan(text)) {
    const own = voicesFor(voices, 'zh');
    return own.find((v) => v.id === settings.voice) || own[0];
  }
  return voicesFor(voices, 'en')[0];
}

// Formulas read out in words: the teacher is asked to speak them that way, but sometimes
// writes $x^2$ in a sentence anyway.
const greek: Record<string, string> = {
  alpha: '阿尔法',
  beta: '贝塔',
  gamma: '伽马',
  delta: '德尔塔',
  epsilon: '艾普西龙',
  theta: '西塔',
  lambda: '兰姆达',
  mu: '缪',
  pi: '派',
  sigma: '西格玛',
  omega: '欧米伽',
  phi: '斐',
};
function mathWords(tex: string, zh: boolean) {
  let s = tex;
  for (let i = 0; i < 3; i++)
    s = s
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, zh ? '$2分之$1' : '$1 over $2')
      .replace(/\\sqrt\{([^{}]*)\}/g, zh ? '根号$1' : 'root $1');
  if (zh)
    s = s
      .replace(/\^\{?2\}?/g, '的平方')
      .replace(/\^\{?3\}?/g, '的立方')
      .replace(/\^\{?(?:\\top|T)\}?/g, '的转置')
      .replace(/\^\{([^{}]*)\}|\^(\w)/g, (_, a, b) => `的${a ?? b}次方`)
      .replace(/\\(?:times|cdot)/g, '乘')
      .replace(/\\div/g, '除以')
      .replace(/\\leq?/g, '小于等于')
      .replace(/\\geq?/g, '大于等于')
      .replace(/\\neq?/g, '不等于')
      .replace(/\\(?:to|rightarrow)/g, '趋于')
      .replace(/\\([a-z]+)/gi, (m, name: string) => greek[name.toLowerCase()] ?? m)
      .replace(/(\S)\s*=\s*/g, '$1等于')
      .replace(/(\S)\s*\+\s*/g, '$1加')
      .replace(/(\w)\s*-\s*(?=\w)/g, '$1减');
  return s
    .replace(/_\{([^{}]*)\}|_(\w)/g, (_, a, b) => ` ${a ?? b}`)
    .replace(/\\[a-z]+/gi, ' ')
    .replace(/[{}^\\$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function spoken(text: string) {
  const zh = hasHan(text);
  return plainText(text)
    .replace(/\$([^$\n]+?)\$|\\\((.+?)\\\)/g, (_, a, b) => mathWords(a ?? b, zh))
    .replace(/\*\*|`/g, '')
    .replace(/\s*(?:->|→|=>)\s*/g, zh ? '，到' : ' to ');
}

// How a sentence is made: `keep` is given its sound (16-bit samples) to keep with the board,
// from a speech service or recorded from a voice that teaches in its own words, with what
// that one actually `said`; `local` says it in a system voice whatever voice is chosen.
export type Prepare = {
  keep?: (pcm: Uint8Array, rate: number, said?: string) => void;
  local?: boolean;
};
// Says the teacher's sentences. A sentence is prepared as soon as it arrives, so the next
// one is ready when the one before ends.
export type Speaker = {
  // Says sentences as it makes them, so how long one takes is known only once it is said:
  // `prepare` guesses, and `say` resolves when it has been said.
  live?: boolean;
  // A speech service's voice: each sentence is a paid request, of which the service allows
  // only so many a minute, so a sentence can take a while to come.
  service?: boolean;
  // Resolves with how long saying it takes at normal speed, in ms; 0 when it can't be said.
  prepare(id: string, text: string, how?: Prepare): Promise<number>;
  // Resolves once it has been said, or was hushed.
  say(id: string): Promise<void>;
  // What was actually said for a sentence played again, when a voice that teaches in its
  // own words said it: the caption shows that rather than the script.
  said?(id: string): string;
  // For a live voice: resolves once it has started on the sentence (or gone past it).
  started?(id: string): Promise<void>;
  pause(): void;
  resume(): void;
  // Stops talking and forgets what was prepared.
  hush(): void;
  speed(rate: number): void;
  // Gets ready to speak, ahead of the first sentence.
  warm?(): void;
  // For a voice that teaches in its own words, what goes on around the sentences: what the
  // board shows with one, what the student asked (or what the lesson is about, at the
  // start), and that the reply is complete.
  note?(id: string, text: string): void;
  asked?(question: string, how: 'start' | 'typed' | 'spoken'): void;
  ended?(): void;
  // What it is saying as it says it, and each thing it said once finished.
  onSpeech?(listener: (text: string, final: boolean) => void): () => void;
};

function helperSpeaker(): Speaker {
  const ready = new Map<string, (ms: number) => void>();
  const done = new Map<string, () => void>();
  const settle = () => {
    ready.forEach((r) => r(0));
    done.forEach((d) => d());
    ready.clear();
    done.clear();
  };
  subscribe((e) => {
    if (e.type !== 'speech') return;
    const ev = e.event;
    if (ev.type === 'ready' || ev.type === 'fail') {
      ready.get(ev.id)?.(ev.type === 'ready' ? ev.ms : 0);
      ready.delete(ev.id);
    } else if (ev.type === 'done') {
      done.get(ev.id)?.();
      done.delete(ev.id);
    } else if (ev.type === 'exit') settle();
  });
  const send = (command: Record<string, unknown>) => invoke('speech', command);
  return {
    prepare(id, text, how = {}) {
      return new Promise((resolve) => {
        ready.set(id, resolve);
        // Made by the service and handed to the helper, which says it was ready.
        if (!how.local && usingCloud())
          return void invoke<{ pcm: Uint8Array; rate: number } | true | null>('cloud-voice', {
            id,
            text: spoken(text),
            voice: settings.voice,
            to: 'helper',
            keep: !!how.keep,
          }).then(
            (sound) => {
              if (sound && sound !== true) how.keep?.(sound.pcm, sound.rate);
            },
            (err) => {
              ready.get(id)?.(0);
              ready.delete(id);
              report(errorText(err));
            },
          );
        void speechSupport()
          .then(({ voices }) =>
            send({ type: 'prepare', id, text, voice: voiceFor(text, voices)?.id }),
          )
          .catch(() => resolve(0));
      });
    },
    say(id) {
      return new Promise((resolve) => {
        done.set(id, resolve);
        void send({ type: 'say', id }).catch(() => resolve());
      });
    },
    pause: () => void send({ type: 'pause' }).catch(() => {}),
    resume: () => void send({ type: 'resume' }).catch(() => {}),
    hush() {
      settle();
      void send({ type: 'hush' }).catch(() => {});
    },
    speed: (rate) => void send({ type: 'speed', rate }).catch(() => {}),
  };
}

// Sounds made beforehand, played in the page one at a time; each is let go once played.
function player() {
  const done = new Set<() => void>();
  let playing: HTMLAudioElement | null = null;
  let rate = 1;
  return {
    play(url: string) {
      return new Promise<void>((resolve) => {
        const audio = new Audio(url);
        audio.preservesPitch = true;
        audio.playbackRate = rate;
        playing = audio;
        const end = () => {
          done.delete(end);
          if (playing === audio) playing = null;
          URL.revokeObjectURL(url);
          resolve();
        };
        done.add(end);
        audio.onended = audio.onerror = end;
        audio.play().catch(end);
      });
    },
    pause: () => playing?.pause(),
    resume: () => void playing?.play().catch(() => {}),
    stop() {
      playing?.pause();
      [...done].forEach((d) => d());
    },
    speed(r: number) {
      rate = r;
      if (playing) playing.playbackRate = r;
    },
  };
}

// The page's speech synthesis, where there is no helper. It can't say how long a sentence
// takes beforehand, so that is guessed. A speech service's sentences play as audio.
function pageSpeaker(): Speaker {
  const texts = new Map<string, string>();
  const sounds = new Map<string, string>();
  const done = new Set<() => void>();
  const audio = player();
  let rate = 1;
  return {
    async prepare(id, text, how = {}) {
      if (how.local || !usingCloud()) {
        texts.set(id, text);
        return hasHan(text) ? text.length * 220 : text.length * 70;
      }
      try {
        const sound = await cloudSound(text, settings.voice);
        if (!sound) return 0;
        sounds.set(id, sound.url);
        how.keep?.(sound.pcm, sound.rate);
        return sound.ms;
      } catch (err) {
        report(errorText(err));
        return 0;
      }
    },
    say(id) {
      const url = sounds.get(id);
      sounds.delete(id);
      if (url) return audio.play(url);
      const text = texts.get(id);
      texts.delete(id);
      if (!text || typeof speechSynthesis === 'undefined') return Promise.resolve();
      return speechSupport().then(
        ({ voices }) =>
          new Promise<void>((resolve) => {
            const u = new SpeechSynthesisUtterance(text);
            const id = voiceFor(text, voices)?.id;
            const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === id);
            if (voice) u.voice = voice;
            u.lang = voice?.lang || (hasHan(text) ? 'zh-CN' : 'en-US');
            u.rate = rate;
            const end = () => {
              done.delete(end);
              resolve();
            };
            done.add(end);
            u.onend = u.onerror = end;
            speechSynthesis.speak(u);
          }),
      );
    },
    pause() {
      audio.pause();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.pause();
    },
    resume() {
      audio.resume();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume();
    },
    hush() {
      texts.clear();
      sounds.forEach((url) => URL.revokeObjectURL(url));
      sounds.clear();
      audio.stop();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      [...done].forEach((d) => d());
      if (isDesktop) void invoke('cloud-voice-hush').catch(() => {});
    },
    speed(r) {
      rate = r;
      audio.speed(r);
    },
  };
}

// Whether the teacher reads in a speech service's voice whose key is there.
function usingCloud() {
  if (!settings.voice.startsWith(cloudPrefix)) return false;
  const service = settings.voice.split(':')[1];
  return !!currentAiConfig()?.speech?.some((s) => s.id === service && s.hasKey);
}
// A sentence said by a speech service, to play in the page: null when the teacher was
// hushed while it was made. `key` is one the settings are trying before it is saved.
async function cloudSound(text: string, voice: string, key?: string) {
  const sound = await invoke<{ pcm: Uint8Array; rate: number } | null>('cloud-voice', {
    text: spoken(text),
    voice,
    to: 'page',
    ...(key ? { key } : {}),
  });
  if (!sound) return null;
  const { pcm, rate } = sound;
  const head = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  head.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVEfmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  ascii(36, 'data');
  head.setUint32(40, pcm.length, true);
  return {
    url: URL.createObjectURL(new Blob([head, pcm as BlobPart], { type: 'audio/wav' })),
    ms: (pcm.length / 2 / rate) * 1000,
    pcm,
    rate,
  };
}
// Says hello in one of a speech service's voices, for the settings to try a key and a voice.
export async function tryCloudVoice(service: string, v: CloudVoice, key?: string) {
  const hello = v.named
    ? `你好呀，我是${v.name}，有什么不懂的都可以问我哦！`
    : '你好呀，有什么不懂的都可以问我哦！';
  const sound = await cloudSound(hello, `${cloudPrefix}${service}:${v.id}`, key);
  if (!sound) return;
  const audio = new Audio(sound.url);
  audio.onended = audio.onerror = () => URL.revokeObjectURL(sound.url);
  await audio.play();
}

// Something went wrong with the voice that the student should know about.
const problems = new Set<(message: string) => void>();
export function onVoiceProblem(listener: (message: string) => void) {
  problems.add(listener);
  return () => void problems.delete(listener);
}
// Told once, not for every sentence that fails the same way.
let lastProblem = { message: '', at: 0 };
function report(message: string) {
  const now = Date.now();
  if (message === lastProblem.message && now - lastProblem.at < 60_000) return;
  lastProblem = { message, at: now };
  problems.forEach((l) => l(message));
}
const codex = codexVoice(
  // No ChatGPT voice chosen: none, rather than a system voice's id cut short.
  () => (settings.voice.startsWith(codexPrefix) ? settings.voice.slice(codexPrefix.length) : ''),
  plainText,
  (message) => problems.forEach((l) => l(message)),
);
// Whether the teacher speaks in a ChatGPT voice.
const usingCodex = () => settings.voice.startsWith(codexPrefix) && !!known?.codex.length;

let chosen: Promise<Speaker> | null = null;
const systemSpeaker = () =>
  speechSupport().then(
    (support) => (chosen ||= Promise.resolve(support.helper ? helperSpeaker() : pageSpeaker())),
  );
export function speaker(): Promise<Speaker> {
  // Whether a ChatGPT voice is there is known once the support is.
  return speechSupport().then(() => (usingCodex() ? codex : systemSpeaker()));
}
// Says a lesson again: the sentences kept from a speech service's voice play as they were
// said, and the others are said in a system voice, so watching it again costs nothing.
export function replayVoice(
  load: (text: string) => Promise<{ url: string; ms: number; said?: string } | null>,
): Speaker {
  const sounds = new Map<string, string>();
  const words = new Map<string, string>();
  const audio = player();
  let hushes = 0;
  return {
    async prepare(id, text) {
      const at = hushes;
      const sound = await load(text).catch(() => null);
      if (at !== hushes) {
        if (sound) URL.revokeObjectURL(sound.url);
        return 0;
      }
      if (sound) {
        sounds.set(id, sound.url);
        if (sound.said) words.set(id, sound.said);
        return sound.ms;
      }
      return (await systemSpeaker()).prepare(id, text, { local: true });
    },
    said(id) {
      const said = words.get(id) || '';
      words.delete(id);
      return said;
    },
    say(id) {
      const url = sounds.get(id);
      sounds.delete(id);
      return url ? audio.play(url) : systemSpeaker().then((s) => s.say(id));
    },
    pause() {
      audio.pause();
      void systemSpeaker().then((s) => s.pause());
    },
    resume() {
      audio.resume();
      void systemSpeaker().then((s) => s.resume());
    },
    hush() {
      hushes++;
      sounds.forEach((url) => URL.revokeObjectURL(url));
      sounds.clear();
      words.clear();
      audio.stop();
      void systemSpeaker().then((s) => s.hush());
    },
    speed(rate) {
      audio.speed(rate);
      void systemSpeaker().then((s) => s.speed(rate));
    },
  };
}
// The speaker, usable before it is known which one this computer has: a lesson that starts
// at once is said from its first sentence.
export const voice: Speaker = {
  get live() {
    return usingCodex();
  },
  get service() {
    return !usingCodex() && usingCloud();
  },
  prepare: (id, text, how) => speaker().then((s) => s.prepare(id, text, how)),
  say: (id) => speaker().then((s) => s.say(id)),
  started: (id) => speaker().then((s) => s.started?.(id)),
  pause: () => void speaker().then((s) => s.pause()),
  resume: () => void speaker().then((s) => s.resume()),
  hush: () => void speaker().then((s) => s.hush()),
  speed: (rate) => void speaker().then((s) => s.speed(rate)),
  warm: () => void speaker().then((s) => s.warm?.()),
  note: (id, text) => void speaker().then((s) => s.note?.(id, text)),
  asked: (question, how) => void speaker().then((s) => s.asked?.(question, how)),
  ended: () => void speaker().then((s) => s.ended?.()),
  // Only a ChatGPT voice says things of its own.
  onSpeech: (listener) => codex.onSpeech!(listener),
};

// Whether this computer can hold a voice conversation in this voice: a ChatGPT voice listens
// itself; the others need the helper or the page's microphone.
export function canTalk(support: Support, voice: string) {
  return (
    support.helper ||
    support.hearing ||
    (voice.startsWith(codexPrefix) && support.codex.includes(voice.slice(codexPrefix.length)))
  );
}
// Speech services with a key that can write down what the student says.
export const listeners = () => (currentAiConfig()?.speech || []).filter((s) => s.hears && s.hasKey);
// Who writes it down where the page listens: the chosen service while its key is there.
export const earsInUse = () =>
  listeners().some((s) => s.id === settings.ears) ? settings.ears : 'local';
// Which one listens, so listening starts afresh when that changes.
export const listener = () =>
  usingCodex() ? 'codex' : known?.hearing ? `page-${earsInUse()}` : 'helper';

// Listening, in a voice conversation: the helper or the page's microphone, or a ChatGPT
// voice hears the student itself, and stops talking when they start the way a person does.
export type Hearing =
  | { type: 'listening'; on: boolean }
  | { type: 'installing'; progress?: number }
  | { type: 'level'; v: number; talking: boolean }
  | { type: 'heard'; text: string }
  | { type: 'utterance'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit' };
export const hearsItself = () => usingCodex();
export function onHearing(listener: (e: Hearing) => void) {
  const off = subscribe((e) => {
    if (
      e.type === 'speech' &&
      !usingCodex() &&
      ['listening', 'installing', 'level', 'heard', 'utterance', 'error', 'exit'].includes(
        e.event?.type,
      )
    )
      listener(e.event);
  });
  const offCodex = codex.onHearing((e) => usingCodex() && listener(e));
  return () => {
    off();
    offCodex();
  };
}
export async function listen(on: boolean, locale = 'zh-CN') {
  const support = await speechSupport();
  if (usingCodex()) return codex.listen(on);
  if (support.hearing) return hear(on, locale, earsInUse());
  return invoke('speech-listen', { on, locale });
}
export const muteMicrophone = (on: boolean) =>
  usingCodex()
    ? Promise.resolve(codex.mute(on))
    : known?.hearing
      ? muteHearing(on)
      : invoke('speech', { type: 'mute', on });
export const stopSpeech = () => {
  codex.forget();
  stopHearing();
  return invoke('speech-stop').catch(() => {});
};
