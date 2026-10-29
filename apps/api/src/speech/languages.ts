export const SPEECH_LANGUAGES = ["en", "ta", "hi"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

/**
 * The STT docs accept ISO-639-1 or ISO-639-3 in `language_code`. We send ISO-639-3 (eng/tam/hin),
 * the form the provider's own responses use, and normalise both forms when comparing.
 */
export const STT_LANGUAGE_CODE: Record<SpeechLanguage, string> = { en: "eng", ta: "tam", hi: "hin" };

const NORMALISE: Record<string, SpeechLanguage> = { en: "en", eng: "en", ta: "ta", tam: "ta", hi: "hi", hin: "hi" };

/** Maps a provider language code (639-1 or 639-3, optional region) to en/ta/hi, or null if outside the qualification set. */
export function normaliseLanguage(code: string | null | undefined): SpeechLanguage | null {
  if (!code) return null;
  return NORMALISE[code.toLowerCase().split(/[-_]/)[0]!] ?? null;
}
