import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AudioLines, Check, LoaderCircle, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { errorText } from '../ai/client';
import type { Tutor } from '../ai/board';
import {
  codexPrefix,
  hearsItself,
  listen,
  muteMicrophone,
  onHearing,
  setVoiceSettings,
  speaker,
  voicesFor,
} from '../ai/voice';
import type { Support, VoiceMode, VoiceOption } from '../ai/voice';
import type { CodexStyle } from '../ai/codex-voice';

const modes: { mode: VoiceMode; icon: typeof Mic; name: string; short: string; about: string }[] = [
  { mode: 'off', icon: VolumeX, name: '静音讲解', short: '静音', about: '只看字幕和板书' },
  {
    mode: 'speak',
    icon: Volume2,
    name: '页老师出声',
    short: '出声',
    about: '页老师边说边画，你打字提问',
  },
  {
    mode: 'talk',
    icon: AudioLines,
    name: '语音对话',
    short: '对话',
    about: '像打电话一样聊，你随时开口打断他',
  },
];

function voiceLabel(v: VoiceOption) {
  const place = /^zh[-_]TW/i.test(v.lang) ? '台湾' : /^zh[-_]HK/i.test(v.lang) ? '香港' : '';
  const grade = v.quality >= 3 ? '高级' : v.quality === 2 ? '增强' : '';
  const name = v.name.replace(/\s*[（(].*[)）]\s*$/, '');
  const notes = [place, grade].filter(Boolean).join('，');
  return notes ? `${name}（${notes}）` : name;
}

const styles: { style: CodexStyle; name: string; about: string }[] = [
  { style: 'free', name: '自由发挥', about: '用自己的话讲，像真人上课；字幕是他实际说的话' },
  { style: 'read', name: '照着念', about: '一字不差地念讲稿' },
];
const codexName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

