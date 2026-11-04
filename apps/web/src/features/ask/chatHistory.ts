import { EvaraAction as actionSchema, type EvaraAction } from '@harvest/contracts';
import { turnUi, type AskLanguage, type TurnResult } from './model';

export interface ChatMessage {
  role: 'user' | 'assistant'; text: string; turn?: TurnResult; language?: AskLanguage;
  actions?: EvaraAction[] | undefined;
}
export interface Chat {
  id: string; farmId: string | null; farmName: string; title: string;
  createdAt: string; updatedAt: string; messages: ChatMessage[];
  draft: string; language: AskLanguage;
}
export const chatPrefix = (scope: string) => `ho.chat.v2.${scope}.`;
export function reviveMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').map(m => {
    const actions = Array.isArray(m.actions) ? m.actions.filter((a: unknown) => actionSchema.safeParse(a).success) : undefined;
    const turn = m.turn && Array.isArray(m.turn.limitations) && Array.isArray(m.turn.clarifications) ? {...m.turn, ui: turnUi(m.turn.ui)} : undefined;
    return {role: m.role, text: m.text, language: m.language, actions, ...(turn ? {turn} : {})};
  });
}
export function loadChats(storage: Storage, scope: string): Chat[] {
  const chats: Chat[] = [];
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(chatPrefix(scope))) continue;
    try {
      const c = JSON.parse(storage.getItem(key) ?? 'null');
      if (!c || typeof c.id !== 'string' || (c.farmId !== null && typeof c.farmId !== 'string') || typeof c.updatedAt !== 'string') continue;
      chats.push({...c, farmName: typeof c.farmName === 'string' ? c.farmName : 'Farm', title: typeof c.title === 'string' ? c.title : 'New chat',
        messages: reviveMessages(c.messages), draft: typeof c.draft === 'string' ? c.draft : '', language: ['en', 'hi', 'ta'].includes(c.language) ? c.language : 'en'});
    } catch { /* One damaged record must not hide other chats. */ }
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
