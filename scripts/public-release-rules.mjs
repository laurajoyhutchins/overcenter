const SECRET_RULES = Object.freeze([
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['linear_api_key', /\blin_api_[A-Za-z0-9_-]{20,}\b/],
  ['stripe_live_secret', /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
]);

export function detectSecretPatterns(textInput) {
  const text = String(textInput ?? '');
  return SECRET_RULES
    .filter(([, pattern]) => pattern.test(text))
    .map(([rule]) => ({ rule }));
}
