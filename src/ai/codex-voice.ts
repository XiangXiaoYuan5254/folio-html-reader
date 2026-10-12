import { invoke, subscribe } from '../api';
import { errorText } from './client';
import type { Hearing, Speaker } from './voice';

// The whiteboard teacher as one of ChatGPT's voices, through a Codex realtime session
// (electron/ai-codex.cjs). The voice is the teacher the student talks with: in a voice
// conversation it hears the student through the microphone, and answers and is cut off the
// way a person is. It plays straight from its WebRTC connection, at full quality, where the
// browser's echo canceller knows what it is saying.
//
// What it teaches comes from the board's model, a sentence at a time as the board gets
// them: talking points, with what the board shows, handed over as soon as they are written
// so it can tell them in its own words as one explanation, at its own pace. Which sentence
// it is on is told by its words, which match that sentence more than the one before, and
// the board follows it.
//
// It isn't asked to read the script word for word: a realtime session has no way to just
// say a text, only to be told it, and a voice told to read one may still change it.

const prompt = [
  '你是页老师，一位耐心、亲切的老师，正在白板前给一位学生一对一讲课。学生叫你页老师。',
  '讲什么由备课老师决定：讲解要点和板书情况会由系统以开发者消息陆续发给你，你不需要、也不要委托别人或调用任何工具去准备内容。白板会跟着你讲到的要点一步步画出来，所以要按要点的顺序一条一条讲：讲完一条再讲下一条，不跳过、不合并，也不提前讲后面要点的内容。每条要点用你自己的话、像平时说话一样讲，可以有自然的语气词，需要时补一两句解释。讲慢一点，不管后面还有多少要点，都保持同样从容的语速，越往后越不要赶；讲到关键的地方自然地停一停，给学生反应的时间；停顿就真的停下来，不用说出“停一下”这样的话。括号里的板书说明是让你知道白板上有什么、方便你指着讲，不用照着念。',
  '学生提问或插话时，先自然地回应一两句，然后等新的要点到了再展开讲，不要自己抢先讲答案。学生只是说“嗯”“懂了”“继续”之类的话时，就接着刚才的讲下去。还没有要点时，就安静地等着。',
].join('\n\n');
// While the board's model takes long to work out an answer, the voice thinks out loud now
// and then, so the student knows it is on it: a few times at most, each differently.
const thinkingAloud = [
  '（备课老师还在准备要点。你可以自然地说一句思考中的话，比如“嗯……这个问题啊……”，短一点，不要讲具体内容，说完就等。）',
  '（要点还没到。可以再自然地说一句，比如“等一下，我再想想怎么讲更清楚……”，别重复刚才的话，也不要讲具体内容。）',
  '（还在准备。最后再说一句让学生知道你在想，比如“快好了，马上……”，然后安静地等着。）',
];
// Paused in the middle of what it was saying: the sentence it was in, from its start (or,
// for a long one, from its last pause), and what came before it.
function brokenOff(heard: string) {
  const last = (marks: string) => Math.max(...[...marks].map((c) => heard.lastIndexOf(c))) + 1;
  let cut = last('。！？!?；;');
  if (heard.length - cut > 40) cut = Math.max(cut, last('，,：:'));
  return { before: heard.slice(0, cut).trim(), broken: heard.slice(cut).trim() };
}
// What the voice is told about the pause. The words it was cut off in the middle of are
// never quoted to their broken end, which it would only finish off: the sentence is named
// by how it starts.
function pausedNote(heard: string) {
  if (!heard) return '（学生按了暂停。现在先安静地等着，等学生按继续再讲。）';
  const { before, broken } = brokenOff(heard);
  return `（学生按了暂停。${before ? `你已经讲完的是：“${before.slice(-160)}”。` : ''}${broken ? `以“${broken.slice(0, 8)}”开头的那句话你刚开始讲，还没讲完。` : ''}现在先安静地等着，等学生按继续再讲。）`;
}
// Going on the way a person does after being stopped: a word to pick up the thread, then
// the sentence that was cut off said again from its start.
function resumedNote(heard: string) {
  if (!heard) return '（学生按了继续，接着讲。）';
  const { broken } = brokenOff(heard);
  if (!broken)
    return '（学生按了继续。像真人老师一样先自然地衔接一句（比如“好，我们接着看”），再接着往下讲，讲过的不用重复。）';
  return `（学生按了继续。像真人老师被打断后那样：先自然地衔接一句（比如“好，我们接着说”），再把刚才没讲完的那句话从头完整地说一遍，也就是从“${broken.slice(0, 8)}”说起，然后照常往下讲。讲完的句子不用重复。）`;
}
// Another ChatGPT voice chosen in the middle of a lesson goes on from what the last one said,
// rather than from the start, which is all it would otherwise see of the lesson.
function switchedNote(heard: string) {
  const { before } = brokenOff(heard);
  return `（学生换了一个声音，接下来由你接着讲。${before ? `刚才已经讲完的是：“${before.slice(-160)}”。` : ''}讲过的不用重复，接着往下讲新的要点。）`;
}
// How the student can reach the teacher: part of the instructions, and told when it changes.
const modes = {
  talk: '学生可以随时开口跟你说话。',
  type: '学生只能打字提问，不能开口回答你：问学生懂没懂时，问一句就接着讲，不用等回答。',
};

