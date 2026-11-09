import { MAX_MANUAL_IMAGES } from './manual-generation.mjs';
import { getManualPresetEntries } from './manual-prompt.mjs';

export function bindManualPresetSelection(root, { getManualParams, getContext, save }) {
    if (!root) return;
    const enabled = root.querySelector('#autopic_manual_preset_enabled');
    const fields = root.querySelector('#autopic_manual_preset_fields');
    const preset = root.querySelector('#autopic_manual_preset_name');
    const item = root.querySelector('#autopic_manual_preset_item');

    function store(changes) {
        const manual = getManualParams();
        manual.presetPrompt = { ...manual.presetPrompt, ...changes };
        save();
    }

    function refreshItems() {
        const entries = getManualPresetEntries(getContext(), preset.value);
        const selectedId = getManualParams().presetPrompt?.itemId;
        item.replaceChildren(new Option(entries.length ? '지시문을 선택하세요' : '선택할 지시문이 없습니다', ''));
        for (const prompt of entries) item.add(new Option(prompt.name || prompt.identifier, prompt.identifier));
        item.value = entries.some(prompt => prompt.identifier === selectedId) ? selectedId : '';
        item.disabled = !entries.length;
    }

    function refreshPresets() {
        const selected = getManualParams().presetPrompt?.presetName ?? '';
        const names = getContext().getPresetManager?.('openai')?.getAllPresets?.() ?? [];
        preset.replaceChildren(new Option('현재 Chat Completion 프리셋', ''), ...names.map(name => new Option(name, name)));
        if (selected && !names.includes(selected)) preset.add(new Option(`${selected} (사용할 수 없음)`, selected));
        preset.value = selected;
        refreshItems();
    }

    const stored = getManualParams().presetPrompt;
    enabled.checked = !!stored?.enabled;
    fields.hidden = !enabled.checked;
    if (enabled.checked) refreshPresets();

    enabled.addEventListener('change', () => {
        store({ enabled: enabled.checked });
        fields.hidden = !enabled.checked;
        if (enabled.checked) refreshPresets();
    });
    preset.addEventListener('focus', refreshPresets);
    preset.addEventListener('change', () => {
        store({ presetName: preset.value, itemId: '' });
        refreshItems();
    });
    item.addEventListener('change', () => store({ itemId: item.value }));
    const roleDefaults = { instruction: 'system', preset: 'system', task: 'user' };
    for (const [part, defaultRole] of Object.entries(roleDefaults)) {
        const control = root.querySelector(`[data-manual-role="${part}"]`);
        const manual = getManualParams();
        const legacyRole = part === 'preset' ? stored?.role : undefined;
        control.value = manual.promptRoles?.[part] ?? legacyRole ?? defaultRole;
        if (!control.value) control.value = defaultRole;
        control.addEventListener('change', () => {
            const current = getManualParams();
            current.promptRoles = { ...current.promptRoles, [part]: control.value };
            save();
        });
    }
}

export async function showManualGenerationOptions({ existing, lastOptions, popup, popupType, warn }) {
    const root = document.createElement('div');
    root.className = 'ap-manual-dialog';
    root.innerHTML = `<h3>수동 이미지 생성</h3>
        <label class="ap-manual-field">이런 장면으로 그려줘 <small>선택 · 비워 두면 대화에서 장면을 고릅니다.</small>
        <textarea data-manual="request" rows="3" placeholder="예: 첫 장은 창가에서 대화하는 모습, 두 번째는 밖으로 나서는 장면"></textarea></label>
        <div class="ap-manual-grid">
        <label class="ap-manual-field">삽화 개수<input data-manual="count" type="number" min="1" max="${MAX_MANUAL_IMAGES}" step="1" value="1"><small>1–${MAX_MANUAL_IMAGES}개 · 각각 다른 장면</small></label>
        <label class="ap-manual-field">삽화 위치<select data-manual="placement"><option value="bottom">메시지 하단</option><option value="free">자유 배치 · AI가 문단 사이에 배치</option></select></label>
        </div>
        <label class="ap-manual-field">참고 대화<select data-manual="previous"><option value="0">선택한 메시지 1개만 (기본)</option><option value="1">선택한 메시지 + 직전 메시지</option><option value="2">선택한 메시지 + 이전 2개</option><option value="4">선택한 메시지 + 이전 4개</option><option value="8">선택한 메시지 + 이전 8개</option></select><small>이후 메시지는 참고하지 않습니다.</small></label>
        ${existing ? `<label class="ap-manual-field ap-manual-existing">이미 태그 또는 이미지가 있습니다<select data-manual="mode" required><option value="">추가할지, 새로 생성할지 선택하세요</option><option value="append">추가 생성 · 기존 태그와 이미지 유지</option><option value="replace">새로 생성 · 이 메시지의 AutoPic 태그와 이미지 교체</option></select><small>현재 답변의 AutoPic 항목만 교체합니다. 원본 이미지 파일은 삭제하지 않습니다.</small></label>` : ''}
        <p class="ap-manual-help">생성을 누르면 입력과 선택을 다음 창에 불러옵니다. 자유 배치는 빈 줄로 나뉜 문단 사이에 넣으며, 문단이 하나면 하단에 들어갑니다.</p>`;
    if (lastOptions) {
        const count = Number(lastOptions.count);
        if (Number.isInteger(count) && count >= 1 && count <= MAX_MANUAL_IMAGES) {
            root.querySelector('[data-manual="count"]').value = String(count);
        }
        if (typeof lastOptions.request === 'string') root.querySelector('[data-manual="request"]').value = lastOptions.request;
        for (const key of ['placement', 'previous', 'mode']) {
            const select = root.querySelector(`[data-manual="${key}"]`);
            const value = String(lastOptions[key] ?? '');
            if (select && Array.from(select.options).some(option => option.value === value)) select.value = value;
        }
    }
    let options;
    const result = await popup(root, popupType, '', {
        okButton: '생성', cancelButton: '취소', wider: true,
        onClosing: dialog => {
            if (dialog.result !== 1) return true;
            const read = key => root.querySelector(`[data-manual="${key}"]`)?.value || '';
            const count = Number(read('count'));
            if (!Number.isInteger(count) || count < 1 || count > MAX_MANUAL_IMAGES) { warn(`삽화 개수는 1~${MAX_MANUAL_IMAGES} 사이의 정수로 입력해 주세요.`); return false; }
            if (existing && !read('mode')) { warn('추가 생성 또는 새로 생성을 선택해 주세요.'); return false; }
            options = {request: read('request').trim(), count, placement: read('placement'), previous: Number(read('previous')), mode: existing ? read('mode') : 'append'};
            return true;
        },
    });
    return result ? options : null;
}

