/** Replace api-key style query parameters (and bare occurrences of known secrets) in any string. */
const KEY_PARAM = /([?&;\s"'](?:api[-_]?key|apikey|key|token|access_token)=)[^&\s"'#]*/gi;

export function redactUrl(url: string): string {
  return url.replace(KEY_PARAM, "$1REDACTED").replace(/^((?:api[-_]?key|apikey|token)=)[^&\s]*/i, "$1REDACTED");
}

export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = redactUrl(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("REDACTED");
  return out;
}
