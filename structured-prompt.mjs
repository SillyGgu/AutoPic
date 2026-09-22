// A single parser shared by all direct-generation entry points.
export function parseAutopic(text, library = [], decode = value => value) {
    const source = decode(String(text || '')).trim();
    const match = source.match(/<autopic\b[^>]*>([\s\S]*?)<\/autopic>/i);
    if (!match) {
        if (/<\/?(?:autopic|scene|apchar|uc)\b/i.test(source)) throw new Error('AutoPic 태그가 완성되지 않았습니다. scene/apchar 닫는 태그를 확인해 주세요.');
        return null;
    }
    const blocks = tag => [...match[1].matchAll(new RegExp('<'+tag+'\\b([^>]*)>([\\s\\S]*?)<\\/'+tag+'>', 'gi'))];
    const prompt = blocks('scene').map(m=>decode(m[2]).trim()).filter(Boolean).join(', ');
    const negative_prompt = blocks('uc').map(m=>decode(m[2]).trim()).filter(Boolean).join(', ');
    const characterPrompts = blocks('apchar').map(m => {
        const ref = /(?:ref|name)\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] || '';
        const base = ref && library.find(c => c.enabled !== false && String(c.name || '').trim().toLowerCase() === decode(ref).trim().toLowerCase());
        return { name: base?.name || decode(ref), prompt: [base?.prompt, decode(m[2]).trim()].filter(Boolean).join(', '), uc: base?.uc || '', enabled: true, ...(base?.center ? {center:{...base.center}} : {}) };
    }).filter(c=>c.prompt);
    return { prompt, negative_prompt, characterPrompts };
}
export function assertNoAutopicTags(text) {
    if (/<\/?(?:autopic|scene|apchar|uc)\b|&lt;\/?(?:autopic|scene|apchar|uc)\b/i.test(String(text || ''))) throw new Error('구조화 프롬프트 분리에 실패했습니다. 원문 태그를 메인으로 전송하지 않습니다.');
}