export type CodexVoice = Speaker & {
  // Hears the student through the microphone, or stops.
  listen(on: boolean): Promise<void>;
  // Stops hearing the student for a while, with the microphone left open.
  mute(on: boolean): void;
  onHearing(listener: (e: Hearing) => void): () => void;
  // Closes the session.
  stop(): void;
  // Closes the session and forgets what was said, which a new session would be given.
  forget(): void;
};

type Role = 'user' | 'assistant' | 'developer';
type Session = {
  id: string;
  voice: string;
  pc: RTCPeerConnection;
  events: RTCDataChannel;
  sender: RTCRtpSender | null;
  // Sent in place of the microphone while the student isn't heard.
  silence: MediaStreamTrack | null;
  ctx: AudioContext;
  audio: HTMLAudioElement;
  level: AnalyserNode | null;
  // Whether it was told the student can talk.
  talk: boolean;
  ready: Promise<void>;
  dead: boolean;
};

// Above this the voice or the student is making a sound.
const loud = 0.01;
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
// How much of `said` (letters) is in `text`, by pairs of letters.
function overlap(said: string, text: string) {
  const t = letters(text);
  const pairs = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) pairs.add(t.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < said.length - 1; i++) if (pairs.has(said.slice(i, i + 2))) hit++;
  return said.length > 1 ? hit / (said.length - 1) : 0;
}
// The end of `text` that holds its last `n` letters.
function lastLetters(text: string, n: number) {
  let at = text.length;
  for (let count = 0; at > 0 && count < n;) if (letters(text[--at])) count++;
  return text.slice(at);
}
// Where the voice started on a sentence whose first letters ended `text`: after its last
// pause that has a few letters but not too many after it, or else where those letters begin.
function sentenceStart(text: string, fallback: number) {
  for (let i = text.length - 1; i >= 0; i--) {
    if (!'。！？!?.;；,，:：'.includes(text[i])) continue;
    const after = letters(text.slice(i + 1)).length;
    if (after > 18) break;
    if (after >= 3) return i + 1;
  }
  return fallback;
}
// Recognition spaces out Chinese characters, and a turn can begin with the end of the one
// before.
const tidy = (s: string) =>
  s
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '')
    .replace(/^[\p{P}\s]+/u, '')
    .trim();
function rms(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / data.length);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// No session now, for a reason that isn't a failure: paused, or just after one.
class NotNow extends Error {}

