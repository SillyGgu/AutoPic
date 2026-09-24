import { createAutopicId } from './id.mjs';
import { parseAutopic, assertNoAutopicTags } from './structured-prompt.mjs';
import { planMetadataImport, applyMetadataImport, RESOLUTION_PRESETS, resolutionPreset } from './nai-metadata-import.mjs';
import { bindStylePresets } from './nai-presets.mjs';
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
let renderStylePresets = () => {};
let activeProfile;
let dropBinding;
const promptDrafts = new Map();
const manualPrompts = ['prefix', 'negative_prompt'];
function draftFor(model) {
    if (!promptDrafts.has(model)) promptDrafts.set(model, {});
    return promptDrafts.get(model);
}
function promptState(model, field) {
    const dirty = Object.hasOwn(draftFor(model), field);
    $(`#nai-params-card [data-save-prompt="${field}"]`).prop('disabled', !dirty);
    $(`#nai-params-card [data-prompt-status="${field}"]`).text(dirty ? '저장하지 않은 변경' : '저장된 내용');
}
const importedLists = new WeakMap();

let modelRequest;
let importJob = 0;
let cancelImport;
let pendingImport;

export function readMetadataBuffer(buffer, signal) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./nai-metadata-worker.mjs', import.meta.url), { type: 'module' });
        const finish = (error, result) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(result); };
        const abort = () => finish(new Error('메타데이터 불러오기를 취소했습니다.'));
        const timer = setTimeout(() => finish(new Error('메타데이터를 읽는 데 너무 오래 걸립니다. 더 작은 원본 파일을 사용해 주세요.')), 25000);
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
        worker.onerror = () => finish(new Error('이미지 분석 모듈을 불러오지 못했습니다. AutoPic 파일을 모두 업데이트해 주세요.'));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage(buffer, [buffer]);
    });
}

function importStatus(text, error = false) {
    $('#nai_metadata_status').prop('hidden', !text).text(text).toggleClass('is-error', error);
}
function closeImport() {
    importJob++; cancelImport?.abort(); cancelImport = undefined; pendingImport = undefined;
    $('#nai_metadata_preview').prop('hidden', true);
    $('#nai_metadata_dropzone').attr('aria-busy', 'false');
    $('#nai_metadata_pick').prop('disabled', false);
}
async function inspectMetadataFile(file, getNai) {
    closeImport();
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) { importStatus('40MB 이하의 이미지를 선택해 주세요.', true); return; }
    const job = importJob, model = getNai().generationMode;
    cancelImport = new AbortController();
    const signal = cancelImport.signal;
    $('#nai_metadata_dropzone').attr('aria-busy', 'true');
    $('#nai_metadata_pick').prop('disabled', true);
    importStatus('이미지의 일반 정보와 숨김 정보를 확인하고 있습니다…');
    try {
        const buffer = await file.arrayBuffer();
        if (job !== importJob) return;
        const result = await readMetadataBuffer(buffer, signal);
        const models = await getDirectModels();
        if (job !== importJob || model !== getNai().generationMode) return;
        const plan = planMetadataImport(result, models, model);
        pendingImport = plan;
        $('#nai_metadata_filename').text(file.name);
        const summary = $('#nai_metadata_summary').empty();
        const entries = [models[plan.model].name, `${result.format.toUpperCase()} · ${plan.source}`];
        if (plan.settings.width && plan.settings.height) entries.push(`${plan.settings.width} × ${plan.settings.height}`);
        if (plan.settings.steps !== undefined) entries.push(`${plan.settings.steps} Steps`);
        if (plan.settings.scale !== undefined) entries.push(`Guidance ${plan.settings.scale}`);
        if (plan.shared.seed !== undefined) entries.push(`Seed ${plan.shared.seed}`);
        if (plan.characters.length) entries.push(`캐릭터 ${plan.characters.length}`);
        entries.forEach(text => summary.append($('<span>').text(text)));
        $('#nai_metadata_prompt').text([plan.prompts.prefix || '', plan.prompts.negative_prompt ? `UC: ${plan.prompts.negative_prompt}` : '', ...plan.characters.map((c, i) => `Character ${i + 1}: ${c.prompt}\nUC: ${c.uc}`)].filter(Boolean).join('\n\n'));
        const notices = $('#nai_metadata_warnings').empty();
        plan.warnings.forEach(text => notices.append($('<li>').text(text)));
        $('#nai_import_generation').prop('checked', true);
        $('#nai_import_seed').prop('disabled', plan.shared.seed === undefined).prop('checked', plan.shared.seed !== undefined);
        $('#nai_import_prompts').prop('checked', false).prop('disabled', plan.prompts.prefix === undefined);
        $('#nai_import_uc').prop('checked', false).prop('disabled', plan.prompts.negative_prompt === undefined);
        $('#nai_import_characters').prop('checked', false).prop('disabled', plan.characters.length === 0);
        $('#nai_metadata_preview').prop('hidden', false);
        importStatus('설정을 찾았습니다. 가져올 항목을 선택해 적용하세요.');
    } catch (error) { if (job === importJob) importStatus(error.message, true); }
    finally {
        if (job === importJob) { $('#nai_metadata_dropzone').attr('aria-busy', 'false'); $('#nai_metadata_pick').prop('disabled', false); }
    }
}

