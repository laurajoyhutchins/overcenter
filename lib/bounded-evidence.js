export function boundedEvidenceText(value, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

export function boundedEvidenceProjection(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : String(value).slice(0, 1024);
  if (typeof value === 'string') return value.slice(0, 1024);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => boundedEvidenceProjection(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1024);
  const result = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    if (/token|secret|password|credential|content|body/i.test(key)) continue;
    result[String(key).slice(0, 128)] = boundedEvidenceProjection(value[key], depth + 1);
  }
  return result;
}
