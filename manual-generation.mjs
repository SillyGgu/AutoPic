// Pure planning helpers. Preserve original story bytes; insert only at safe boundaries.
export const MAX_MANUAL_IMAGES = 8;
const imageTag = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const rawTags = /<autopic\b[^>]*>[\s\S]*?<\/autopic>|<pic\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const slots = /<span\b[^>]*\bdata-autopic-slot\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/span>/gi;
export function removeManualArtifacts(text) {
    return String(text || '').replace(rawTags, '').replace(slots, '').replace(imageTag, tag => /\bdata-autopic-id\s*=|\btitle\s*=\s*["']AutoPic["']/i.test(tag) ? '' : tag);
}
export function hasManualArtifacts(text) {
    return removeManualArtifacts(text) !== String(text || '');
}
export function manualParagraphs(text, clean = value => value.replace(/<[^>]*>/g, '').trim()) {
    const source = String(text || '');
    const mask = match => ' '.repeat(match.length);
    const structural = source.replace(/```[\s\S]*?```|<autopic\b[^>]*>[\s\S]*?<\/autopic>|<span\b[^>]*data-autopic-slot[^>]*>[\s\S]*?<\/span>/gi, mask);
    const tags = [...structural.matchAll(/<\/?([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
    const firstTag = tags[0];
    let bodyStart = 0, bodyEnd = source.length, tagIndex = 0;
    // A leading <content> wrapper marks the story. Keep the wrapper and footer in the original text.
    if (firstTag && /^<content(?:\s|>)/i.test(firstTag[0]) && !firstTag[0].endsWith('/>')
        && !source.slice(0, firstTag.index).trim()) {
        const nextContentTag = tags.find((tag, index) => index > 0 && tag[1].toLowerCase() === 'content');
        if (nextContentTag && /^<\/content\s*>$/i.test(nextContentTag[0])) {
            bodyStart = firstTag.index + firstTag[0].length;
            bodyEnd = nextContentTag.index;
            tagIndex = 1;
        }
    }
    // Ignore separators inside markup and keep all offsets relative to the original message.
    const masked = structural.slice(bodyStart, bodyEnd).replace(/<(?:[^>"']|"[^"]*"|'[^']*')+>/gi, mask);
    const boundaries = [bodyStart];
    let depth = 0;
    const breaks = [...masked.matchAll(/\r?\n[ \t\r]*\n/g)];
    const voids = new Set(['img','br','hr','input','meta','link','source','wbr','area','base','embed','param','track','col']);
    // Never insert inside a custom HTML block, attribute, or fenced code block.
    for (const boundary of breaks) {
        const position = bodyStart + boundary.index;
        while (tags[tagIndex] && tags[tagIndex].index < position) {
            const tag = tags[tagIndex++];
            if (!voids.has(tag[1].toLowerCase()) && !/\/>$/.test(tag[0])) depth = Math.max(0, depth + (/^<\//.test(tag[0]) ? -1 : 1));
        }
        if (!depth) boundaries.push(position + boundary[0].length);
    }
    boundaries.push(bodyEnd);
    const result = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i], end = boundaries[i + 1];
        const value = clean(removeManualArtifacts(source.slice(start, end)));
        if (value) result.push({ id: `p${result.length + 1}`, start, end, text: value });
    }
    return result;
}
export function manualContext(chat, target, previous, clean) {
    const count = Math.max(0, Math.min(20, Math.trunc(Number(previous) || 0)));
    return chat.slice(Math.max(0, target - count), target + 1).map((message, offset, messages) => {
        const marker = offset === messages.length - 1 ? ' [TARGET]' : '';
        return `${message.is_user ? 'User' : message.name || 'Assistant'}${marker}: ${clean(removeManualArtifacts(message.mes))}`;
    }).join('\n');
}
export function parseManualPlan(text, count, paragraphs, placement, prepare) {
    const source = String(text || '').replace(/```(?:xml|html)?\s*|```/gi, '').trim();
    const matches = [...source.matchAll(/<autopic\b([^>]*)>[\s\S]*?<\/autopic>/gi)];
    if (matches.length !== count) throw new Error(`삽화 ${count}개를 요청했지만 AI가 ${matches.length}개의 태그를 반환했습니다. 개수나 최대 토큰을 조정해 주세요.`);
    for (const tag of ['autopic', 'scene', 'apchar', 'uc']) {
        const opening = source.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) || [];
        const closing = source.match(new RegExp(`</${tag}\\s*>`, 'gi')) || [];
        if (opening.length !== closing.length) throw new Error('AI가 미완성 삽화 태그를 반환했습니다. 최대 토큰을 늘리거나 다시 시도해 주세요.');
    }
    const ids = new Set(paragraphs.map(p => p.id)), signatures = new Set();
    return matches.map(match => {
        const prepared = prepare(match[0]);
        if (!prepared.naiPayload || (!prepared.prompt?.trim() && !prepared.naiPayload.characterPrompts?.length)) throw new Error('AI가 비어 있는 삽화 태그를 반환했습니다.');
        const signature = JSON.stringify(prepared.naiPayload).toLowerCase();
        if (signatures.has(signature)) throw new Error('AI가 같은 삽화 태그를 반복했습니다. 서로 다른 장면을 요청해 주세요.');
        signatures.add(signature);
        const after = /\bafter\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
        if (placement === 'free' && !ids.has(after)) throw new Error('AI가 올바른 문단 위치를 지정하지 않았습니다. 다시 시도하거나 하단 배치를 선택해 주세요.');
        return { prepared, after: placement === 'free' ? after : 'bottom' };
    });
}
export function insertManualIllustrations(text, paragraphs, items) {
    const byPosition = new Map();
    for (const item of items) {
        const position = item.after === 'bottom' ? text.length : paragraphs.find(p => p.id === item.after)?.end;
        if (position === undefined) throw new Error('삽화를 넣을 문단을 찾지 못했습니다.');
        const list = byPosition.get(position) || [];
        list.push(item.markup); byPosition.set(position, list);
    }
    let result = text;
    for (const [position, values] of [...byPosition].sort((a,b) => b[0] - a[0])) {
        result = result.slice(0,position) + '\n\n' + values.join('\n\n') + '\n\n' + result.slice(position);
    }
    return result;
}