export function codexVoice(
  // The ChatGPT voice chosen, or none.
  voice: () => string,
  // The talking point to hand over for a sentence of the script.
  speakable: (text: string) => string,
  problem: (message: string) => void,
): CodexVoice {
  let session: Session | null = null;
  // The sentences of the reply as the board gets them; those handed to the voice; the one
  // it is saying; what it said of each; those it is done with; the board's.
  const texts = new Map<string, string>();
  let script: string[] = [];
  let given: string[] = [];
  let at = -1;
  const words = new Map<string, string>();
  const done = new Set<string>();
  const waiting = new Map<string, () => void>();
  // The board waits to draw a sentence's writing until the voice is on it.
  const starting = new Map<string, () => void>();
  const begin = (id: string) => {
    starting.get(id)?.();
    starting.delete(id);
  };
  let board = '';
  // The board's model has written the whole reply.
  let complete = false;
  // Talking points are numbered in each reply; what the board shows for one not yet told.
  let numbered = 0;
  const numbers = new Map<string, number>();
  const notes = new Map<string, string[]>();
  let outbox: string[] = [];
  let outboxTimer: ReturnType<typeof setTimeout> | null = null;
  let handing: Promise<unknown> = Promise.resolve();
  // What the voice is saying, what the student is saying, and what both have said, which a
  // session that takes over is given.
  const roles = new Map<string, Role>();
  let saying = '';
  // What the student is saying, when they last said something, and when what they said
  // was last passed on.
  let student = '';
  let studentAt = 0;
  let uttered = -Infinity;
  const history: { role: Role; text: string }[] = [];
  const speech = new Set<(text: string, final: boolean) => void>();
  const hearing = new Set<(e: Hearing) => void>();
  // Since when the board's model has been working out an answer, and how often the voice
  // has thought out loud meanwhile.
  let thinkingSince = 0;
  let thoughtAloud = 0;
  let lastThought = 0;
  let lastLoud = 0;
  let lastWord = 0;
  let lastGiven = 0;
  let lastUse = 0;
  let turnDone = 0;
  let studentTalking = false;
  let paused = false;
  let resumed = 0;
  let pausedAt = '';
  let listening = false;
  let micMuted = false;
  let mic: MediaStream | null = null;
  let micLevel: AnalyserNode | null = null;
  let micCtx: AudioContext | null = null;
  let rate = 1;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let failedAt = -Infinity;
  let complained = 0;
  const data = new Float32Array(1024);

  const now = () => performance.now();
  const emit = (e: Hearing) => hearing.forEach((l) => l(e));
  const remember = (role: Role, text: string) => {
    if (!text.trim()) return;
    history.push({ role, text: text.trim() });
    if (history.length > 40) history.splice(0, history.length - 40);
  };
  function complain(message: string) {
    if (now() - complained < 30_000) return;
    complained = now();
    problem(`ChatGPT 的声音用不了：${message}`);
  }
  const owed = () => given.some((id) => !done.has(id));

  subscribe((e) => {
    if (e.type !== 'codex-voice' || !session || e.id !== session.id) return;
    const ev = e.event;
    // It asked Codex to look into a question; the board's model answers it instead.
    if (ev?.type === 'delegated') post('（这个问题不用你去查，备课老师的要点马上就到。）');
    else if (ev?.type === 'error') fail(ev.message || '语音会话出错');
    // It ended by itself (they don't last for ever): a new one takes over if it is needed.
    else if (ev?.type === 'closed') {
      close();
      if (owed() || listening) void current().catch(() => {});
    }
  });

  function open(voice: string): Session {
    const ctx = new AudioContext();
    const pc = new RTCPeerConnection();
    const events = pc.createDataChannel('oai-events');
    const audio = new Audio();
    const s: Session = {
      id: '',
      voice,
      pc,
      events,
      sender: null,
      silence: null,
      ctx,
      audio,
      level: null,
      talk: false,
      dead: false,
      ready: null!,
    };
    let started: () => void;
    let refused: (e: Error) => void;
    const begun = new Promise<void>((resolve, reject) => {
      started = resolve;
      refused = reject;
    });
    events.onmessage = (m) => {
      let e: any;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === 'session.started') {
        // It hears nothing until the student is to be heard.
        if (!listening || micMuted) events.send(JSON.stringify({ type: 'input_audio.pause' }));
        setTimeout(started, listening ? 300 : 1500);
      } else if (e.type === 'input_audio.paused') started();
      else if (e.type === 'error') {
        refused(Error(e.error?.message || '语音会话出错'));
        if (session === s) fail(e.error?.message || '语音会话出错');
      } else if (session === s) event(e);
    };
    pc.onconnectionstatechange = () => {
      if (session === s && pc.connectionState === 'failed') fail('和 ChatGPT 的语音连接断了');
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.muted = paused;
      void audio.play().catch(() => {});
      // How loud the voice is, to hear it stop.
      s.level = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(s.level);
    };
    s.ready = (async () => {
      const silence = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator();
      const off = ctx.createGain();
      off.gain.value = 0;
      tone.connect(off).connect(silence);
      tone.start();
      s.silence = silence.stream.getAudioTracks()[0];
      const track = listening && mic ? mic.getAudioTracks()[0] : s.silence;
      s.sender = pc.addTrack(track, new MediaStream([track]));
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
        setTimeout(resolve, 2000);
      });
      // Whether the student can talk is told as it is when the session starts.
      s.talk = listening;
      const answer = await invoke<{ id: string; sdp: string }>('codex-voice', {
        type: 'start',
        sdp: pc.localDescription!.sdp,
        voice,
        prompt: `${prompt}\n\n${s.talk ? modes.talk : modes.type}`,
        history,
      });
      s.id = answer.id;
      if (s.dead) throw Error('语音会话已关闭');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await Promise.race([
        begun,
        wait(15_000).then(() => {
          throw Error('ChatGPT 的语音没有接通');
        }),
      ]);
    })();
    s.ready.catch((e) => session === s && fail(errorText(e)));
    return s;
  }
  // The session for the voice chosen now, opened if need be. A new one
  // is handed the reply from the board's sentence on.
  // `standby` opens one while paused: it is handed nothing until the student goes on.
  function current(standby = false) {
    const want = voice();
    // A system voice was chosen meanwhile: what was still on its way here isn't said.
    if (!want) {
      close();
      return Promise.reject(new NotNow());
    }
    if (session && session.voice !== want) {
      const heard = tidy(saying);
      saying = '';
      // Cut off in the middle of what it was saying, which isn't in what it said yet.
      if (heard) {
        speech.forEach((l) => l(heard, true));
        remember('developer', switchedNote(heard));
      }
      close();
    }
    if (!session) {
      if ((paused && !standby) || now() - failedAt < 15_000) return Promise.reject(new NotNow());
      // What wasn't finished is handed to the new session again.
      given = [];
      at = -1;
      numbered = 0;
      numbers.clear();
      for (const id of script) if (!done.has(id)) words.delete(id);
      session = open(want);
      ticker ||= setInterval(tick, 150);
      queueMicrotask(hand);
    }
    lastUse = now();
    const s = session;
    return s.ready.then(() => s);
  }
  function close() {
    const s = session;
    session = null;
    if (!s) return;
    s.dead = true;
    const stop = () => s.id && invoke('codex-voice', { type: 'stop', id: s.id }).catch(() => {});
    if (s.id) void stop();
    else void s.ready.catch(() => {}).then(stop);
    s.pc.close();
    s.audio.srcObject = null;
    void s.ctx.close().catch(() => {});
  }
  function fail(message: string) {
    close();
    failedAt = now();
    complain(message);
    // What was handed over won't be said; the board goes on without it.
    finishAll();
    // A voice conversation goes on in a new session, which knows what was said.
    if (listening)
      setTimeout(() => {
        if (listening && !session) void current().catch(() => {});
      }, 15_500);
  }
  const send = (s: Session, e: Record<string, unknown>) => {
    if (s.events.readyState === 'open') s.events.send(JSON.stringify(e));
  };
  // Hears the student, or not, in the session there is.
  function connectMic() {
    const s = session;
    if (!s?.sender || s.dead) return;
    const track = listening && mic ? mic.getAudioTracks()[0] : s.silence;
    void s.sender.replaceTrack(track).catch(() => {});
    send(s, { type: listening && !micMuted ? 'input_audio.resume' : 'input_audio.pause' });
  }

  // What the voice should know, sent together when several come at once. What the board
  // shows comes a line at a time and waits a little for the rest. While paused it waits.
  function post(text: string, soon = true, first = false) {
    if (first) outbox.unshift(text);
    else outbox.push(text);
    if (soon && outboxTimer) {
      clearTimeout(outboxTimer);
      outboxTimer = null;
    }
    outboxTimer ||= setTimeout(flush, soon ? 120 : 800);
  }
  function flush() {
    outboxTimer = null;
    if (paused || !outbox.length) return;
    const text = outbox.join('\n');
    outbox = [];
    remember('developer', text);
    handing = handing
      .then(() => current())
      .then((s) => invoke('codex-voice', { type: 'tell', id: s.id, text }))
      .catch((e) => e instanceof NotNow || fail(errorText(e)));
  }

  function event(e: any) {
    if (e.type === 'turn.created' && e.turn) {
      roles.set(e.turn.id, e.turn.role);
      if (e.turn.role === 'assistant') {
        turnDone = 0;
        saying = '';
        if (e.turn.transcript) voiceSaid(String(e.turn.transcript));
      } else if (e.turn.role === 'user') studentTalking = true;
    } else if (e.type === 'turn.delta' && typeof e.delta === 'string') {
      if (roles.get(e.turn_id) !== 'user') voiceSaid(e.delta);
    } else if (e.type === 'input_transcript.added' && e.item?.text) {
      studentSaid(String(e.item.text));
    } else if (e.type === 'delegation.created') {
      // It took what the student said as a question to look into, without a turn of theirs.
      const text = e.item?.content?.find((c: any) => c?.type === 'input_text')?.text;
      if (text && now() - uttered > 6000) studentDone(String(text));
    } else if (e.type === 'turn.done' && e.turn) {
      const text = tidy(String(e.turn.transcript || ''));
      if (e.turn.role === 'assistant') {
        turnDone = now();
        remember('assistant', text);
        speech.forEach((l) => l(text, true));
        saying = '';
      } else if (e.turn.role === 'user') studentDone(text);
      roles.delete(e.turn.id);
    }
  }
  function studentSaid(piece: string) {
    student += piece;
    studentAt = now();
    studentTalking = true;
    emit({ type: 'heard', text: tidy(student) });
  }
  // The student has finished saying something; it is passed on once.
  function studentDone(text?: string) {
    const said = tidy(text || student);
    student = '';
    studentTalking = false;
    if (!said || now() - uttered < 1500) return;
    uttered = now();
    remember('user', said);
    emit({ type: 'utterance', text: said });
  }
  let shown = 0;
  function voiceSaid(piece: string) {
    lastWord = lastUse = now();
    saying += piece;
    // The caption follows the voice, a few times a second.
    if (now() - shown > 150) {
      shown = now();
      speech.forEach((l) => l(tidy(saying), false));
    }
    track(piece);
  }

  // Follows the voice through the sentences it was handed: its words are put to the one it
  // is on, until its last few letters belong to a later one, maybe past one it left out.
  function track(piece: string) {
    while (at < given.length - 1 && (at < 0 || done.has(given[at]))) at++;
    const id = given[at];
    if (!id) return;
    const text = (words.get(id) || '') + piece;
    words.set(id, text);
    begin(id);
    const tail = lastLetters(text, 6);
    const t = letters(tail);
    const here = overlap(t, texts.get(id) || '');
    let next = '';
    let best = 0;
    for (const later of given.slice(at + 1, at + 4)) {
      const score = overlap(t, texts.get(later) || '');
      if (score > best) [next, best] = [later, score];
    }
    if (next && t.length >= 6 && best >= 0.6 && best >= here + 0.2) {
      const cut = sentenceStart(text, text.length - tail.length);
      words.set(id, text.slice(0, cut));
      words.set(next, text.slice(cut));
      while (given[at] !== next) finish(given[at++]);
      begin(next);
    }
    hand();
  }
  function finish(id: string) {
    if (done.has(id)) return;
    done.add(id);
    begin(id);
    const resolve = waiting.get(id);
    waiting.delete(id);
    resolve?.();
  }
  function finishAll() {
    given.forEach(finish);
    at = given.length - 1;
  }

  function tick() {
    const t = now();
    const s = session;
    if (s?.level && rms(s.level, data) > loud) lastLoud = t;
    if (micLevel && listening) {
      const v = rms(micLevel, data);
      emit({
        type: 'level',
        v: Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-6) + 60) / 50)),
        talking: studentTalking && !micMuted,
      });
    }
    // What the student said, when nothing marks its end.
    if (student && t - studentAt > 2500) studentDone();
    if (!paused) {
      const quiet = t - Math.max(lastLoud, lastWord);
      if (
        thinkingSince &&
        !owed() &&
        !studentTalking &&
        thoughtAloud < thinkingAloud.length &&
        t - thinkingSince > 7000 &&
        quiet > 6500 &&
        t - lastThought > 9000
      ) {
        post(thinkingAloud[thoughtAloud++]);
        lastThought = t;
      } else if (
        complete &&
        turnDone &&
        quiet > 2000 &&
        !studentTalking &&
        (at >= given.length - 1 || quiet > 10_000)
      ) {
        // It has told everything it was given and the reply is complete.
        turnDone = 0;
        finishAll();
      }
      // Handed sentences it never starts on.
      if (owed() && t - Math.max(lastGiven, resumed) > 15_000 && quiet > 15_000 && !studentTalking)
        finishAll();
    }
    // Nothing to say for a long while, and no one to listen to: the session closes, and
    // opens again when needed.
    if (s && !owed() && !listening && t - lastUse > 10 * 60_000) close();
    if (!session && !listening) {
      if (ticker) clearInterval(ticker);
      ticker = null;
    }
  }

  // Hands the voice the reply as it comes: the sentence it is on and the next two, enough
  // to tell them as one explanation without a backlog to hurry through.
  function hand() {
    const on = Math.max(0, script.indexOf(given[at] ?? board));
    script
      .slice(0, on + 3)
      .filter((id) => !done.has(id))
      .forEach(give);
  }
  function give(id: string) {
    if (given.includes(id)) return;
    given.push(id);
    thinkingSince = 0;
    lastGiven = now();
    const text = speakable(texts.get(id) || '');
    const n = ++numbered;
    numbers.set(id, n);
    const shown = notes.get(id);
    notes.delete(id);
    post(
      (n === 1 ? '新的讲解要点（会陆续补充，按顺序讲）：\n' : '') +
        `${n}. ${text}` +
        (shown?.length ? `\n（第 ${n} 点的板书：${shown.join('；')}）` : ''),
    );
  }
  function reset() {
    for (const resolve of waiting.values()) resolve();
    waiting.clear();
    for (const resolve of starting.values()) resolve();
    starting.clear();
    texts.clear();
    script = [];
    given = [];
    at = -1;
    words.clear();
    done.clear();
    notes.clear();
    numbers.clear();
    numbered = 0;
    board = '';
    complete = false;
    turnDone = 0;
  }

  return {
    live: true,
    prepare(id, text) {
      texts.set(id, text);
      script.push(id);
      if (!paused) void current().catch(() => {});
      hand();
      // A guess: how long it takes is known only once it has been said.
      return Promise.resolve(/\p{Script=Han}/u.test(text) ? text.length * 200 : text.length * 75);
    },
    say(id) {
      return new Promise<void>((resolve) => {
        if (!texts.has(id) || done.has(id)) return resolve();
        board = id;
        lastUse = now();
        waiting.set(id, resolve);
        hand();
      });
    },
    started(id) {
      return new Promise<void>((resolve) => {
        if (!texts.has(id) || done.has(id) || words.has(id)) return resolve();
        starting.set(id, resolve);
      });
    },
    note(id, text) {
      if (!text) return;
      const n = numbers.get(id);
      if (n) post(`（第 ${n} 点的板书：${text}）`, false);
      else notes.set(id, [...(notes.get(id) || []), text]);
    },
    asked(question, how) {
      thinkingSince = now();
      thoughtAloud = 0;
      pausedAt = '';
      const q = question.trim();
      post(
        how === 'start'
          ? `学生想听你讲：${q}\n（备课老师正在准备要点，马上就到。可以先自然地开个头，等要点到了再讲。）`
          : how === 'typed'
            ? `学生打字问：${q}\n（之前没讲完的要点先不讲了。备课老师正在准备新的要点，马上就到；先简短自然地回应一下，等要点到了再展开讲。）`
            : '（学生刚才说的话已经交给备课老师，之前没讲完的要点先不讲了，新的要点马上就到。先简短自然地回应一下，等要点到了再展开讲。）',
      );
    },
    ended() {
      complete = true;
      thinkingSince = 0;
      if (numbered) post('（这一轮的要点就这些。讲完以后，可以问问学生哪里还不清楚。）');
    },
    // The voice can't be stopped in the middle of what it is saying: its session ends at
    // once. A new one stands by, told where the student stopped it, and when they go on it
    // picks up the thread and says the sentence that was cut off again from its start.
    pause() {
      paused = true;
      if (!session) return;
      session.audio.muted = true;
      // What the student heard of what it was saying is all it said.
      pausedAt = tidy(saying);
      if (pausedAt) speech.forEach((l) => l(pausedAt, true));
      saying = '';
      close();
      remember('developer', pausedNote(pausedAt));
      void current(true).catch(() => {});
    },
    resume() {
      paused = false;
      resumed = now();
      if (session) session.audio.muted = false;
      const heard = pausedAt;
      pausedAt = '';
      // Going on with what it was saying; after a question asked meanwhile, it answers that.
      if (heard || owed()) post(resumedNote(heard), true, true);
      else if (outbox.length) outboxTimer ||= setTimeout(flush, 120);
      void current()
        .then(() => hand())
        .catch(() => {});
    },
    hush() {
      reset();
    },
    speed(r) {
      if (r === rate) return;
      rate = r;
      post(r > 1 ? '（学生希望你讲得快一些。）' : '（学生希望你按平常的速度讲。）');
    },
    onSpeech(listener) {
      speech.add(listener);
      return () => void speech.delete(listener);
    },
    warm: () => void (paused || current().catch(() => {})),
    async listen(on) {
      if (on === listening && (!on || mic)) return emit({ type: 'listening', on });
      listening = on;
      if (on) {
        try {
          await invoke('microphone');
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          if (!listening) {
            mic.getTracks().forEach((t) => t.stop());
            mic = null;
            return;
          }
          micCtx = new AudioContext();
          micLevel = micCtx.createAnalyser();
          micCtx.createMediaStreamSource(mic).connect(micLevel);
          ticker ||= setInterval(tick, 150);
          await current().catch((e) => {
            if (!(e instanceof NotNow)) throw e;
          });
        } catch (e) {
          listening = false;
          mic?.getTracks().forEach((t) => t.stop());
          mic = null;
          micLevel = null;
          void micCtx?.close().catch(() => {});
          micCtx = null;
          emit({ type: 'error', message: `麦克风打不开：${errorText(e)}` });
          emit({ type: 'listening', on: false });
          return;
        }
      } else {
        mic?.getTracks().forEach((t) => t.stop());
        mic = null;
        micLevel = null;
        void micCtx?.close().catch(() => {});
        micCtx = null;
        studentTalking = false;
      }
      connectMic();
      if (session && session.talk !== on) {
        session.talk = on;
        post(`（${on ? modes.talk : modes.type}）`);
      }
      emit({ type: 'listening', on });
    },
    mute(on) {
      micMuted = on;
      mic?.getAudioTracks().forEach((t) => (t.enabled = !on));
      if (session) send(session, { type: on ? 'input_audio.pause' : 'input_audio.resume' });
    },
    onHearing(listener) {
      hearing.add(listener);
      return () => void hearing.delete(listener);
    },
    stop,
    // The board is closed: the next one starts with nothing said on this one.
    forget() {
      history.length = 0;
      stop();
    },
  };
  function stop() {
    reset();
    thinkingSince = 0;
    outbox = [];
    paused = false;
    pausedAt = '';
    listening = false;
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
    micLevel = null;
    void micCtx?.close().catch(() => {});
    micCtx = null;
    close();
  }
}
