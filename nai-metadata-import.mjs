export const RESOLUTION_PRESETS = {
    square: { width: 1024, height: 1024 },
    landscape: { width: 1216, height: 832 },
    portrait: { width: 832, height: 1216 },
};
export function resolutionPreset(width, height) {
    return Object.keys(RESOLUTION_PRESETS).find(k => RESOLUTION_PRESETS[k].width === Number(width) && RESOLUTION_PRESETS[k].height === Number(height)) || 'custom';
}

/** Whitelist values from untrusted metadata. Never merge arbitrary metadata into settings. */
export function planMetadataImport(result, models, currentModel) {
    const data = result.data, warnings = [...result.warnings];
    const source = String(data.model || data.model_name || data._source || '');
    let model = currentModel;
    if (/curated|inpaint|furry-3|diffusion[- ](?:[123]|4(?![.-]5|\.5))\b/i.test(source)) throw new Error('이 이미지는 AutoPic 직접 생성의 V4.5 Full / V5 Full 모델과 다릅니다.');
    if (Object.hasOwn(models, source)) model = source;
    else if (/4[.-]5/i.test(source)) model = 'nai-diffusion-4-5-full';
    else if (/\bV?5\b|diffusion-5/i.test(source)) model = 'nai-diffusion-5-full';
    else if (source) throw new Error(`지원 모델을 확인할 수 없습니다: ${source.slice(0, 100)}`);
    if (!Object.hasOwn(models, model)) throw new Error('먼저 V4.5 Full 또는 V5 Full을 선택해 주세요.');
    if (!source || !/full/i.test(source)) warnings.push('Full / Curated 구분이 기록되어 있지 않습니다. 적용할 Full 모델을 확인해 주세요.');
    const profile = models[model], settings = {}, shared = {};
    const numeric = (sourceKey, target, min, max, integer = false, dest = settings) => {
        if (data[sourceKey] == null) return;
        const raw = data[sourceKey];
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) dest[target] = n;
        else warnings.push(`${sourceKey} 값이 유효하지 않아 제외했습니다.`);
    };
    numeric('width', 'width', 64, 2048, true); numeric('height', 'height', 64, 2048, true);
    for (const dimension of ['width', 'height']) if (settings[dimension] % 64) { delete settings[dimension]; warnings.push(`${dimension}는 64의 배수가 아니어서 제외했습니다.`); }
    numeric('steps', 'steps', 1, 50, true); numeric('scale', 'scale', 0, 10); numeric('cfg_rescale', 'cfg_rescale', 0, 1, false, shared);
    numeric('seed', 'seed', 0, 4294967295, true, shared);
    for (const [from, to, allowed] of [['sampler', 'sampler', profile.samplers], ['noise_schedule', 'scheduler', profile.schedulers]]) {
        if (data[from] == null) continue;
        if (allowed.includes(data[from])) settings[to] = data[from];
        else warnings.push(`${from}: ${profile.name}에서 지원하지 않아 제외했습니다.`);
    }
    if (profile.schedulers.length === 1) settings.scheduler = profile.schedulers[0];
    const base = data.v4_prompt?.caption?.base_caption ?? data.prompt ?? data.input;
    const negative = data.v4_negative_prompt?.caption?.base_caption ?? data.uc ?? data.negative_prompt;
    const prompts = {};
    if (typeof base === 'string') prompts.prefix = base;
    if (typeof negative === 'string') prompts.negative_prompt = negative;
    if (Object.values(prompts).some(t => t.length > 60000)) throw new Error('프롬프트가 너무 깁니다.');
    // PNG metadata holds the final prompt, including quality/UC/dataset tags.
    Object.assign(prompts, { quality: 'none', ucPreset: 'none', dataset: 'anime' });
    settings.transparent = profile.transparency && data.tag_hint_transparent_background === true;
    // The transparent tag is already inside an imported final prompt.
    if (settings.transparent) prompts.transparent = false;
    if (typeof data.v4_prompt?.use_coords === 'boolean') shared.useCharacterPositionsAiChoice = !data.v4_prompt.use_coords;
    if (typeof data.skip_cfg_above_sigma === 'number' || data.skip_cfg_above_sigma === null) {
        settings.variety = profile.variety && Number(data.skip_cfg_above_sigma) > 0;
        if (settings.variety) {
            const expected = Math.sqrt(Number(data.width) * Number(data.height) / 1011712) * 58;
            if (Math.abs(expected - data.skip_cfg_above_sigma) > 0.01) warnings.push('Variety Boost의 사용자 지정 Sigma는 현재 해상도의 표준값으로 적용됩니다.');
        }
    }
    const positive = data.v4_prompt?.caption?.char_captions ?? data.characterPrompts ?? [];
    const negativeChars = data.v4_negative_prompt?.caption?.char_captions ?? [];
    if (!Array.isArray(positive)) throw new Error('캐릭터 메타데이터 형식이 올바르지 않습니다.');
    const characters = positive.map((c, i) => {
        if (c?.enabled === false) return null;
        const prompt = c?.char_caption ?? c?.prompt, uc = negativeChars[i]?.char_caption ?? c?.uc ?? '';
        if (typeof prompt !== 'string' || typeof uc !== 'string' || prompt.length > 60000 || uc.length > 60000) throw new Error('캐릭터 프롬프트가 올바르지 않습니다.');
        const center = c?.centers?.[0] ?? c?.center;
        const validCenter = center && ['x', 'y'].every(k => Number.isFinite(center[k]) && center[k] >= 0 && center[k] <= 1);
        if (c?.centers?.length > 1) warnings.push(`캐릭터 ${i + 1}: 여러 좌표 중 첫 좌표만 복원합니다.`);
        return { prompt, uc, enabled: true, ...(validCenter ? { center: { x: center.x, y: center.y } } : {}) };
    }).filter(c => c?.prompt.trim());
    if (characters.length > profile.maxCharacters) throw new Error(`${profile.name}의 캐릭터 한도 ${profile.maxCharacters}개를 초과합니다.`);
    if (['reference_image_multiple', 'director_reference_images', 'reference_strength_multiple', 'director_reference_strength_values'].some(k => Array.isArray(data[k]) && data[k].length)) warnings.push('Vibe / Reference 이미지는 복원하지 않습니다. 생성값을 적용하면 현재 참조 기능을 끕니다.');
    if (data.image || data.mask || data.strength != null || data.noise > 0) warnings.push('Image2Image / Inpaint 원본·마스크는 복원하지 않습니다.');
    if (Object.keys(settings).length < 2 && shared.seed === undefined && typeof base !== 'string') throw new Error('가져올 수 있는 생성 설정이 없습니다.');
    return { model, settings, shared, prompts, characters, warnings: [...new Set(warnings)], source: result.source, format: result.format };
}

