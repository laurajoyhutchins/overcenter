export function repositoryIdentity(value) {
  let text = String(value || '').trim();
  const inlineCode = text.match(/^`([^`]+)`[.,;:]?$/);
  if (inlineCode) text = inlineCode[1].trim();
  else if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1).trim();
  return text.toLowerCase();
}