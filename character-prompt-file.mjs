const FORMAT = 'autopic-character-prompts';
const VERSION = 1;

function normalizeEntry(entry, index) {
    const invalid = () => new Error(`파일의 ${index + 1}번째 캐릭터 프롬프트 형식이 올바르지 않습니다.`);
    if (!entry || typeof entry.prompt !== 'string') throw invalid();

    const result = {};
    for (const key of ['name', 'prompt', 'clothing', 'uc']) {
        const value = entry[key] ?? '';
        if (typeof value !== 'string') throw invalid();
        result[key] = value;
    }
    if (entry.enabled != null && typeof entry.enabled !== 'boolean') throw invalid();
    result.enabled = entry.enabled !== false;

    if (entry.center != null) {
        if (typeof entry.center !== 'object' || Array.isArray(entry.center)) throw invalid();
        result.center = {};
        for (const axis of ['x', 'y']) {
            if (!Object.hasOwn(entry.center, axis)) continue;
            const value = entry.center[axis];
            if (!Number.isFinite(value)) throw invalid();
            result.center[axis] = value;
        }
    }
    return result;
}

export function serializeCharacterPrompts(entries) {
    return JSON.stringify({ format: FORMAT, version: VERSION, prompts: entries.map(normalizeEntry) }, null, 2);
}

export function parseCharacterPromptFile(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('JSON 파일을 읽을 수 없습니다.');
    }
    if (data?.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.prompts)) {
        throw new Error('AutoPic에서 내보낸 캐릭터 외형 프롬프트 파일을 선택해 주세요.');
    }
    return data.prompts.map(normalizeEntry);
}
