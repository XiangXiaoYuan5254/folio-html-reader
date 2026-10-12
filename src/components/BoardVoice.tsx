import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AudioLines, Check, LoaderCircle, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { errorText, useAiConfig } from '../ai/client';
import type { Tutor } from '../ai/board';
import {
  canTalk,
  cloudPrefix,
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

const codexName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

// The button that says how the teacher talks, and the panel to change it.
export function VoiceButton({
  mode,
  voice,
  ears,
  support,
  busy,
  onOpenSettings,
}: {
  mode: VoiceMode;
  voice: string;
  // Who writes down what the student says, where the page listens.
  ears: string;
  support: Support | null;
  // A lesson is under way, paused or not: a sample of a voice would talk over it, and
  // would drop the sentences made ahead for it.
  busy: boolean;
  // Opens the AI settings on the page for speech services' keys.
  onOpenSettings: () => void;
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
  // Speech services with a key, whose voices can read the script.
  const cloud = (useAiConfig()?.speech || []).filter((s) => s.hasKey);
  const cloudVoice = (service: string, id: string) => `${cloudPrefix}${service}:${id}`;
  const chosen =
    (codex.includes(voice.slice(codexPrefix.length)) && voice.startsWith(codexPrefix)
      ? voice
      : '') ||
    (cloud.some((s) => s.voices.some((v) => cloudVoice(s.id, v.id) === voice)) ? voice : '') ||
    voices.find((v) => v.id === voice)?.id ||
    voices[0]?.id;
  const usingCodex = !!chosen?.startsWith(codexPrefix);
  const cloudService = chosen?.startsWith(cloudPrefix)
    ? cloud.find((s) => s.id === chosen.split(':')[1])
    : undefined;
  // Where the page listens: on this computer, or a speech service with a key writes it down.
  const pageEars = mode === 'talk' && !usingCodex && !!support?.hearing;
  const listeners = cloud.filter((s) => s.hears);
  const earsService = listeners.find((s) => s.id === ears);
  const heardNote =
    mode !== 'talk' || usingCodex || !support
      ? ''
      : support.helper
        ? '你说的话在这台电脑上识别，不上传录音。外放也能用，戴耳机更清楚。'
        : (earsService
            ? `你说的话发给${earsService.name}识别，按时长计费，用的是你自己的 API Key。`
            : '你说的话用通义实验室的 SenseVoice 模型在这台电脑上识别，不上传录音；第一次要下载约 240MB 的模型。') +
          (cloudService
            ? '外放也能用，戴耳机更清楚。'
            : '用电脑自带的声音外放时，页老师的声音可能被当成你在说话，戴耳机更好。');
  async function sample(id: string) {
    if (busy) return;
    const s = await speaker();
    s.hush();
    const text = '你好，我来给你讲讲这一段。';
    const said = `sample-${id}-${Date.now()}`;
    if (await s.prepare(said, text)) void s.say(said);
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
              const unavailable = m.mode === 'talk' && support && !canTalk(support, chosen || '');
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
                    <small>{unavailable ? '这台电脑上用不了' : m.about}</small>
                  </span>
                  {m.mode === mode ? <Check size={14} /> : null}
                </button>
              );
            })}
          </div>
          {voices.length || codex.length || cloud.length ? (
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
                {cloud.map((s) => (
                  <optgroup key={s.id} label={s.name}>
                    {s.voices.map((v) => (
                      <option key={v.id} value={cloudVoice(s.id, v.id)}>
                        {v.name}（{v.about}）
                      </option>
                    ))}
                  </optgroup>
                ))}
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
            <p className="wb-voice-note">
              他按讲稿的要点用自己的话讲，像真人上课，字幕是他实际说的话。
              {mode === 'talk'
                ? '他直接听你说话，你随时开口打断就行；你说的话会发给 ChatGPT。外放也能用，戴耳机更清楚。'
                : '声音由 ChatGPT 生成，用的是你 Codex 账号的额度。'}
            </p>
          ) : cloudService ? (
            <p className="wb-voice-note">
              声音由{cloudService.name}合成，按字数计费，用的是你自己的 API Key。
            </p>
          ) : (
            <>
              {support && !cloud.length ? (
                <p className="wb-voice-note">
                  想要更像真人的声音：填一个语音服务的 API Key（通义百炼、豆包语音或 MiniMax）。
                  <button
                    type="button"
                    className="wb-voice-link"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings();
                    }}
                  >
                    去填写
                  </button>
                </p>
              ) : null}
            </>
          )}
          {pageEars && listeners.length ? (
            <label className="wb-voice-pick">
              <span>识别你说的话</span>
              <select
                value={earsService?.id || 'local'}
                onChange={(e) => setVoiceSettings({ ears: e.target.value })}
              >
                <option value="local">这台电脑（免费，不上传录音）</option>
                {listeners.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（按时长计费）
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {heardNote ? <p className="wb-voice-note">{heardNote}</p> : null}
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
// Recognition puts spaces around Chinese punctuation and between Chinese and English, and
// writes the teacher's name with a more common 叶 or 夜.
const tidy = (s: string) =>
  s
    .replace(/\s+([，。！？、；：,.!?])/g, '$1')
    .replace(/([，。！？、；：])\s+/g, '$1')
    .replace(/[叶夜]老师/g, '页老师')
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
  // How much of the speech recognition model has been downloaded, the first time.
  const [installed, setInstalled] = useState<number | null>(null);
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
          setInstalled(e.progress ?? null);
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
      ? installed === null
        ? '正在下载语音识别模型，第一次会慢一点…'
        : `正在下载语音识别模型（${Math.floor(installed * 100)}%），只有第一次需要…`
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
