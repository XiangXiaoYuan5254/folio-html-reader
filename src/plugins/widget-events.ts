import { useEffect, useState } from 'react';
import type { Assistant } from '../ai/assistant';
import type { ChatMessage } from '../ai/types';
import { themeInfo, useTheme } from '../theme';

// What widgets are told (src/components/WidgetLayer.tsx): what Folio is doing, never what is
// being read or said. Only 'document' carries anything of the reader's: the open file's title,
// for widgets whose folio-plugin.json asks for it (shown when they're installed).
export type AiState = 'idle' | 'thinking' | 'writing' | 'tool' | 'done' | 'error';
export type ReadingState = { state: 'reading' | 'away'; kind: 'html' | 'pdf' | 'none' };
export type DocumentState = { title: string; kind: 'html' | 'pdf' | 'none' };
export type WidgetTheme = { dark: boolean; accent: string; reducedMotion: boolean };

type AssistantState = ReturnType<Assistant['get']>;
const threadsOf = (s: AssistantState) =>
  Object.values(s.histories).flatMap((h) => h?.threads || []);
const lastReply = (messages: ChatMessage[]) => {
  const m = messages[messages.length - 1];
  return m?.role === 'assistant' ? m : undefined;
};

// While something runs: a tool step under way, words coming in, or still thinking.
function busyState(s: AssistantState, running: string[]): AiState {
  const reply = threadsOf(s)
    .filter((t) => running.includes(t.id))
    .map((t) => lastReply(t.messages))
    .find((m) => m?.status === 'streaming');
  if (!reply) return s.card?.status === 'streaming' && s.card.text ? 'writing' : 'thinking';
  if ((reply.searches || []).some((step) => step.status === 'running')) return 'tool';
  const last = reply.parts?.[reply.parts.length - 1];
  if (last?.type === 'step') return last.step.status === 'running' ? 'tool' : 'thinking';
  if (last?.type === 'text') return last.text.trim() ? 'writing' : 'thinking';
  return reply.text.trim() || reply.draft?.trim() ? 'writing' : 'thinking';
}
// When it stops: how the replies that were running ended.
function outcome(s: AssistantState, ran: string[], card: boolean): AiState {
  const failed =
    (card && s.card?.status === 'error') ||
    threadsOf(s)
      .filter((t) => ran.includes(t.id))
      .some((t) => lastReply(t.messages)?.status === 'error');
  return failed ? 'error' : 'done';
}

/** The AI's state for widgets: done and error last a few seconds, then idle. */
export function useAiState(assistant: Assistant): AiState {
  const [state, setState] = useState<AiState>('idle');
  useEffect(() => {
    let ran: string[] = [];
    let card = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const s = assistant.get();
      const running = Object.keys(s.running);
      const cardBusy = s.card?.status === 'streaming';
      if (running.length || cardBusy) {
        clearTimeout(settle);
        ran = [...new Set([...ran, ...running])];
        card ||= cardBusy;
        setState(busyState(s, running));
      } else if (ran.length || card) {
        setState(outcome(s, ran, card));
        ran = [];
        card = false;
        clearTimeout(settle);
        settle = setTimeout(() => setState('idle'), 3000);
      }
    };
    update();
    const off = assistant.subscribe(update);
    return () => {
      off();
      clearTimeout(settle);
    };
  }, [assistant]);
  return state;
}

/**
 * Whether the reader is here: away after three minutes without using Folio, or a minute with
 * the window in the background. The reading area is a frame of its own, so the messages it sends
 * the app (scrolling, selecting) count as using it too.
 */
export function useReading(kind: ReadingState['kind']): ReadingState {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let active = Date.now();
    let unfocused = document.hasFocus() ? 0 : Date.now();
    const touch = () => {
      active = Date.now();
      setAway(false);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'mousemove', 'message'] as const;
    for (const e of events) addEventListener(e, touch, { passive: true });
    const timer = setInterval(() => {
      const now = Date.now();
      if (document.hasFocus()) unfocused = 0;
      else unfocused ||= now;
      setAway(now - active > 3 * 60_000 || (!!unfocused && now - unfocused > 60_000));
    }, 10_000);
    return () => {
      for (const e of events) removeEventListener(e, touch);
      clearInterval(timer);
    };
  }, []);
  return { state: away ? 'away' : 'reading', kind };
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** The theme as widgets see it: light or dark, the accent color, and reduced motion. */
export function useWidgetTheme(): WidgetTheme {
  const { active } = useTheme();
  const read = (): WidgetTheme => ({
    dark: themeInfo(active).dark,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    reducedMotion: reducedMotion.matches,
  });
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    // The new theme's colors are on the page a frame later.
    const frame = requestAnimationFrame(() => setTheme(read()));
    const change = () => setTheme(read());
    reducedMotion.addEventListener('change', change);
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion.removeEventListener('change', change);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return theme;
}