export function applyMetadataImport(nai, plan, options) {
    if (!options.generation && !options.prompts && !options.main && !options.uc && !options.characters && !options.seed) throw new Error('가져올 항목을 하나 이상 선택해 주세요.');
    // Copy only the branch being changed; image data and other model settings stay shared.
    const next = { ...nai, directSettings: { ...nai.directSettings, [plan.model]: { ...nai.directSettings?.[plan.model] } } };
    next.generationMode = plan.model;
    next.directSettings ??= {};
    const settings = next.directSettings[plan.model] ??= {};
    if (options.generation) {
        Object.assign(settings, plan.settings);
        if (plan.shared.cfg_rescale !== undefined) next.cfg_rescale = plan.shared.cfg_rescale;
        next.vibeEnabled = false; next.refEnabled = false;
    }
    if (options.prompts) Object.assign(settings, plan.prompts); // Compatibility for existing callers.
    if (options.main && plan.prompts.prefix !== undefined) {
        settings.prefix = plan.prompts.prefix;
        settings.quality = plan.prompts.quality;
        settings.dataset = plan.prompts.dataset;
        if (plan.prompts.transparent !== undefined) settings.transparent = plan.prompts.transparent;
    }
    if (options.uc && plan.prompts.negative_prompt !== undefined) {
        settings.negative_prompt = plan.prompts.negative_prompt;
        settings.ucPreset = plan.prompts.ucPreset;
    }
    if (options.characters) {
        settings.importedCharacters = structuredClone(plan.characters);
        settings.useImportedCharacters = plan.characters.length > 0;
        if (plan.shared.useCharacterPositionsAiChoice !== undefined) next.useCharacterPositionsAiChoice = plan.shared.useCharacterPositionsAiChoice;
    }
    if (options.seed && plan.shared.seed !== undefined) { next.seed = plan.shared.seed; next.seedEnabled = true; }
    return next;
}
