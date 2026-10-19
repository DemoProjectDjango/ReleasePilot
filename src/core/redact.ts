const PATTERNS: Array<[RegExp, string]> = [
  [/force:\/\/[^\s"']+/gi, 'force://[REDACTED]'],
  [/(access[_-]?token|refresh[_-]?token|sessionId|client[_-]?secret|installation[_-]?key)(["'\s:=]+)([^\s"',}]+)/gi, '$1$2[REDACTED]'],
  [/(--installation-key(?:=|\s+))\S+/gi, '$1[REDACTED]'],
  [/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9_.]{20,}/g, '[REDACTED_SESSION]'],
  [/([?&](?:sid|session_id|sessionId|access_token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]']
];

/** Removes credential-bearing substrings from text destined for logs or reports. */
export function redact(text: string): string {
  return PATTERNS.reduce((acc, [re, repl]) => acc.replace(re, repl), text);
}