// The button that says how the teacher talks, and the panel to change it.
export function VoiceButton({
  mode,
  voice,
  style,
  support,
  busy,
}: {
  mode: VoiceMode;
  voice: string;
  style: CodexStyle;
  support: Support | null;
  // The teacher is talking, so a sample of a voice would talk over them.
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const press = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', press, true);
    return () => document.removeEventListener('pointerdown', press, true);
  }, [open]);
  const current = modes.find((m) => m.mode === mode)!;
  const Icon = current.icon;
  const voices = support ? voicesFor(support.voices, 'zh') : [];
  const codex = support?.codex || [];
  const chosen =
    (codex.includes(voice.slice(codexPrefix.length)) && voice.startsWith(codexPrefix)
      ? voice
      : '') ||
    voices.find((v) => v.id === voice)?.id ||
    voices[0]?.id;
  const usingCodex = !!chosen?.startsWith(codexPrefix);
  async function sample(id: string) {
    if (busy) return;
    const s = await speaker();
    s.hush();
    const text = '你好，我来给你讲讲这一段。';
    if (await s.prepare(`sample-${id}-${Date.now()}`, text))
      void s.say(`sample-${id}-${Date.now()}`);
  }
  return (
    <div className="wb-voice">
      <button
        ref={button}
        type="button"
        className="wb-voice-button"
        data-mode={mode}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="讲解方式：静音、页老师出声，或语音对话"
        onClick={() => setOpen(!open)}
      >
        <Icon size={15} />
        {current.short}
      </button>
      {open ? (
        <div
          ref={panel}
          className="wb-voice-panel"
          role="dialog"
          aria-label="讲解方式"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
        >
          <h4>讲解方式</h4>
          <div role="radiogroup" aria-label="讲解方式">
            {modes.map((m) => {
              const unavailable = m.mode === 'talk' && support && !support.helper;
              const MIcon = m.icon;
              return (
                <button
                  key={m.mode}
                  type="button"
                  role="radio"
                  aria-checked={m.mode === mode}
                  disabled={!!unavailable || (m.mode !== 'off' && !support)}
                  className="wb-voice-mode"
                  onClick={() => setVoiceSettings({ mode: m.mode })}
                >
                  <MIcon size={16} />
                  <span>
                    <b>{m.name}</b>
                    <small>{unavailable ? '目前只有 macOS 版可以' : m.about}</small>
                  </span>
                  {m.mode === mode ? <Check size={14} /> : null}
                </button>
              );
            })}
          </div>
          {voices.length || codex.length ? (
            <label className="wb-voice-pick">
              <span>页老师的声音</span>
              <select
                value={chosen}
                onChange={(e) => {
                  setVoiceSettings({ voice: e.target.value });
                  void sample(e.target.value);
                }}
              >
                {codex.length ? (
                  <optgroup label="ChatGPT（Codex）">
                    {codex.map((name) => (
                      <option key={name} value={codexPrefix + name}>
                        {codexName(name)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="这台电脑的声音">
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {voiceLabel(v)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          ) : support && mode !== 'off' ? (
            <p className="wb-voice-note">这台电脑上没有中文语音，页老师会用默认声音。</p>
          ) : null}
          {usingCodex ? (
            <div className="wb-voice-style" role="radiogroup" aria-label="怎么讲">
              {styles.map((s) => (
                <button
                  key={s.style}
                  type="button"
                  role="radio"
                  aria-checked={s.style === style}
                  title={s.about}
                  onClick={() => {
                    if (s.style === style) return;
                    setVoiceSettings({ style: s.style });
                    void sample(chosen);
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
          {usingCodex ? (
            <p className="wb-voice-note">
              {styles.find((s) => s.style === style)?.about}。
              {mode === 'talk'
                ? '他直接听你说话，你随时开口打断就行；你说的话会发给 ChatGPT。外放也能用，戴耳机更清楚。'
                : '声音由 ChatGPT 生成，用的是你 Codex 账号的额度。'}
            </p>
          ) : support?.helper ? (
            <p className="wb-voice-note">
              {mode === 'talk'
                ? '语音在这台电脑上识别，不上传录音。外放也能用，戴耳机更清楚。'
                : '想要更自然的声音：在「系统设置 › 辅助功能 › 朗读内容 › 系统声音」里下载“高级”中文语音。'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// A few characters in a row the teacher said, to tell the teacher's own voice coming back
// through the microphone from the student talking.
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
function echoOf(heard: string, said: string[]) {
  const h = letters(heard);
  if (h.length < 2) return false;
  const pairs = new Set<string>();
  for (const line of said) {
    const t = letters(line);
    for (let i = 0; i < t.length - 1; i++) pairs.add(t.slice(i, i + 2));
  }
  let hit = 0;
  for (let i = 0; i < h.length - 1; i++) if (pairs.has(h.slice(i, i + 2))) hit++;
  return hit / (h.length - 1) >= 0.8;
}
// Recognition puts spaces around Chinese punctuation and between Chinese and English.
const tidy = (s: string) =>
  s
    .replace(/\s+([，。！？、；：,.!?])/g, '$1')
    .replace(/([，。！？、；：])\s+/g, '$1')
    .trim();
// Sounds that aren't a question.
const filler = /^(嗯+|呃+|啊+|哦+|噢+|额+|唔+|hmm+|uh+|um+)$/i;
// Telling the teacher to go on.
const goOn =
  /^(嗯+|哦+|噢+|好+的?|好吧|对+|是的?|行|可以|明白了?|懂了?|知道了|收到|继续(讲|吧)?|接着(讲|说)?|你(接着|继续)(讲|说)?吧?|ok(ay)?)$/i;

type Status = 'starting' | 'installing' | 'on' | 'off';

// Listening in a voice conversation: what the student says goes to the teacher when they
// stop, and starting to talk while the teacher is talking makes them stop and listen.
export function Listening({
  tutor,
  locale,
  onSay,
  onCutIn,
  onError,
}: {
  tutor: Tutor;
  locale: string;
  onSay: (text: string) => void;
  onCutIn: (cut: boolean) => void;
  onError: (text: string) => void;
}) {
  const [status, setStatus] = useState<Status>('starting');
  const [heard, setHeard] = useState('');
  const [talking, setTalking] = useState(false);
  const [muted, setMuted] = useState(false);
  const meter = useRef<HTMLSpanElement>(null);
  // Latest props, for the event handler that lives as long as listening does.
  const props = useRef({ tutor, onSay, onCutIn, onError });
  props.current = { tutor, onSay, onCutIn, onError };

  useEffect(() => {
    let cut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // When the helper quits, listening starts again with a new one, a few times a minute.
    let restarts: number[] = [];
    let again: ReturnType<typeof setTimeout> | null = null;
    const start = () =>
      listen(true, locale).catch((err) => {
        setStatus('off');
        props.current.onError(errorText(err));
      });
    const setCut = (on: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (cut === on) return;
      cut = on;
      props.current.onCutIn(on);
    };
    // What the teacher just said, which may come back through the microphone.
    const recent = () =>
      props.current.tutor
        .get()
        .transcript.filter((l) => l.who === 'teacher')
        .slice(-2)
        .map((l) => l.text);
    const off = onHearing((e) => {
      const { tutor } = props.current;
      switch (e.type) {
        case 'listening':
          setStatus(e.on ? 'on' : 'off');
          break;
        case 'installing':
          setStatus('installing');
          break;
        case 'level':
          meter.current?.style.setProperty('--level', String(e.v));
          setTalking(e.talking);
          break;
        case 'heard': {
          const s = tutor.get();
          const words = letters(e.text);
          // A ChatGPT voice cancels its own echo and stops talking by itself: only the
          // board pauses.
          const natively = hearsItself();
          const echo = !natively && echoOf(e.text, recent());
          setHeard(echo ? '' : tidy(e.text));
          // The teacher stops as soon as the student is clearly saying something.
          if (
            !cut &&
            s.phase === 'teaching' &&
            !s.paused &&
            words.length >= 2 &&
            !filler.test(words) &&
            !echo
          ) {
            tutor.pause(!natively);
            setCut(true);
          }
          // Nothing more heard: they weren't talking to the teacher after all.
          if (cut) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              setCut(false);
              setHeard('');
              tutor.resume();
            }, 5000);
          }
          break;
        }
        case 'utterance': {
          setHeard('');
          const wasCut = cut;
          setCut(false);
          const words = letters(e.text);
          const echo = !hearsItself() && echoOf(e.text, recent());
          if (echo || filler.test(words) || (wasCut && goOn.test(words))) {
            if (wasCut) tutor.resume();
            return;
          }
          props.current.onSay(tidy(e.text));
          break;
        }
        case 'error':
          props.current.onError(e.message);
          break;
        case 'exit': {
          setHeard('');
          setCut(false);
          const now = Date.now();
          restarts = restarts.filter((t) => now - t < 60_000);
          if (restarts.length >= 3) {
            setStatus('off');
            break;
          }
          restarts.push(now);
          setStatus('starting');
          again = setTimeout(start, 600);
          break;
        }
      }
    });
    void start();
    return () => {
      off();
      if (timer) clearTimeout(timer);
      if (again) clearTimeout(again);
      if (cut) props.current.onCutIn(false);
      void listen(false).catch(() => {});
    };
  }, [locale]);

  const note =
    status === 'installing'
      ? '正在下载语音识别模型，第一次会慢一点…'
      : status === 'starting'
        ? '正在打开麦克风…'
        : status === 'off'
          ? '麦克风没有打开'
          : muted
            ? '麦克风已关，点左边的按钮再打开'
            : heard
              ? ''
              : '在听，直接说话就行';
  return (
    <div className="wb-listen" data-status={status} data-talking={(talking && !muted) || undefined}>
      <button
        type="button"
        className="wb-mic"
        aria-pressed={!muted}
        aria-label={muted ? '打开麦克风' : '关上麦克风'}
        title={muted ? '打开麦克风' : '暂时关上麦克风'}
        disabled={status !== 'on'}
        onClick={() => {
          setMuted(!muted);
          setHeard('');
          void muteMicrophone(!muted).catch(() => {});
        }}
      >
        <span ref={meter} className="wb-mic-level" style={{ '--level': 0 } as CSSProperties} />
        {status === 'starting' || status === 'installing' ? (
          <LoaderCircle className="spin" size={15} />
        ) : muted || status === 'off' ? (
          <MicOff size={15} />
        ) : (
          <Mic size={15} />
        )}
      </button>
      {heard ? (
        <p className="wb-heard" aria-live="polite">
          <b>你</b>
          {heard}
        </p>
      ) : (
        <p className="wb-heard wb-heard-note">{note}</p>
      )}
    </div>
  );
}
