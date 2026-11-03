import { Show, createSignal, createUniqueId } from "solid-js";
import { VoiceInput } from "../../features/speech/VoiceInput";
import type { SpeechLang } from "../../features/speech/speechMachine";

/**
 * "Add a voice note (optional)": the journal's voice input (Meta speech recognition, text confirmed by the farmer before it
 * is used). The confirmed text is appended to the field the form names; nothing is sent onward automatically.
 */
export function VoiceNote(props: { farmId: string; onText: (text: string) => void }) {
  const id = createUniqueId();
  const [language, setLanguage] = createSignal<SpeechLang>("en");
  /** The recorder mounts only once the farmer opens the block (no microphone or speech code runs before that). */
  const [opened, setOpened] = createSignal(false);
  return (
    <details class="jr-voice sc-voice" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary>Add a voice note (optional)</summary>
      <label for={`sc-lang-${id}`}>Language</label>
      <select id={`sc-lang-${id}`} value={language()} onChange={(e) => setLanguage(e.currentTarget.value as SpeechLang)}>
        <option value="en" selected={language() === "en"}>English</option>
        <option value="ta" selected={language() === "ta"}>Tamil</option>
        <option value="hi" selected={language() === "hi"}>Hindi</option>
      </select>
      <Show when={opened()}>
        <VoiceInput language={language()} farmId={props.farmId} onConfirmText={props.onText} />
      </Show>
    </details>
  );
}

/** Appends confirmed voice text to what is already typed (a new line between). */
export const appendText = (current: string, text: string) => (current.trim() ? `${current.trimEnd()}\n${text}` : text);
