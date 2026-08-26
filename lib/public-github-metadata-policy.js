const SECRET_RULES = Object.freeze([
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['linear_api_key', /\blin_api_[A-Za-z0-9_-]{20,}\b/],
  ['stripe_live_secret', /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
]);

const METADATA_RULES = Object.freeze([
  ['hatchable_project_id', /\bproj_[A-Za-z0-9]{12}\b/],
  ['github_app_client_id', /\bIv23[A-Za-z0-9]{16,}\b/],
  ['github_app_registration_id', /\bGitHub App ID\s+\d+\b/i],
  ['repository_numeric_id', /\brepository ID\s+\d+\b/i],
  ['linear_work_id', /\bLJH-\d+\b/],
]);
const OWNER_REPOSITORY_PATTERN = /\blaurajoyhutchins\/([A-Za-z0-9_.-]+)\b/g;
export function detectSecretPatterns(textInput){const text=String(textInput??'');return SECRET_RULES.filter(([,pattern])=>pattern.test(text)).map(([rule])=>({rule}));}
export function detectMetadataTextViolations(textInput){const text=String(textInput??'');return [...METADATA_RULES.filter(([,pattern])=>pattern.test(text)).map(([rule])=>({rule})),...detectSecretPatterns(text)];}
export function extractOwnerRepositoryCoordinates(textInput){const text=String(textInput??'');const coordinates=new Set();for(const match of text.matchAll(OWNER_REPOSITORY_PATTERN))coordinates.add(`laurajoyhutchins/${match[1]}`);return [...coordinates].sort();}
