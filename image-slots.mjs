import { createAutopicId } from './id.mjs';
// Persist only this safe HTML in mes. Image URLs and generation sources live in extra.
export const SLOT_PATTERN = '<span class="autopic-image-slot" data-autopic-slot="([a-zA-Z0-9-]+)">\\[AutoPic 이미지\\]</span>';
export const SLOT_RULE = `/${SLOT_PATTERN}/g`;
export const SLOT_EVENT = 'EXTENSION_LLM_TRANSLATE_UI_UPDATED';
const KEY = 'autopic_image_slots';
export const slotMarkup = id => `<span class="autopic-image-slot" data-autopic-slot="${id}">[AutoPic 이미지]</span>`;
export const slotIds = text => [...String(text || '').matchAll(new RegExp(SLOT_PATTERN, 'g'))].map(m => m[1]);
export function slotRecord(message, id) {
    if (!id || !slotIds(message?.mes).includes(id)) return null;
    return message.extra?.[KEY]?.[id] || message.swipe_info?.[message.swipe_id ?? 0]?.extra?.[KEY]?.[id] || null;
}
function put(extra, id, record) { (extra[KEY] ??= {})[id] = { ...record }; }
export function pruneSlots(message) {
    const clean = (extra, text) => {
        if (!extra?.[KEY]) return;
        const active = new Set(slotIds(text));
        for (const id of Object.keys(extra[KEY])) if (!active.has(id)) delete extra[KEY][id];
        if (!Object.keys(extra[KEY]).length) delete extra[KEY];
    };
    clean(message.extra, message.mes);
    for (let i = 0; i < (message.swipe_info?.length || 0); i++) {
        // MESSAGE_EDITED can arrive before ST updates the selected swipe's text snapshot.
        clean(message.swipe_info[i]?.extra, i === (message.swipe_id ?? 0) ? message.mes : message.swipes?.[i]);
    }
}
export function writeSlot(message, id, record) {
    let found = false;
    if (slotIds(message.mes).includes(id)) {
        put(message.extra ??= {}, id, record);
        found = true;
    }
    // Resolve the owning swipe by its stable marker, not an index captured before an await.
    for (let i = 0; i < (message.swipes?.length || 0); i++) {
        if (!slotIds(message.swipes[i]).includes(id)) continue;
        message.swipe_info ??= [];
        const info = message.swipe_info[i] ??= {};
        put(info.extra ??= {}, id, record);
        found = true;
    }
    return found;
}
export function reserveSlot(message, original, editText, src = '') {
    const id = createAutopicId();
    const markup = slotMarkup(id);
    if (original && !message.mes.includes(original)) return null;
    message.mes = original ? message.mes.replace(original, () => markup) : `${message.mes}\n\n${markup}`;
    if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = message.mes;
    pruneSlots(message);
    const record = { src, editText };
    writeSlot(message, id, record);
    return { id, record };
}
export function clearSlotPrompts(message) {
    for (const extra of [message.extra, ...(message.swipe_info || []).map(i => i?.extra)]) {
        for (const record of Object.values(extra?.[KEY] || {})) delete record.editText;
    }
}
function restoreEncodedSlots(root, active, records) {
    // ST's encode_tags path turns markup into text, and may wrap attribute quotes in <q>.
    // Inspect only this rendered message, only when an escaped marker is actually present.
    if (!root.textContent.includes('<span class="autopic-image-slot"')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('span.autopic-image-slot, script, style, textarea')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const parts = [], nodes = [];
    let length = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        nodes.push({ node, start: length, end: length + node.length });
        parts.push(node.data);
        length += node.length;
    }
    const matches = [...parts.join('').matchAll(new RegExp(SLOT_PATTERN, 'g'))]
        .filter(match => active.has(match[1]) && records(match[1]));
    // Reverse order keeps text-node offsets valid for multiple slots in one paragraph.
    for (const match of matches.reverse()) {
        const start = nodes.find(item => item.end > match.index);
        const endOffset = match.index + match[0].length;
        const end = nodes.find(item => item.end >= endOffset);
        if (!start || !end) continue;
        const range = document.createRange();
        range.setStart(start.node, match.index - start.start);
        range.setEnd(end.node, endOffset - end.start);
        const slot = document.createElement('span');
        slot.className = 'autopic-image-slot';
        slot.dataset.autopicSlot = match[1];
        slot.textContent = '[AutoPic 이미지]';
        range.deleteContents();
        range.insertNode(slot);
    }
}
function repairSlotWrappers(root, active) {
    const slots = new Map();
    for (const node of root.querySelectorAll('span[data-autopic-slot]')) {
        if (active.has(node.dataset.autopicSlot) && !slots.has(node.dataset.autopicSlot)) slots.set(node.dataset.autopicSlot, node);
    }
    // Old block wrappers can be ejected from <p><span> by the HTML parser.
    // Recover only a provably owned image in this message, never by URL similarity.
    for (const image of root.querySelectorAll('img[data-autopic-slot]')) {
        const id = image.dataset.autopicSlot, slot = slots.get(id);
        if (!slot || image.dataset.autopicId !== `slot-${id}` || image.closest('span[data-autopic-slot]')) continue;
        const wrapper = image.closest('.autopic-tag-img-wrapper');
        if (!wrapper || !root.contains(wrapper) || wrapper.querySelectorAll('img').length !== 1) continue;
        if (slot.querySelector('img')) wrapper.remove();
        else slot.replaceChildren(wrapper);
    }
    for (const slot of slots.values()) {
        for (const block of slot.querySelectorAll('div.autopic-tag-img-wrapper, div.autopic-tag-controls, div.autopic-aux-controls, div.reroll-trigger')) {
            const inline = document.createElement('span');
            for (const attribute of block.attributes) inline.setAttribute(attribute.name, attribute.value);
            inline.append(...block.childNodes);
            block.replaceWith(inline);
        }
    }
}
export function renderSlots(root, message, { eagerSlotId = null } = {}) {
    if (!root || !message?.mes?.includes('autopic-image-slot')) return;
    const result = { rendered: [], failed: {} };
    const active = new Set(slotIds(message.mes));
    const records = id => message.extra?.[KEY]?.[id] || message.swipe_info?.[message.swipe_id ?? 0]?.extra?.[KEY]?.[id];
    restoreEncodedSlots(root, active, records);
    repairSlotWrappers(root, active);
    // The data attribute owns identity; renderer/sanitizer class changes must not hide images.
    for (const node of root.querySelectorAll('span[data-autopic-slot]')) {
        const id = node.dataset.autopicSlot;
        if (!active.has(id)) { node.replaceChildren(document.createTextNode('[AutoPic 이미지]')); continue; }
        const record = records(id);
        if (!record?.src) { result.failed[id] = 'missing-image-url'; continue; }
        let url;
        try { url = new URL(record.src, document.baseURI); }
        catch { result.failed[id] = 'invalid-image-url'; continue; }
        if (!['http:', 'https:'].includes(url.protocol)) { result.failed[id] = 'unsupported-image-url'; continue; }
        result.rendered.push(id);
        // Keep the same image and wrapper across rerolls. Replacing the subtree leaves
        // stale wrappers in render/zoom integrations which retain the previous element.
        const existing = node.querySelector('img');
        const img = existing || document.createElement('img');
        img.loading = id === eagerSlotId ? 'eager' : 'lazy';
        img.decoding = 'async';
        if (img.getAttribute('src') !== record.src) img.setAttribute('src', record.src);
        img.alt = 'AutoPic 이미지';
        img.title = 'AutoPic';
        img.dataset.autopicId = `slot-${id}`;
        img.dataset.autopicSlot = id;
        if (!existing) node.replaceChildren(img);
        for (const control of node.querySelectorAll('[data-image-src]')) {
            control.setAttribute('data-image-src', record.src);
            if (control.hasAttribute('data-prompt')) control.setAttribute('data-prompt', record.editText || '');
        }
    }
    return result;
}
// Use the translator's existing public user-regex settings, never intercept its rendering.
export function configureSlotProtection(translator, settings, enabled) {
    if (!translator) return false;
    let changed = false;
    for (const key of ['user_defined_regexes', 'user_no_fold_regexes']) {
        if (enabled) {
            const rules = translator[key] ??= [];
            if (!Array.isArray(rules)) continue;
            if (!rules.includes(SLOT_RULE)) {
                rules.push(SLOT_RULE);
                (settings.slotProtectionOwned ??= {})[key] = true;
                changed = true;
            }
        } else if (settings.slotProtectionOwned?.[key]) {
            if (Array.isArray(translator[key])) translator[key] = translator[key].filter(rule => rule !== SLOT_RULE);
            delete settings.slotProtectionOwned[key];
            changed = true;
        }
    }
    return changed;
}
export function slotSubscription(events, render) {
    let subscribed = false;
    const handler = event => render(event?.messageId);
    return enabled => {
        if (enabled === subscribed) return;
        if (enabled) events.on(SLOT_EVENT, handler);
        else events.removeListener(SLOT_EVENT, handler);
        subscribed = enabled;
    };
}