function syncResolution() {
    const width = $('#nai-params-card [data-direct="width"]').val(), height = $('#nai-params-card [data-direct="height"]').val();
    const preset = resolutionPreset(width, height);
    $('#nai-params-card [data-resolution]').each(function () { $(this).attr('aria-pressed', String(this.dataset.resolution === preset)); });
    $('#nai_resolution_label').text(`${width || '—'} × ${height || '—'}${preset === 'custom' ? ' · 사용자 지정' : ''}`);
}
let referenceSource;
let referenceCanvas;
async function prepareReference(source, letterbox) {
    if (referenceSource !== source) {
        referenceSource = source;
        referenceCanvas = Promise.resolve().then(() => letterbox(`data:image/png;base64,${source}`));
    }
    try {
        const image = await referenceCanvas;
        if (!image) throw new Error('Reference 이미지 변환에 실패했습니다.');
        return image;
    } catch (error) {
        if (referenceSource === source) { referenceSource = undefined; referenceCanvas = undefined; }
        throw error;
    }
}
export async function getDirectModels() {
    if (!modelRequest) {
        modelRequest = fetch('/api/plugins/autopic/direct-models').then(async response => {
            if (!response.ok) throw new Error('autopic-nai-proxy를 업데이트하고 ST 서버를 재시작해 주세요.');
            const data = await response.json();
            if (data.version !== 1 || !data.models) throw new Error('AutoPic 서버 플러그인 버전이 맞지 않습니다.');
            return data.models;
        }).catch(error => { modelRequest = undefined; throw error; });
    }
    return modelRequest;
}

export function isDirect(nai) { return !!nai.generationMode && nai.generationMode !== 'legacy'; }
export function directSettings(nai, profile) {
    nai.directSettings ??= {};
    nai.directSettings[nai.generationMode] ??= {};
    return { ...profile.defaults, prefix: '', negative_prompt: '', dataset: 'anime', transparent: false, variety: false, normalizeVibes: true, useImportedCharacters: false, ...nai.directSettings[nai.generationMode] };
}

