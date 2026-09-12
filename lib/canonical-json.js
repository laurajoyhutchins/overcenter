function normalize(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(normalize);
    const result = {};
    for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child !== undefined)
            result[key] = normalize(child);
    }
    return result;
}
export function canonicalJson(value) {
    const encoded = JSON.stringify(normalize(value));
    if (encoded === undefined)
        throw new TypeError('value is not JSON serializable');
    return encoded;
}
export async function sha256Text(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
