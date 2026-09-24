import { createAutopicId } from './id.mjs';
// Only small, explicitly selected values belong in a style preset. Never store images.
const fields = ['width', 'height', 'steps', 'scale', 'sampler', 'scheduler', 'quality', 'ucPreset', 'uc_preset', 'prefix', 'negative_prompt', 'dataset', 'transparent', 'variety', 'normalizeVibes'];
export function styleSnapshot(nai, settings) {
    const values = {};
    for (const key of fields) {
        const value = settings[key];
        if (['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))) values[key] = value;
    }
    const snapshot = { settings: values, cfg_rescale: Number(nai.cfg_rescale) || 0 };
    if (JSON.stringify(snapshot).length > 16000) throw new Error('그림체 프롬프트가 너무 깁니다. 프리셋은 16,000자 이내로 저장해 주세요.');
    return snapshot;
}
export function storeStyle(nai, name, snapshot, updateId) {
    name = String(name).trim();
    if (!name || name.length > 48) throw new Error('이름을 1~48자로 입력해 주세요.');
    const items = nai.stylePresets || [];
    const current = items.find(p => p.id === updateId && p.model === nai.generationMode);
    if (updateId && !current) throw new Error('갱신할 프리셋을 선택해 주세요.');
    if (items.some(p => p !== current && p.model === nai.generationMode && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('같은 이름이 있습니다. 해당 프리셋을 선택해 갱신하세요.');
    if (items.some(p => p !== current && p.model === nai.generationMode && JSON.stringify(p.snapshot) === JSON.stringify(snapshot))) throw new Error('동일한 설정의 프리셋이 이미 있습니다.');
    if (!current && items.length >= 32) throw new Error('프리셋은 두 모델을 합쳐 최대 32개입니다. 사용하지 않는 항목을 삭제해 주세요.');
    const entry = { id: current?.id || createAutopicId(), model: nai.generationMode, name, snapshot };
    const next = current ? items.map(p => p === current ? entry : p) : [...items, entry];
    if (JSON.stringify(next).length > 128000) throw new Error('프리셋 저장 한도에 도달했습니다. 긴 프롬프트나 사용하지 않는 항목을 줄여 주세요.');
    nai.stylePresets = next;
    return entry.id;
}
export function bindStylePresets(getNai, getSettings, save, refresh) {
    const selected = new Map();
    const status = (text, error = false) => $('#nai_style_status').text(text).prop('hidden', !text).toggleClass('is-error', error);
    let lastItems, lastModel, lastId;
    function render(force = false) {
        const nai = getNai(), items = (nai.stylePresets || []).filter(p => p.model === nai.generationMode);
        const id = selected.get(nai.generationMode) || '';
        if (!force && lastItems === nai.stylePresets && lastModel === nai.generationMode && lastId === id) return;
        lastItems = nai.stylePresets; lastModel = nai.generationMode; lastId = id;
        const select = $('#nai_style_select').empty().append(new Option('그림체 선택…', ''));
        items.forEach(p => select.append(new Option(p.name, p.id)));
        select.val(items.some(p => p.id === id) ? id : '');
        const item = items.find(p => p.id === select.val());
        $('#nai_style_name').val(item?.name || '');
        $('#nai_style_update, #nai_style_delete').prop('disabled', !item);
        status('');
    }
    $('#nai_style_select').off('.apStyle').on('change.apStyle', function () {
        const nai = getNai(), item = (nai.stylePresets || []).find(p => p.id === this.value && p.model === nai.generationMode);
        selected.set(nai.generationMode, this.value);
        if (!item) { render(); return; }
        nai.directSettings ??= {};
        nai.directSettings[nai.generationMode] = { ...nai.directSettings[nai.generationMode], ...item.snapshot.settings };
        nai.cfg_rescale = item.snapshot.cfg_rescale;
        save(); refresh({ replacePrompts: ['prefix', 'negative_prompt'] });
    });
    $('#nai_style_save, #nai_style_update').off('.apStyle').on('click.apStyle', function () {
        try {
            const nai = getNai(), settings = getSettings();
            if (!settings) throw new Error('모델 설정을 불러온 뒤 저장해 주세요.');
            const id = storeStyle(nai, $('#nai_style_name').val(), styleSnapshot(nai, settings), this.id === 'nai_style_update' ? $('#nai_style_select').val() : undefined);
            selected.set(nai.generationMode, id); save(); render(); status('그림체를 저장했습니다.');
        } catch (error) { status(error.message, true); }
    });
    $('#nai_style_delete').off('.apStyle').on('click.apStyle', () => {
        const nai = getNai(), id = $('#nai_style_select').val();
        if (!id) return;
        nai.stylePresets = (nai.stylePresets || []).filter(p => p.id !== id || p.model !== nai.generationMode);
        if (!nai.stylePresets.length) delete nai.stylePresets;
        selected.delete(nai.generationMode); save(); render(); status('프리셋을 삭제했습니다. 현재 생성 설정은 유지됩니다.');
    });
    return render;
}