export function bindDirectSettings(getNai, save, refresh) {
    closeImport();
    renderStylePresets = bindStylePresets(getNai, () => activeProfile?.id === getNai().generationMode ? directSettings(getNai(), activeProfile.profile) : null, save, refresh);
    const setSize = (width, height) => {
        const nai = getNai();
        nai.directSettings ??= {};
        const settings = nai.directSettings[nai.generationMode] ??= {};
        if (settings.width === width && settings.height === height) return;
        Object.assign(settings, { width, height });
        $('#nai-params-card [data-direct=width]').val(width); $('#nai-params-card [data-direct=height]').val(height);
        syncResolution(); save();
    };
    $('#nai_generation_mode').off('.autopicDirect').on('change.autopicDirect', function () {
        closeImport(); importStatus('');
        getNai().generationMode = this.value;
        save();
        refresh();
    });
    $('#nai-params-card [data-direct]').off('.autopicDirect').on('change.autopicDirect', function () {
        if (manualPrompts.includes(this.dataset.direct)) return;
        const nai = getNai();
        nai.directSettings ??= {};
        nai.directSettings[nai.generationMode] ??= {};
        nai.directSettings[nai.generationMode][this.dataset.direct] = this.type === 'checkbox' ? this.checked : this.type === 'number' ? (this.value === '' ? null : Number(this.value)) : this.value;
        save();
        if (['width', 'height'].includes(this.dataset.direct)) syncResolution();
    });
    $('#nai-params-card textarea[data-direct]').on('input.autopicDirect', function () {
        const field = this.dataset.direct;
        if (!manualPrompts.includes(field)) return;
        const nai = getNai(), drafts = draftFor(nai.generationMode);
        if (this.value === (nai.directSettings?.[nai.generationMode]?.[field] || '')) delete drafts[field];
        else drafts[field] = this.value;
        promptState(nai.generationMode, field);
    });
    $('#nai-params-card [data-save-prompt]').off('.autopicDirect').on('click.autopicDirect', function () {
        const nai = getNai(), field = this.dataset.savePrompt, drafts = draftFor(nai.generationMode);
        if (!Object.hasOwn(drafts, field)) return;
        nai.directSettings ??= {};
        (nai.directSettings[nai.generationMode] ??= {})[field] = drafts[field];
        delete drafts[field]; save(); promptState(nai.generationMode, field);
    });
    $('#nai-params-card [data-resolution]').off('.autopicDirect').on('click.autopicDirect', function () {
        const size = RESOLUTION_PRESETS[this.dataset.resolution];
        setSize(size.width, size.height);
        $('#nai_custom_resolution').prop('open', false);
    });
    $('#nai_swap_size').off('.autopicDirect').on('click.autopicDirect', () => {
        setSize(Number($('#nai-params-card [data-direct=height]').val()), Number($('#nai-params-card [data-direct=width]').val()));
    });
    $('#nai_metadata_pick').off('.autopicDirect').on('click.autopicDirect', () => $('#nai_metadata_file').trigger('click'));
    $('#nai_metadata_file').off('.autopicDirect').on('change.autopicDirect', function () { const file = this.files?.[0]; this.value = ''; void inspectMetadataFile(file, getNai); });
    // Keep file drags inside AutoPic: ST and other extensions may use document drop handlers.
    dropBinding?.abort(); dropBinding = new AbortController();
    const zone = document.getElementById('nai_metadata_dropzone');
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
        zone?.addEventListener(type, event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
            if (type === 'dragenter' || type === 'dragover') { zone.classList.add('is-dragging'); event.dataTransfer.dropEffect = 'copy'; }
            if (type === 'dragleave' && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
            if (type === 'drop') { zone.classList.remove('is-dragging'); void inspectMetadataFile(event.dataTransfer.files?.[0], getNai); }
        }, { signal: dropBinding.signal });
    }
    $('#nai_metadata_close').off('.autopicDirect').on('click.autopicDirect', () => { closeImport(); importStatus(''); });
    $('#nai_metadata_apply').off('.autopicDirect').on('click.autopicDirect', () => {
        if (!pendingImport) return;
        try {
            const options = Object.fromEntries(['generation', 'seed', 'prompts', 'uc', 'characters'].map(key => [key, $(`#nai_import_${key}`).prop('checked') && !$(`#nai_import_${key}`).prop('disabled')]));
            Object.assign(getNai(), applyMetadataImport(getNai(), pendingImport, { ...options, main: options.prompts, prompts: false }));
            save(); closeImport(); refresh({ replacePrompts: [options.prompts && 'prefix', options.uc && 'negative_prompt'].filter(Boolean) }); importStatus('선택한 항목만 적용했습니다. 제외한 항목은 현재 설정을 유지합니다.');
        } catch (error) { importStatus(error.message, true); }
    });
    $('#nai_clear_imported_characters').off('.autopicDirect').on('click.autopicDirect', () => {
        const nai = getNai(), settings = nai.directSettings?.[nai.generationMode];
        if (settings) { delete settings.importedCharacters; settings.useImportedCharacters = false; save(); refresh(); }
    });
}

