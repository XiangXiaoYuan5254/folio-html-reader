import { invoke } from '../api';
import type { EditTurn } from './prompts';

// One round of an AI 修改 conversation as it is kept: what was asked, what the model said it
// changed, and whether it went into the source.
export type EditTurnRecord = EditTurn & { images?: number };
export type EditThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: EditTurnRecord[];
};
export type EditHistory = { version: 1; active?: string; threads: EditThread[] };

// AI 修改 conversations are kept beside the document's assistant conversations.
export function loadEditHistory(docId: string) {
  return invoke<EditHistory | null>('ai-history', { key: `edit:${docId}` }).catch(() => null);
}
export function saveEditHistory(docId: string, history: EditHistory) {
  return invoke('ai-save-history', { key: `edit:${docId}`, data: history });
}
