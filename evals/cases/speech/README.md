# Speech qualification cases (English, Tamil, Hindi)

`en.json`, `ta.json`, `hi.json` each hold 12 short utterances **as text**, with the normalised fields a correct transcript must preserve: numbers, units (acre, hectare, quintal, tonne, cent, bigha), dates, crop names and code-switched words. `anyOf` lists accepted transcript surface forms (digits or words; Tamil and Hindi case suffixes are allowed after a stem).

**No audio is supplied.** Real qualification needs recordings by real speakers (ideally farmers or field staff, with phone microphones and background noise) that the user or tester provides. Until those recordings are scored, no language is qualified. The product must keep presenting the editable text path.

## Scoring

Code decides pass or fail (`apps/api/src/speech/score.ts`): token word-error rate against the reference text plus a field check that each expected item appears in the transcript. A case passes the field check only if every expected field is found. Unit confusion (acres versus hectares) is a failure even when the word-error rate is low. `bigha` and `cent` are regionally variable units; a pass means the unit word was preserved, not that its area was resolved.

Suggested acceptance (to be agreed before use): per language, field pass rate and a word-error ceiling set by the team, with every number/unit/date failure reviewed by hand.

## Round-trip harness (synthetic speech only)

With a live key and a stock voice:

```
ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... \
  pnpm --filter @harvest/api exec tsx ../../evals/cases/speech/roundtrip.ts --lang en,ta,hi --max 36
```

It synthesises each case with TTS, transcribes the audio with STT, scores it, and writes `evals/results/speech/<runId>/results.json` plus the generated audio. It spends credits, is capped by `--max`, and prints a skip with exit code 0 when no key or voice is configured. Round-trip results measure the pipeline on synthetic speech, which is cleaner than a farmer on a phone; they must never be reported as qualification.

For human recordings, transcribe each file through `POST /api/v1/speech/transcriptions` and score with `scoreCase` using the matching case id.