let refreshId = 0;
export async function refreshDirectSettings(getNai, options = {}) {
    const id = ++refreshId;
    const nai = getNai();
    for (const field of options.replacePrompts || []) delete draftFor(nai.generationMode)[field];
    const direct = isDirect(nai);
    syncCharacterPositionVisibility(nai);
    $('#nai_generation_mode').val(nai.generationMode || 'legacy');
    $('#nai_direct_options, .ap-direct-only').prop('hidden', !direct);
    $('.ap-legacy-options').prop('hidden', direct);
    $('#nai_model_badge').text(direct ? nai.generationMode === 'nai-diffusion-5-full' ? 'V5 FULL' : 'V4.5 FULL' : 'ST');
    $('#nai_use_server_plugin').prop('disabled', direct);
    $('#nai_vibe_enabled, #nai_ref_enabled').prop('disabled', false);
    $('#nai_reference_controls').prop('hidden', false);
    $('#nai_reference_unavailable').prop('hidden', true);
    if (!direct) { $('#nai-params-card').css('opacity', '1'); return; }
    $('#nai-params-card').css('opacity', '1');
    $('#nai_plugin_options').css({ opacity: '1', 'pointer-events': 'auto' });
    $('#nai_direct_status').text('모델 설정 확인 중…');
    try {
        const models = await getDirectModels();
        if (id !== refreshId) return;
        const profile = models[nai.generationMode];
        if (!profile) throw new Error('지원하지 않는 직접 생성 모델입니다.');
        activeProfile = { id: nai.generationMode, profile };
        const settings = directSettings(nai, profile);
        renderStylePresets();
        for (const [field, values] of Object.entries({ sampler: profile.samplers, scheduler: profile.schedulers, quality: profile.qualityPresets })) {
            const select = $(`#nai_direct_options [data-direct="${field}"]`);
            if (select.attr('data-options-model') === nai.generationMode) continue;
            select.empty().attr('data-options-model', nai.generationMode);
            const names = { k_euler_ancestral: 'Euler Ancestral', k_euler: 'Euler', k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral', k_dpmpp_2m: 'DPM++ 2M', k_dpmpp_sde: 'DPM++ SDE', k_dpmpp_2m_sde: 'DPM++ 2M SDE', karras: 'Karras', exponential: 'Exponential', polyexponential: 'Polyexponential', standard: 'Standard', light: 'Light', none: '없음' };
            values.forEach(value => select.append(new Option(names[value] || value, value)));
        }
        $('#nai-params-card [data-direct]').each(function () {
            if (this.type === 'checkbox') this.checked = !!settings[this.dataset.direct];
            else {
                const field = this.dataset.direct;
                const value = manualPrompts.includes(field) && Object.hasOwn(draftFor(nai.generationMode), field) ? draftFor(nai.generationMode)[field] : settings[field] ?? '';
                // Avoid moving the caret or resetting undo/composition when nothing changed.
                if (this.value !== String(value)) this.value = value;
                if (manualPrompts.includes(field)) promptState(nai.generationMode, field);
            }
        });
        syncResolution();
        if (resolutionPreset(settings.width, settings.height) === 'custom') $('#nai_custom_resolution').prop('open', true);
        const imported = Array.isArray(settings.importedCharacters) ? settings.importedCharacters : [];
        $('#nai_imported_characters').prop('hidden', !imported.length);
        const list = $('#nai_imported_character_list');
        if (list[0] && importedLists.get(list[0]) !== settings.importedCharacters && !list.find(':focus').length) {
            importedLists.set(list[0], settings.importedCharacters);
            list.empty();
            imported.forEach((character, index) => {
                const row = $('<div class="ap-field">').append($('<span>').text(`캐릭터 ${index + 1}`));
                for (const [key, label] of [['prompt', '프롬프트'], ['uc', 'UC']]) {
                    row.append($('<textarea class="gen-custom-input" rows="2">').attr('aria-label', `가져온 캐릭터 ${index + 1} ${label}`).val(character[key] || '').on('change', function () {
                        getNai().directSettings[nai.generationMode].importedCharacters[index][key] = this.value;
                        // Use ST's existing setting persistence callback (no extra server request).
                        $('#nai-params-card [data-direct="useImportedCharacters"]').trigger('change');
                    }));
                }
                list.append(row);
            });
        }
        $('#nai-params-card [data-feature="transparency"]').prop('hidden', !profile.transparency);
        $('#nai-params-card [data-feature="variety"]').prop('hidden', !profile.variety);
        $('#nai-params-card [data-direct="transparent"]').prop('disabled', !profile.transparency);
        $('#nai-params-card [data-direct="variety"]').prop('disabled', !profile.variety);
        $('#nai-params-card [data-direct="scheduler"]').prop('disabled', profile.schedulers.length === 1);
        $('#nai-params-card [data-direct="normalizeVibes"]').prop('disabled', !profile.vibe);
        $('#nai_vibe_enabled').prop('disabled', !profile.vibe);
        $('#nai_ref_enabled').prop('disabled', !profile.reference);
        $('#nai_reference_controls').prop('hidden', !profile.vibe && !profile.reference);
        $('#nai_reference_unavailable').prop('hidden', profile.vibe || profile.reference);
        if (!profile.vibe) $('#nai_vibe_options').css({ opacity: '0.4', 'pointer-events': 'none' });
        if (!profile.reference) $('#nai_ref_options').css({ opacity: '0.4', 'pointer-events': 'none' });
        $('#nai_direct_status').text(profile.transparency
            ? '최대 22캐릭터 · 자유 좌표 · 투명 PNG · Karras 고정'
            : '최대 6캐릭터 · 격자 좌표 · Vibe & Precise Reference');
    } catch (error) {
        if (id === refreshId) $('#nai_direct_status').text(error.message);
    }
}

/** Merge independent sections without repeating an already imported final scene.
 * Deliberately never split by commas: weighting groups and rendered text are meaningful.
 */
export function joinDirectSections(prefix, scene) {
    const a = String(prefix || '').trim(), b = String(scene || '').trim();
    if (!a) return b;
    if (!b || a === b || a.endsWith(', ' + b)) return a;
    if (b.startsWith(a + ', ')) return b;
    return `${a}, ${b}`;
}

/** Generates and saves a PNG using ST's image storage, without invoking /sd. */
export async function generateDirect({ nai, prompt, payload, library = [], context, getHeaders, saveImage, letterbox }) {
    // Snapshot before awaiting: changing settings mid-request must not change its model/seed.
    nai = { ...nai, vibeImages: nai.vibeImages?.map(v => ({ ...v })),
        directSettings: { [nai.generationMode]: structuredClone(nai.directSettings?.[nai.generationMode] || {}) } };
    delete nai.stylePresets;
    const models = await getDirectModels();
    const profile = models[nai.generationMode];
    if (!profile) throw new Error('지원하지 않는 직접 생성 모델입니다.');
    const settings = directSettings(nai, profile);
    const parsed = parseAutopic(payload?.prompt ?? prompt, library);
    if (parsed) payload = parsed;
    const prefix = parseAutopic(settings.prefix, library);
    if (prefix) {
        settings.prefix = prefix.prompt;
        if (!payload?.characterPrompts?.length) payload = { ...prefix, ...payload, characterPrompts: prefix.characterPrompts };
    }
    const seed = nai.seedEnabled ? Number(nai.seed) : undefined;
    if (nai.seedEnabled && (String(nai.seed).trim() === '' || !Number.isInteger(seed) || seed < 0 || seed > 4294967295)) throw new Error('Seed는 0~4294967295 정수여야 합니다.');
    const body = {
        ...settings, model: nai.generationMode, seed,
        prompt: joinDirectSections(settings.prefix, payload?.prompt ?? prompt),
        negative_prompt: joinDirectSections(settings.negative_prompt, payload?.negative_prompt),
        characterPrompts: settings.useImportedCharacters && Array.isArray(settings.importedCharacters) ? settings.importedCharacters : payload?.characterPrompts ?? [],
        cfg_rescale: nai.cfg_rescale,
        character_positions_ai_choice: nai.useCharacterPositionsAiChoice,
        transparent: profile.transparency && settings.transparent,
        variety: profile.variety && settings.variety,
        scheduler: profile.schedulers.length === 1 ? profile.schedulers[0] : settings.scheduler,
    };
    assertNoAutopicTags(body.prompt); assertNoAutopicTags(body.negative_prompt);
    for (const character of body.characterPrompts) { assertNoAutopicTags(character.prompt); assertNoAutopicTags(character.uc); }
    delete body.importedCharacters; delete body.useImportedCharacters; delete body.prefix;
    if (profile.vibe && nai.vibeEnabled) body.vibes = (nai.vibeImages ?? []).filter(v => v.base64).map(v => ({ image: v.base64, information: v.infoExtracted ?? 0.7, strength: v.strength ?? 0.6 }));
    if (profile.reference && nai.refEnabled && nai.refImage) {
        const image = await prepareReference(nai.refImage, letterbox);
        if (!image) throw new Error('Reference 이미지 변환에 실패했습니다.');
        body.reference = { image, mode: nai.refMode, strength: nai.refStrength, fidelity: nai.refFidelity };
    }
    const response = await fetch('/api/plugins/autopic/generate-direct', { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
    if (!response.ok) {
        let message = `AutoPic 직접 생성 실패 (HTTP ${response.status})`;
        try { message = (await response.json()).message || message; } catch { /* preserve HTTP error */ }
        throw new Error(message);
    }
    const base64 = await response.text();
    if (!base64.startsWith('iVBORw0KGgo')) throw new Error('AutoPic 서버에서 올바른 PNG를 받지 못했습니다.');
    const characterName = context.characters?.[context.characterId]?.name || 'AutoPic';
    return saveImage(base64, characterName, `autopic_${Date.now()}_${createAutopicId()}`, 'png');
}

export function syncCharacterPositionVisibility(nai) {
    const enabled = isDirect(nai) && !nai.useCharacterPositionsAiChoice;
    $('.ap-character-position').each(function () {
        const active = enabled && !!$(this).closest('.char-prompt-item').find('.char-enabled-checkbox').prop('checked');
        this.hidden = !active;
        $(this).find('input').prop('disabled', !active);
    });
}
