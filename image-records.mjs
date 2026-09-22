// Image identity, never an array index, owns a generation source.
export function imageKey(src) {
    try { return decodeURIComponent(new URL(src, 'http://autopic.local').pathname); }
    catch { return String(src || ''); }
}
export function rememberImage(message, src, text) {
    message.extra ??= {};
    message.extra.autopic_images ??= {};
    const key = imageKey(src);
    message.extra.autopic_images[key] = String(text || '');
    return { image: key };
}
export function imageRecord(message, src) {
    const text = message.extra?.autopic_images?.[imageKey(src)];
    return typeof text === 'string' ? { editText: text } : null;
}
export function resolveRecord(message, record) {
    return record?.image ? imageRecord(message, record.image) : record;
}
export function migrateImageRecords(message) {
    const extra = message.extra;
    if (!extra) return;
    const known = new Map();
    (extra.image_swipes || []).forEach((src, i) => {
        const old = extra.autopic_swipe_payloads?.[i];
        const text = old?.editText || old?.rawAutopicTag;
        if (text) {
            const record = imageRecord(message, src) ? { image: imageKey(src) } : rememberImage(message, src, text);
            extra.autopic_swipe_payloads[i] = record;
            known.set(text, record);
        }
    });
    for (const field of ['autopic_text_swipe_payloads', 'autopic_text_swipe_payloads_by_hash']) {
        for (const list of Object.values(extra[field] || {})) {
            if (!Array.isArray(list)) continue;
            list.forEach((old, i) => { const replacement = known.get(old?.editText || old?.rawAutopicTag); if (replacement) list[i] = replacement; });
        }
    }
    const last = extra.autopic_last_payload;
    if (known.has(last?.editText || last?.rawAutopicTag)) extra.autopic_last_payload = known.get(last.editText || last.rawAutopicTag);
}
export function pruneImageRecords(message, liveSources, liveIds) {
    const extra = message.extra;
    if (!extra) return;
    const live = new Set(liveSources.map(imageKey));
    for (const key of Object.keys(extra.autopic_images || {})) if (!live.has(key)) delete extra.autopic_images[key];
    for (const id of Object.keys(extra.autopic_image_prompts || {})) if (!liveIds.has(id)) delete extra.autopic_image_prompts[id];
    for (const field of ['autopic_images', 'autopic_image_prompts']) if (extra[field] && !Object.keys(extra[field]).length) delete extra[field];
    const valid = record => !record?.image || live.has(record.image);
    if (extra.autopic_swipe_payloads) extra.autopic_swipe_payloads = (extra.image_swipes || []).map(src => imageRecord(message, src) ? { image: imageKey(src) } : null);
    for (const field of ['autopic_text_swipe_payloads', 'autopic_text_swipe_payloads_by_hash']) {
        for (const [key, list] of Object.entries(extra[field] || {})) {
            if (Array.isArray(list)) extra[field][key] = list.filter(valid);
            if (!extra[field][key]?.length) delete extra[field][key];
        }
        if (extra[field] && !Object.keys(extra[field]).length) delete extra[field];
    }
    if (!valid(extra.autopic_last_payload)) delete extra.autopic_last_payload;
}
export function clearImageRecords(message) {
    for (const field of Object.keys(message.extra || {})) {
        if (field === 'autopic_images' || field === 'autopic_image_prompts' || /^autopic_(?:swipe_payloads|text_swipe_payloads(?:_by_hash)?|last_payload)$/.test(field)) delete message.extra[field];
    }
}
