import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    characters,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';


const extensionName = 'AutoPic';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// ── NAI fetch 인터셉터 ────────────────────────────────────────
// ST의 /api/novelai/generate-image 요청을 가로채서
// AutoPic 프록시(/api/plugins/autopic/generate-image)로 리다이렉트한다.
// 프록시는 cfg_rescale을 포함해 NAI API에 전달한다.
(function installNaiFetchInterceptor() {
    const _fetch = window.fetch.bind(window);
    window.fetch = async function (input, init, ...rest) {
        const url = typeof input === 'string' ? input
            : (input instanceof Request ? input.url : String(input));

        if (url.includes('/api/novelai/generate-image') && init?.body && getNaiParams()?.useNaiRescale) {
            try {
                const body = JSON.parse(init.body);
                const cfg  = getNaiParams()?.cfg_rescale ?? 0;

                body.cfg_rescale = cfg;
                console.log('[AutoPic Interceptor] cfg_rescale 주입:', cfg, '→ 프록시로 리다이렉트');

                const newInit = { ...init, body: JSON.stringify(body) };
                const proxyResponse = await _fetch('/api/plugins/autopic/generate-image', newInit, ...rest);

                // 프록시 응답을 클론해서 PROHIBITED_CONTENT 여부 확인
                const cloned = proxyResponse.clone();
                try {
                    const json = await cloned.json();
                    if (json && json.statusCode === 400 && json.message && json.message.includes('PROHIBITED_CONTENT')) {
                        console.warn('[AutoPic Interceptor] PROHIBITED_CONTENT 감지 → 원본 경로로 fallback 재시도');
                        return _fetch(input, init, ...rest);
                    }
                } catch (_) {
                    // JSON 파싱 실패 시 그냥 원본 응답 반환
                }

                return proxyResponse;
            } catch (e) {
                console.warn('[AutoPic Interceptor] 파싱 실패, 원본 요청 통과:', e);
            }
        }

        return _fetch(input, init, ...rest);
    };
})();
// ─────────────────────────────────────────────────────────────

// ── NAI cfg_rescale 파라미터 ──────────────────────────────────
const NAI_DEFAULTS = { cfg_rescale: 0.0, useNaiRescale: false };

function getNaiParams() {
    const s = extension_settings[extensionName];
    if (!s.naiParams) s.naiParams = { ...NAI_DEFAULTS };
    for (const [k, v] of Object.entries(NAI_DEFAULTS)) {
        if (s.naiParams[k] === undefined) s.naiParams[k] = v;
    }
    return s.naiParams;
}
// ─────────────────────────────────────────────────────────────

const INSERT_TYPE = {
    DISABLED: 'disabled',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

/**
 * HTML 속성 값 안전 탈출
 */
function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}


const defaultAutoPicSettings = {
    insertType: INSERT_TYPE.DISABLED,
    lastNonDisabledType: INSERT_TYPE.INLINE, 
    theme: 'dark',
    promptInjection: {
        enabled: true,
        prompt: `<image_generation>\nYou must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.\n</image_generation>`,
        regex: '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
        position: 'deep_system',
        depth: 0, 
    },
    promptPresets: {
        "Default": `<image_generation>\nYou must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.\n</image_generation>`
    },
    linkedPresets: {},
    characterPrompts: {},
    naiParams: { ...NAI_DEFAULTS },
};
function updateUI() {
    $('#autopic_menu_item').toggleClass(
        'selected',
        extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED,
    );

    const currentTheme = extension_settings[extensionName].theme || 'dark';
    applyTheme(currentTheme);

    if ($('#image_generation_insert_type').length) {
        if (!$('#prompt_injection_text').is(':focus')) {
            updatePresetSelect();
            renderCharacterLinkUI();

            
            $('#prompt_injection_text').val(extension_settings[extensionName].promptInjection.prompt);
        }

        $('#image_generation_insert_type').val(extension_settings[extensionName].insertType);
        $('#prompt_injection_enabled').prop('checked', extension_settings[extensionName].promptInjection.enabled);
        $('#prompt_injection_regex').val(extension_settings[extensionName].promptInjection.regex);
        $('#prompt_injection_position').val(extension_settings[extensionName].promptInjection.position);
        $('#prompt_injection_depth').val(extension_settings[extensionName].promptInjection.depth);
        
        // NAI cfg_rescale UI 업데이트
        const nai = getNaiParams();
        $('#nai_use_rescale').prop('checked', !!nai.useNaiRescale);
        $('#nai_cfg_rescale').val(nai.cfg_rescale).prop('disabled', !nai.useNaiRescale);
        $('#nai_cfg_rescale_display').text(Number(nai.cfg_rescale).toFixed(2));
        // NAI Rescale 비활성화 시 카드 흐리게
        $('#nai-params-card').css('opacity', nai.useNaiRescale && extension_settings?.sd?.source === 'novel' ? '1' : '0.5');

        $('.theme-dot').removeClass('active');
        $(`.theme-dot[data-theme="${currentTheme}"]`).addClass('active');
    }
}

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultAutoPicSettings);
    } else {
        if (!extension_settings[extensionName].promptInjection) {
            extension_settings[extensionName].promptInjection = defaultAutoPicSettings.promptInjection;
        } else {
            const defaultPromptInjection = defaultAutoPicSettings.promptInjection;
            for (const key in defaultPromptInjection) {
                if (extension_settings[extensionName].promptInjection[key] === undefined) {
                    extension_settings[extensionName].promptInjection[key] = defaultPromptInjection[key];
                }
            }
        }
        if (extension_settings[extensionName].insertType === undefined) {
            extension_settings[extensionName].insertType = defaultAutoPicSettings.insertType;
        }
        if (extension_settings[extensionName].lastNonDisabledType === undefined) {
            extension_settings[extensionName].lastNonDisabledType = INSERT_TYPE.INLINE;
        }
        if (!extension_settings[extensionName].promptPresets) {
            extension_settings[extensionName].promptPresets = JSON.parse(JSON.stringify(defaultAutoPicSettings.promptPresets));
        }
        if (!extension_settings[extensionName].linkedPresets) {
            extension_settings[extensionName].linkedPresets = {};
        }
        // naiParams 초기화
        if (!extension_settings[extensionName].naiParams) {
            extension_settings[extensionName].naiParams = { ...NAI_DEFAULTS };
        } else {
            for (const [k, v] of Object.entries(NAI_DEFAULTS)) {
                if (extension_settings[extensionName].naiParams[k] === undefined)
                    extension_settings[extensionName].naiParams[k] = v;
            }
            // 구버전 호환: useNaiRescale이 없던 시절 저장된 경우 기본 false
            if (extension_settings[extensionName].naiParams.useNaiRescale === undefined) {
                extension_settings[extensionName].naiParams.useNaiRescale = false;
            }
        }
    }
    updateUI();
}


async function createSettings(settingsHtml) {
    if (!$('#autopic_settings_container').length) {
        $('#extensions_settings2').append(
            '<div id="autopic_settings_container" class="extension_container"></div>',
        );
    }

    $('#autopic_settings_container').empty().append(settingsHtml);


    $(document).off('click', '.image-gen-nav-item').on('click', '.image-gen-nav-item', function() {
        $('.image-gen-nav-item').removeClass('active');
        $(this).addClass('active');
        const targetTabId = $(this).data('tab');
        $('.image-gen-tab-content').removeClass('active');
        $('#' + targetTabId).addClass('active');
        
        if (targetTabId === 'tab-gen-linking') renderCharacterLinkUI();
        if (targetTabId === 'tab-gen-templates') renderCharacterPrompts();
    });


    $('#image_generation_insert_type').on('change', function () {
        extension_settings[extensionName].insertType = $(this).val();
        updateUI();
        saveSettingsDebounced();
    });
    $(document).on('click', '.theme-dot', function() {
        const selectedTheme = $(this).data('theme');
        extension_settings[extensionName].theme = selectedTheme;
        applyTheme(selectedTheme);
        
        $('.theme-dot').removeClass('active');
        $(this).addClass('active');
        
        saveSettingsDebounced();
    });
    $('#prompt_injection_enabled').on('change', function () {
        extension_settings[extensionName].promptInjection.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#prompt_injection_text').on('input', function () {
        const currentVal = $(this).val();
        const context = getContext();
        const charId = context.characterId;

        extension_settings[extensionName].promptInjection.prompt = currentVal;

        if (charId && characters[charId]) {
            const avatarFile = characters[charId].avatar;
            const linkedPresetName = extension_settings[extensionName].linkedPresets[avatarFile];
            if (linkedPresetName && extension_settings[extensionName].promptPresets[linkedPresetName] !== undefined) {
                extension_settings[extensionName].promptPresets[linkedPresetName] = currentVal;
            }
        }

        saveSettingsDebounced();
    });

    $('#prompt_preset_select').on('change', function() {
        const selectedKey = $(this).val();
        if (!selectedKey) return;

        const presets = extension_settings[extensionName].promptPresets;
        if (presets && presets[selectedKey] !== undefined) {
            const content = presets[selectedKey];
            
            $('#prompt_injection_text').val(content);
            extension_settings[extensionName].promptInjection.prompt = content;
            saveSettingsDebounced();
        }
    });
    $('#add_new_prompt_preset').on('click', function() {
        $('#prompt_preset_select').val(""); 
        $('#prompt_injection_text').val(""); 
        extension_settings[extensionName].promptInjection.prompt = ""; 
        saveSettingsDebounced();
        
        $('#prompt_injection_text').focus();
        toastr.info("내용을 입력한 후 저장 버튼을 누르면 새 템플릿이 생성됩니다.");
    });

    $('#rename_prompt_preset').on('click', async function() {
        const oldName = $('#prompt_preset_select').val();
        if (!oldName) {
            toastr.warning("수정할 템플릿을 먼저 선택해주세요.");
            return;
        }

        const newName = await callGenericPopup(
            `'${oldName}'의 새 이름을 입력하세요:`,
            POPUP_TYPE.INPUT,
            oldName
        );

        if (newName && newName.trim() && newName.trim() !== oldName) {
            const cleanNewName = newName.trim();
            const content = extension_settings[extensionName].promptPresets[oldName];

            extension_settings[extensionName].promptPresets[cleanNewName] = content;
            delete extension_settings[extensionName].promptPresets[oldName];

            const linked = extension_settings[extensionName].linkedPresets;
            for (const avatar in linked) {
                if (linked[avatar] === oldName) linked[avatar] = cleanNewName;
            }

            saveSettingsDebounced();
            updatePresetSelect();
            $('#prompt_preset_select').val(cleanNewName);
            toastr.success("템플릿 이름이 변경되었습니다.");
        }
    });

    $('#save_prompt_preset').on('click', async function() {
        const currentPrompt = $('#prompt_injection_text').val();
        if (!currentPrompt || !currentPrompt.trim()) {
            toastr.warning("내용이 비어있습니다.");
            return;
        }

        const selectedKey = $('#prompt_preset_select').val();

        if (selectedKey) {
            extension_settings[extensionName].promptPresets[selectedKey] = currentPrompt;
            saveSettingsDebounced();
            toastr.success(`'${selectedKey}' 저장 완료`);
        } else {
            const name = await callGenericPopup(
                `새 템플릿의 이름을 입력하세요:`,
                POPUP_TYPE.INPUT,
                "",
                { okButton: "저장", cancelButton: "취소" }
            );

            if (name && name.trim()) {
                const cleanName = name.trim();
                if (extension_settings[extensionName].promptPresets[cleanName]) {
                    toastr.error("이미 존재하는 이름입니다.");
                    return;
                }

                extension_settings[extensionName].promptPresets[cleanName] = currentPrompt;
                saveSettingsDebounced();
                
                updatePresetSelect();
                $('#prompt_preset_select').val(cleanName);
                toastr.success(`새 템플릿 '${cleanName}' 생성 완료`);
            }
        }
    });

    $('#delete_prompt_preset').on('click', async function() {
        const selectedKey = $('#prompt_preset_select').val();
        if (!selectedKey) {
            toastr.warning("삭제할 템플릿을 선택해주세요.");
            return;
        }
        const confirm = await callGenericPopup(
            `정말로 '${selectedKey}' 템플릿을 삭제하시겠습니까?`,
            POPUP_TYPE.CONFIRM
        );
        if (confirm) {
            delete extension_settings[extensionName].promptPresets[selectedKey];
            saveSettingsDebounced();
            updatePresetSelect();
            $('#prompt_injection_text').val("");
            extension_settings[extensionName].promptInjection.prompt = "";
            toastr.success(`'${selectedKey}' 템플릿이 삭제되었습니다.`);
        }
    });

    $('#gen-save-char-link-btn').on('click', onSaveCharLink);
    $('#gen-remove-char-link-btn').on('click', onRemoveCharLink);
    $('#gen-toggle-linked-list-btn').on('click', function() {
        const $list = $('#gen-linked-char-list-container');
        if ($list.is(':visible')) {
            $list.slideUp(200);
        } else {
            renderAllLinkedPresetsList();
            $list.slideDown(200);
        }
    });
    $('#gen-open-storage-mgmt-btn').off('click').on('click', function() {
        const $list = $('#gen-storage-mgmt-list-container');
        if ($list.is(':visible')) {
            $list.slideUp(200);
        } else {
            renderStorageManagementList();
            $list.slideDown(200);
        }
    });

    $('#prompt_injection_regex').on('input', function () {
        extension_settings[extensionName].promptInjection.regex = $(this).val();
        saveSettingsDebounced();
    });

    $('#prompt_injection_position').on('change', function () {
        extension_settings[extensionName].promptInjection.position = $(this).val();
        saveSettingsDebounced();
    });

    $('#prompt_injection_depth').on('input', function () {
        const value = parseInt(String($(this).val()));
        extension_settings[extensionName].promptInjection.depth = isNaN(value) ? 0 : value;
        saveSettingsDebounced();
    });

    // ── NAI cfg_rescale 바인딩 ────────────────────────────────
    $('#nai_use_rescale').on('change', function() {
        const enabled = $(this).prop('checked');
        getNaiParams().useNaiRescale = enabled;
        $('#nai_cfg_rescale').prop('disabled', !enabled);
        updateUI();
        saveSettingsDebounced();
        if (enabled) {
            toastr.info('NAI Rescale 활성화: AutoPic 서버 플러그인이 필요합니다.');
        }
    });
    $('#nai_cfg_rescale').on('input', function() {
        const val = parseFloat($(this).val());
        getNaiParams().cfg_rescale = isNaN(val) ? 0 : val;
        $('#nai_cfg_rescale_display').text(getNaiParams().cfg_rescale.toFixed(2));
        saveSettingsDebounced();
    });
    // ─────────────────────────────────────────────────────────

    updateUI();
}

/** -------------------------------------------------------
 * 캐릭터 연동 로직
 * ------------------------------------------------------- */

function renderCharacterLinkUI() {
    const context = getContext();
    const charId = context.characterId;
    const $statusBadge = $('#prompt_edit_status');
    
    if (!charId || !characters[charId]) {
        $('#gen-char-link-info-area').html('<span style="color: var(--color-text-vague);">캐릭터 정보를 불러올 수 없습니다.</span>');
        $('#gen-save-char-link-btn').prop('disabled', true);
        $statusBadge.text('전역 설정 편집 중').css('color', 'var(--ap-text-vague)');
        return;
    }

    const character = characters[charId];
    const avatarFile = character.avatar;
    const linkedPreset = extension_settings[extensionName].linkedPresets[avatarFile];

    let statusHtml = `<strong>현재 캐릭터:</strong> ${character.name}<br>`;
    
    if (linkedPreset && extension_settings[extensionName].promptPresets[linkedPreset]) {
        statusHtml += `<strong>연동된 템플릿:</strong> <span style="color: var(--accent-color); font-weight: bold;">${linkedPreset}</span>`;
        $('#gen-remove-char-link-btn').show();
        
        // 상태 표시줄 업데이트
        $statusBadge.html(`<i class="fa-solid fa-link"></i> ${character.name} 연동 템플릿 편집 중`).css('color', 'var(--ap-accent)');
        
        const presetContent = extension_settings[extensionName].promptPresets[linkedPreset];

        if (!$('#prompt_injection_text').is(':focus')) {
            extension_settings[extensionName].promptInjection.prompt = presetContent;
            $('#prompt_injection_text').val(presetContent);
            updatePresetSelect(linkedPreset);
        }
    } 
    else {
        statusHtml += `<strong>연동 상태:</strong> <span style="color: var(--color-text-vague);">없음 (전역 설정 사용 중)</span>`;
        $('#gen-remove-char-link-btn').hide();
        
        // 상태 표시줄 업데이트
        $statusBadge.text('전역 설정 편집 중').css('color', 'var(--ap-text-vague)');
        
        if (!$('#prompt_injection_text').is(':focus')) {
            updatePresetSelect();
        }
    }

    $('#gen-char-link-info-area').html(statusHtml);
    $('#gen-save-char-link-btn').prop('disabled', false);
}


function renderCharacterPrompts() {

    if ($('#char_prompts_list textarea:focus').length > 0) return;

    const context = getContext();
    const charId = context.characterId ?? (characters.findIndex(c => c.avatar === context.character?.avatar));
    const $list = $('#char_prompts_list');
    
    if (!$list.length) return;

    $list.empty();

    if (charId === undefined || charId === -1 || !characters[charId]) {
        $list.append('<div style="text-align:center; color:var(--ap-text-vague); font-size:0.8rem; padding: 20px;">캐릭터를 먼저 선택하거나 채팅을 시작해주세요.</div>');
        $('#add_char_prompt_btn').addClass('gen-btn-disabled').prop('disabled', true);
        return;
    }
    
    $('#add_char_prompt_btn').removeClass('gen-btn-disabled').prop('disabled', false);

    const avatarFile = characters[charId].avatar;
    
    if (!extension_settings[extensionName].characterPrompts) {
        extension_settings[extensionName].characterPrompts = {};
    }
    
    const charData = extension_settings[extensionName].characterPrompts[avatarFile] || [];

    if (charData.length === 0) {
        $list.append('<div style="text-align:center; color:var(--ap-text-vague); font-size:0.8rem; padding: 10px;">등록된 캐릭터 프롬프트가 없습니다.</div>');
    }

    charData.forEach((item, index) => {
        const slotNum = index + 1;
        const isEnabled = item.enabled !== false; 
        
        const html = `
            <div class="char-prompt-item" style="background: var(--ap-bg-item); padding: 12px; border-radius: 8px; border: 1px solid var(--ap-border); position: relative;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <label class="gen-checkbox-label" style="margin:0; cursor:pointer; display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" class="char-enabled-checkbox" data-index="${index}" ${isEnabled ? 'checked' : ''}>
                        <span style="font-weight:bold; font-size:0.8rem; color:var(--ap-accent);">#${slotNum} - {autopic_char${slotNum}}</span>
                    </label>
                    <button class="remove-char-prompt-btn gen-btn gen-btn-red" data-index="${index}" style="padding:2px 8px; font-size:0.7rem;">삭제</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <textarea class="gen-custom-input char-prompt-input" data-index="${index}" rows="2" placeholder="캐릭터 외형 프롬프트" style="resize: vertical;">${item.prompt || ''}</textarea>
                </div>
            </div>
        `;
        $list.append(html);
    });

    $('.char-prompt-input').off('input').on('input', function() {
        const idx = $(this).data('index');
        charData[idx].prompt = $(this).val();
        saveSettingsDebounced();
    });

    $('.char-enabled-checkbox').off('change').on('change', function() {
        const idx = $(this).data('index');
        charData[idx].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('.remove-char-prompt-btn').off('click').on('click', function() {
        const idx = $(this).data('index');
        charData.splice(idx, 1);
        saveSettingsDebounced();
        renderCharacterPrompts();
    });
}

$(document).off('click', '#add_char_prompt_btn').on('click', '#add_char_prompt_btn', function() {
    const context = getContext();
    const charId = context.characterId ?? (characters.findIndex(c => c.avatar === context.character?.avatar));
    
    if (charId === undefined || charId === -1 || !characters[charId]) {
        toastr.info("캐릭터를 선택해야 합니다.");
        return;
    }

    const avatarFile = characters[charId].avatar;
    if (!extension_settings[extensionName].characterPrompts[avatarFile]) {
        extension_settings[extensionName].characterPrompts[avatarFile] = [];
    }

    if (extension_settings[extensionName].characterPrompts[avatarFile].length >= 6) {
        toastr.warning("최대 6명까지만 추가할 수 있습니다.");
        return;
    }

    extension_settings[extensionName].characterPrompts[avatarFile].push({ prompt: '', enabled: true });
    saveSettingsDebounced();
    renderCharacterPrompts();
});

function onSaveCharLink() {
    const context = getContext();
    const charId = context.characterId;
    if (!charId || !characters[charId]) return;

    const presetName = $('#prompt_preset_select').val();
    if (!presetName) {
        toastr.warning("먼저 템플릿을 선택하거나 작성해 주세요.");
        return;
    }

    const avatarFile = characters[charId].avatar;
    const presetContent = extension_settings[extensionName].promptPresets[presetName];
    
    extension_settings[extensionName].linkedPresets[avatarFile] = presetName;
    
    extension_settings[extensionName].promptInjection.prompt = presetContent;
    
    $('#prompt_injection_text').val(presetContent);
    updatePresetSelect(); 
    
    saveSettingsDebounced();
    renderCharacterLinkUI();
    renderAllLinkedPresetsList(); 
    toastr.success(`${characters[charId].name} 캐릭터에게 '${presetName}' 템플릿이 연동되었습니다.`);
}

function onRemoveCharLink() {
    const context = getContext();
    const charId = context.characterId;
    if (!charId || !characters[charId]) return;

    const avatarFile = characters[charId].avatar;
    
    if (extension_settings[extensionName].linkedPresets[avatarFile]) {
        delete extension_settings[extensionName].linkedPresets[avatarFile];
        saveSettingsDebounced();
        renderCharacterLinkUI();
        updatePresetSelect();
        renderAllLinkedPresetsList(); 
        toastr.info("캐릭터 연동이 해제되었습니다. 이제 현재 설정된 프롬프트가 전역으로 유지됩니다.");
    }
}

function renderAllLinkedPresetsList() {
    const $container = $('#gen-linked-char-list-container');
    $container.empty();

    const linked = extension_settings[extensionName].linkedPresets;
    if (!linked || Object.keys(linked).length === 0) {
        $container.append('<div style="padding: 15px; text-align: center; font-size: 0.85rem; color: var(--ap-text-vague);">연동된 캐릭터가 없습니다.</div>');
        return;
    }

    const avatarToName = {};
    characters.forEach(c => avatarToName[c.avatar] = c.name);

	Object.keys(linked).forEach(avatarFile => {
        const presetName = linked[avatarFile];
        const charName = avatarToName[avatarFile] || `(알 수 없음: ${avatarFile})`;
        
        const $item = $(`
            <div class="gen-linked-item">
                <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-weight: bold; font-size: 0.85rem; color: var(--ap-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${charName}</span>
                    <span style="color: var(--ap-accent); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${presetName}</span>
                </div>
                <button class="gen-btn gen-btn-red gen-delete-link-btn" data-avatar="${avatarFile}" style="padding: 5px 10px; font-size: 0.75rem; flex-shrink: 0;">삭제</button>
            </div>
        `);

        $item.find('.gen-delete-link-btn').on('click', function() {
            const avatar = $(this).data('avatar');
            delete extension_settings[extensionName].linkedPresets[avatar];
            saveSettingsDebounced();
            renderAllLinkedPresetsList();
            renderCharacterLinkUI();
        });

        $container.append($item);
    });
}
function renderStorageManagementList() {
    const $container = $('#gen-storage-mgmt-list-container');
    $container.empty();

    const charPrompts = extension_settings[extensionName].characterPrompts || {};
    const linkedPresets = extension_settings[extensionName].linkedPresets || {};

    const allSavedAvatars = new Set([...Object.keys(charPrompts), ...Object.keys(linkedPresets)]);

    if (allSavedAvatars.size === 0) {
        $container.append('<div style="padding: 15px; text-align: center; font-size: 0.85rem; color: var(--ap-text-vague);">저장된 데이터가 없습니다.</div>');
        return;
    }

    const avatarToName = {};
    characters.forEach(c => avatarToName[c.avatar] = c.name);

	allSavedAvatars.forEach(avatarFile => {
        const charName = avatarToName[avatarFile];
        const isDeleted = !charName;
        const displayName = charName || `(삭제됨) ${avatarFile}`;
        
        const hasPrompt = charPrompts[avatarFile] && charPrompts[avatarFile].length > 0;
        const hasLink = linkedPresets[avatarFile] !== undefined && linkedPresets[avatarFile] !== null;

        if (!hasPrompt && !hasLink) {
            return;
        }

        const $item = $(`
            <div class="gen-linked-item" style="border-bottom: 1px solid var(--ap-border); padding: 10px 15px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: bold; font-size: 0.85rem; color: ${isDeleted ? '#eb4d4b' : 'var(--ap-text)'}; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                        ${displayName}
                    </div>
                    <div style="font-size: 0.75rem; color: var(--ap-text-vague);">
                        ${hasPrompt ? '외형 있음 ' : ''}${hasLink ? '연동 있음' : ''}
                    </div>
                </div>
                <button class="gen-btn gen-btn-red gen-delete-storage-btn" data-avatar="${avatarFile}" style="padding: 4px 8px; font-size: 0.7rem; flex-shrink: 0;">
                    <i class="fa-solid fa-eraser"></i> 데이터 삭제
                </button>
            </div>
        `);

        $item.find('.gen-delete-storage-btn').on('click', async function() {
            const avatar = $(this).data('avatar');
            const confirm = await callGenericPopup(
                `'${displayName}' 캐릭터의 모든 저장된 데이터(외형 프롬프트 및 연동 설정)를 삭제하시겠습니까?`,
                POPUP_TYPE.CONFIRM
            );
            if (confirm) {
                delete extension_settings[extensionName].characterPrompts[avatar];
                delete extension_settings[extensionName].linkedPresets[avatar];
                saveSettingsDebounced();
                renderStorageManagementList();
                renderCharacterLinkUI(); 
                renderCharacterPrompts(); 
                toastr.success(`${displayName} 데이터 삭제 완료`);
            }
        });

        $container.append($item);
    });
}
function updatePresetSelect(forceSelectedName = null) {
    const select = $('#prompt_preset_select');
    if (!select.length) return;

    const currentPrompt = extension_settings[extensionName].promptInjection.prompt;
    const presets = extension_settings[extensionName].promptPresets || {};
    
    const currentlySelected = select.val();
    
    select.empty();
    select.append('<option value="">-- 템플릿 선택 --</option>');

    let matchedKey = null;
    Object.keys(presets).sort().forEach(key => {
        const option = $('<option></option>').val(key).text(key);
        select.append(option);

        if (presets[key] === currentPrompt) matchedKey = key;
    });

    if (forceSelectedName && presets[forceSelectedName] !== undefined) {
        select.val(forceSelectedName);
    } 
    else if (matchedKey) {
        select.val(matchedKey);
    } 

    else if (currentlySelected && presets[currentlySelected] !== undefined) {
        select.val(currentlySelected);
    }
    else {
        select.val("");
    }
}

function getFinalPrompt() {
    const context = getContext();
    const charId = context.characterId ?? (characters.findIndex(c => c.avatar === context.character?.avatar));
    let finalPrompt = extension_settings[extensionName].promptInjection.prompt;

    if (charId !== undefined && charId !== -1 && characters[charId]) {
        const avatarFile = characters[charId].avatar;
        const linkedPresetName = extension_settings[extensionName].linkedPresets[avatarFile];

        if (linkedPresetName && extension_settings[extensionName].promptPresets[linkedPresetName]) {
            finalPrompt = extension_settings[extensionName].promptPresets[linkedPresetName];
        }

        const charData = extension_settings[extensionName].characterPrompts[avatarFile] || [];

        for (let i = 1; i <= 6; i++) {
            const placeholder = `{autopic_char${i}}`;
            const item = charData[i - 1];
            let replacement = "";

            if (item && item.enabled !== false && item.prompt && item.prompt.trim()) {
                replacement = item.prompt;
            }

            finalPrompt = finalPrompt.split(placeholder).join(replacement);
        }
    } else {
        for (let i = 1; i <= 6; i++) {
            finalPrompt = finalPrompt.split(`{autopic_char${i}}`).join("");
        }
    }

    return finalPrompt;
}

eventSource.on(
    event_types.CHAT_COMPLETION_PROMPT_READY,
    async function (eventData) {
        try {
            if (!extension_settings[extensionName]?.promptInjection?.enabled || 
                extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) {
                return;
            }

            const prompt = getFinalPrompt(); 
            const depth = extension_settings[extensionName].promptInjection.depth || 0;
            const role = extension_settings[extensionName].promptInjection.position.replace('deep_', '') || 'system';

            if (depth === 0) {
                // depth=0이면 system 프롬프트를 맨 앞(index 0)에 삽입
                eventData.chat.unshift({ role: role, content: prompt });
            } else {
                eventData.chat.splice(-depth, 0, { role: role, content: prompt });
            }
        } catch (error) {
            console.error(`[${extensionName}] Prompt injection error:`, error);
        }
    },
);

/** -------------------------------------------------------
 * 초기화 및 메시지 감시 로직
 * ------------------------------------------------------- */

async function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) extensionsDrawer.trigger('click');

    setTimeout(() => {
        const container = $('#autopic_settings_container');
        if (container.length) {
            $('#rm_extensions_block').animate({
                scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop(),
            }, 500);
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');
            if (drawerContent.is(':hidden') && drawerHeader.length) drawerHeader.trigger('click');
        }
    }, 500);
}

$(function () {
    (async function () {

        const styleId = 'autopic-clean-ui-style';
        if (!$(`#${styleId}`).length) {
            $('head').append(`
            <style id="${styleId}">
                /* ===============================
                   1. 중앙 정렬 및 여백 확보 (메시지 스와이프 간섭 방지)
                ================================ */
                .mes_media_wrapper {
                    display: flex !important;
                    justify-content: center !important;
                    width: 100% !important;
                    padding: 0 !important;
                    /* 갤러리 아래쪽으로 충분한 공간 확보 */
                    margin: 0 0 40px 0 !important; 
                    border: none !important;
                    box-sizing: border-box !important;
					border-radius: 12px !important;
                }

                .mes_media_container {
                    display: flex !important;
                    justify-content: center !important;
                    position: relative !important;
                    width: fit-content !important;
                    max-width: 100% !important;
                    margin: 10px auto !important;
                    padding: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
					overflow: visible !important;
                }


				.mes_media_container img.mes_img,
				.mes_media_container video {
					border-radius: 12px !important;
				}
				.mes_img_swipes,
				.mes_img_controls,
				.mes_video_controls {
					background: none !important;
					box-shadow: none !important;
					opacity: 0 !important;
					pointer-events: none !important;
					transition: opacity 0.15s ease-in-out !important;
				}

				.mes_media_container:hover .mes_img_controls,
				.mes_media_container:hover .mes_img_swipes,
				.mes_media_container.ui-active .mes_img_controls,
				.mes_media_container.ui-active .mes_img_swipes {
					opacity: 0.9 !important;
					pointer-events: auto !important;
				}

				/* ===============================
				   2. 우측 상단 버튼 (아이콘)
				================================ */
                .mes_img_controls {
                    display: flex !important;
                    flex-direction: row !important;
                    justify-content: flex-end !important;
                    gap: 6px !important;
                    top: -5px !important;
                    right: 10px !important;
                    left: auto !important;
                    width: auto !important;
                    height: auto !important;
                }

				.mes_img_controls .right_menu_button {
					background: none !important;
					width: 28px !important;
					height: 28px !important;
					display: flex !important;
					align-items: center !important;
					justify-content: center !important;
					color: rgba(255,255,255,0.95) !important;
					font-size: 15px !important;
					text-shadow: 0 1px 2px rgba(0,0,0,0.6) !important;
				}

				/* ===============================
				   3. 하단 중앙 스와이프 (텍스트 중심)
				================================ */
				.mes_img_swipes {
					bottom: 4px !important;
					left: 50% !important;
					transform: translateX(-50%) !important;
					display: flex !important;
					align-items: center !important;
					gap: 10px !important;
				}

				.mes_img_swipe_left,
				.mes_img_swipe_right {
					background: none !important;
					color: rgba(255,255,255,0.97) !important;
					font-size: 18px !important;
					text-shadow: 0 1px 2px rgba(0,0,0,0.6) !important;
				}

				.mes_img_swipe_counter {
					background: none !important;
					color: rgba(255,255,255,0.85) !important;
					font-size: 0.85rem !important;
					font-weight: 500 !important;
					min-width: auto !important;
					text-shadow: 0 1px 2px rgba(0,0,0,0.6) !important;
				}

				/* ===============================
				   4. 모바일 전용 (수정됨)
				================================ */
                .mobile-ui-toggle {
                    display: block;
                    position: absolute;
                    top: 5px;
                    left: 5px;
                    width: 30px;
                    height: 30px;
                    background: rgba(0,0,0,0.5);
                    color: white;
                    border-radius: 50%;
                    text-align: center;
                    line-height: 30px;
                    font-size: 15px;
                    cursor: pointer;
                    z-index: 100;
                    opacity: 0.6;
                }
                
                .mes_img_swipe_left, .mes_img_swipe_right {
                    min-width: 40px !important;
                    min-height: 40px !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    cursor: pointer !important;
                    pointer-events: auto !important;
                    z-index: 1001 !important;
                }

                @media (max-width: 1000px) {
                    .mes_media_wrapper {
                        margin-bottom: 45px !important;
                    }

                    .mes_img_swipes {
                        opacity: 0 !important;   
                        pointer-events: none !important;
                        z-index: 1000 !important;
                        background: none !important;  
                        border-radius: 0 !important; 
                        padding: 0 !important;        
                        transition: opacity 0.15s ease-in-out !important;
                    }

                    .mes_media_container.ui-active .mes_img_swipes,
                    .mes_media_container.ui-active .mes_img_controls {
                        opacity: 1 !important;
                        pointer-events: auto !important;
                    }

                    .mes_img_swipe_left, .mes_img_swipe_right {
                        opacity: 0.2 !important;
                        transition: opacity 0.2s !important;
                    }

                    .mes_media_container.ui-active .mes_img_swipe_left,
                    .mes_media_container.ui-active .mes_img_swipe_right {
                        opacity: 1 !important;
                    }
                }
                }
                @media (min-width: 1000px) {
                    .mobile-ui-toggle { display: none; }
                }

				.mes_media_container::after {
					display: none !important;
				}
				/* ===============================
				   5. 태그 치환 모드 이미지 스타일 (Autopic 전용 클래스 적용)
				================================ */
				.mes_text img[data-autopic-id],
				.autopic-tag-img-wrapper img,
				.mes_text img[title*="Character"],
				.mes_text img[title*="indoors"] {
					border-radius: 12px !important;
					margin: 10px auto !important;
					display: block !important;
					max-width: 100% !important;
					height: auto !important;
					box-shadow: 0 4px 15px rgba(0,0,0,0.3) !important;
					border: 1px solid var(--ap-border, #333336) !important;
					transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease !important;
					cursor: pointer;
					position: relative;
					z-index: 1;
				}

				/* 2. Hover 상태: 마우스를 올렸을 때 살짝 확대 및 그림자 강조 */
				.mes_text img[data-autopic-id]:hover,
				.autopic-tag-img-wrapper img:hover,
				.mes_text img[title*="Character"]:hover,
				.mes_text img[title*="indoors"]:hover {
					transform: scale(1.01) !important; 
					box-shadow: 0 8px 25px rgba(0,0,0,0.5) !important;
					z-index: 5 !important; 
				}

				.autopic-tag-img-wrapper {
					position: relative;
					display: block;
					max-width: fit-content;
					margin: 12px auto !important;
					overflow: visible !important; 
				}

				.autopic-tag-controls {
					position: absolute;
					top: 10px;
					right: 12px;
					display: flex;
					gap: 6px;
					opacity: 0;
					transition: opacity 0.2s ease;
					z-index: 10;
					pointer-events: none;
				}

				.autopic-tag-img-wrapper:hover .autopic-tag-controls,
				.autopic-tag-img-wrapper.ui-active .autopic-tag-controls {
					opacity: 1;
					pointer-events: auto;
				}

				.autopic-control-btn {
					background: rgba(0, 0, 0, 0.5) !important;
					backdrop-filter: blur(4px);
					border-radius: 8px !important;
					width: 34px !important;
					height: 34px !important;
					display: flex !important;
					align-items: center !important;
					justify-content: center !important;
					color: white !important;
					font-size: 16px !important;
					text-shadow: 0 1px 3px rgba(0,0,0,0.8) !important;
					cursor: pointer;
					border: 1px solid rgba(255,255,255,0.2) !important;
					padding: 0 !important;
				}

				.autopic-control-btn:hover {
					color: var(--ap-accent, #4a90e2) !important;
					background: rgba(0, 0, 0, 0.8) !important;
					transform: scale(1.1) !important;
				}

				@media (max-width: 1000px) {
					.autopic-tag-controls { opacity: 0 !important; }
					.autopic-tag-img-wrapper.ui-active .autopic-tag-controls { opacity: 1 !important; }
				}
					.autopic-tag-img-wrapper.ui-active .autopic-tag-controls {
						opacity: 1 !important;
						pointer-events: auto !important;
					}
				}
            </style>
        `);
        }

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

        $('#extensionsMenu').append(`<div id="autopic_menu_item" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="AutoPic">AutoPic</span>
        </div>`);
		renderCharacterPrompts();

        $('#autopic_menu_item').off('click').on('click', onExtensionButtonClick);

        await loadSettings();
        await addToWandMenu();
        await createSettings(settingsHtml);

        $('#extensions-settings-button').on('click', () => setTimeout(updateUI, 200));

		eventSource.on(event_types.MESSAGE_RENDERED, (mesId) => {
            const context = getContext();
            const message = context.chat[mesId];
            if (message && !message.is_user && !message.extra?.title) {
                const picRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/i;
                const imgRegex = /<img[^>]*\stitle="([^"]*)"[^>]*?>/i;
                const match = message.mes.match(picRegex) || message.mes.match(imgRegex);
                if (match && match[1]) {
                    if (!message.extra) message.extra = {};
                    message.extra.title = match[1];
                }
            }
            addRerollButtonToMessage(mesId);
            addMobileToggleToMessage(mesId);
            attachSwipeRerollListeners(mesId);
            setTimeout(() => attachTagControls(mesId), 150);
        });

        eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => {
            const context = getContext();
            const message = context.chat[mesId];
            if (message && !message.is_user && !message.extra?.title) {
                const picRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/i;
                const imgRegex = /<img[^>]*\stitle="([^"]*)"[^>]*?>/i;
                const match = message.mes.match(picRegex) || message.mes.match(imgRegex);
                if (match && match[1]) {
                    if (!message.extra) message.extra = {};
                    message.extra.title = match[1];
                }
            }
            addRerollButtonToMessage(mesId);
            addMobileToggleToMessage(mesId);
            attachSwipeRerollListeners(mesId);
            setTimeout(() => attachTagControls(mesId), 150);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
			renderCharacterLinkUI();
			renderCharacterPrompts();
		});

        /* -------------------------------------------------------
         * 모바일 전용: 돋보기 차단 및 UI 토글 로직 (Capture phase)
         * ------------------------------------------------------- */
        document.addEventListener('click', function (e) {
            const target = e.target;
            const $mediaContainer = $(target).closest('.mes_media_container, .autopic-tag-img-wrapper');
            
            if ($mediaContainer.length === 0) {
                $('.mes_media_container.ui-active, .autopic-tag-img-wrapper.ui-active').removeClass('ui-active');
                return;
            }

            const isButton = $(target).closest('.right_menu_button, .mes_img_controls, .mes_img_swipes, .mobile-ui-toggle, .autopic-control-btn, .autopic-tag-controls, .reroll-trigger').length > 0;

            if (window.innerWidth < 1000 && !$mediaContainer.hasClass('ui-active')) {
                if (!isButton) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    $('.mes_media_container.ui-active, .autopic-tag-img-wrapper.ui-active').removeClass('ui-active');
                    $mediaContainer.addClass('ui-active');
                }
                return;
            }

            if (window.innerWidth < 1000 && $mediaContainer.hasClass('ui-active') && !isButton) {
                e.stopImmediatePropagation();
                e.preventDefault();
                $mediaContainer.removeClass('ui-active');
            }
            
        }, true);

        $(document).off('click', '.image-reroll-button, .mes_img_swipe_counter').on('click', '.image-reroll-button, .mes_img_swipe_counter', function (e) {
            if ($(this).hasClass('mes_img_swipe_counter')) {
                e.stopPropagation();
                e.preventDefault();
            }

            const messageBlock = $(this).closest('.mes');
            const mesId = messageBlock.attr('mesid');
            
            let $visibleImg = messageBlock.find('.mes_img_container:not([style*="display: none"]) img.mes_img');
            
            if ($visibleImg.length === 0) $visibleImg = messageBlock.find('img.mes_img').first();
            
            const imgTitle = $visibleImg.attr('title') || $visibleImg.attr('alt') || "";
            
            handleReroll(mesId, imgTitle);
        });

        $(document).off('click', '.reroll-trigger').on('click', '.reroll-trigger', function(e) {
            e.preventDefault(); 
            e.stopPropagation();
            const mesId = $(this).data('mesid');
            const prompt = $(this).data('prompt');
            handleReroll(mesId, prompt);
        });
        $(document).on('click', '.swipe_left, .swipe_right', function () {
            const $message = $(this).closest('.mes');
            const mesId = $message.attr('mesid');
            
            if (mesId !== undefined) {
                setTimeout(() => {
                    attachTagControls(mesId);
                }, 150);
            }
        });

    })();
});
async function addToWandMenu() {
    try {
        if ($('#st_image_reroll_wand_button').length > 0) return;
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        const extensionsMenu = $("#extensionsMenu");
        if (extensionsMenu.length > 0) {
            extensionsMenu.append(buttonHtml);
            
            $("#st_image_reroll_wand_button").off('click').on("click", () => handleLastImageReroll());
            $("#st_image_toggle_active_button").off('click').on("click", () => toggleExtensionStatus());
            
            updateToggleButtonStyle();
        } else {
            setTimeout(addToWandMenu, 1000);
        }
    } catch (e) { console.warn('[Image Auto Gen] Wand button failed:', e); }
}

function updateToggleButtonStyle() {
    const isActive = extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED;
    const $icon = $('#st_image_toggle_icon');
    const $text = $('#st_image_toggle_text');
    
    if ($icon.length) {
        $icon.css('color', isActive ? '#4a90e2' : '#eb4d4b');
    }
    
    if ($text.length) {
        $text.removeAttr('data-i18n');
        $text.text(isActive ? '이미지 생성: 활성' : '이미지 생성: 중단됨');
    }
}

async function toggleExtensionStatus() {
    const currentType = extension_settings[extensionName].insertType;
    if (currentType !== INSERT_TYPE.DISABLED) {
        extension_settings[extensionName].lastNonDisabledType = currentType;
        extension_settings[extensionName].insertType = INSERT_TYPE.DISABLED;
        toastr.info("이미지 자동 생성이 비활성화되었습니다.");
    } else {
        extension_settings[extensionName].insertType = extension_settings[extensionName].lastNonDisabledType || INSERT_TYPE.INLINE;
        toastr.success(`이미지 자동 생성이 활성화되었습니다 (${extension_settings[extensionName].insertType}).`);
    }
    saveSettingsDebounced();
    updateUI();
    updateToggleButtonStyle();
}

async function handleLastImageReroll() {
    const context = getContext();
    const chat = context.chat;
    
    const picRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g;
    const imgRegex = /<img[^>]+>/g;

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.is_user) continue;

        const hasPic = message.mes.match(picRegex);
        const hasImg = message.mes.match(imgRegex);
        const hasExtra = message.extra && (message.extra.image || message.extra.image_swipes);

        if (hasPic || hasImg || hasExtra) {
            let prompt = message.extra?.title || "";
            if (!prompt && hasImg) {
                const match = message.mes.match(/title="([^"]*)"/);
                if (match) prompt = match[1];
            }
            handleReroll(i, prompt);
            return;
        }
    }
    toastr.info("생성 가능한 이미지를 찾을 수 없습니다.");
}
function addRerollButtonToMessage(mesId) {
    const $message = $(`.mes[mesid="${mesId}"]`);
    const $controls = $message.find('.mes_img_controls');
    $controls.each(function() {
        const $this = $(this);
        if (!$this.find('.image-reroll-button').length) {
            const rerollBtn = `<div title="Generate Another Image" class="right_menu_button fa-solid fa-rotate image-reroll-button interactable" role="button" tabindex="0"></div>`;
            
            const deleteBtn = $this.find('.mes_media_delete');
            if (deleteBtn.length) {
                $(rerollBtn).insertBefore(deleteBtn);
            } else {
                $this.append(rerollBtn);
            }
        }
    });
}
function addMobileToggleToMessage(mesId) {
    const $message = $(`.mes[mesid="${mesId}"]`);
    $message.find('.mes_media_container').each(function () {
        if (!$(this).find('.mobile-ui-toggle').length) {
            $(this).append(`<div class="mobile-ui-toggle">⚙</div>`);
        }
    });
}

/**
 * 스와이프 버튼 및 카운터 클릭 시 리롤 모달을 강제로 연결하는 함수
 */
function attachSwipeRerollListeners(mesId) {
    const $message = $(`.mes[mesid="${mesId}"]`);
    
    const $swipeControls = $message.find('.mes_img_swipe_left, .mes_img_swipe_right, .mes_img_swipe_counter');
    
    $swipeControls.off('click.autopic').on('click.autopic', function (e) {
        const $counter = $message.find('.mes_img_swipe_counter');
        const counterText = $counter.text().trim(); // 예: "1/1" 또는 "2/3"
        
        const parts = counterText.split('/');
        if (parts.length !== 2) return;
        
        const current = parseInt(parts[0]);
        const total = parseInt(parts[1]);
        
        const isLeftArrow = $(this).hasClass('mes_img_swipe_left');
        const isRightArrow = $(this).hasClass('mes_img_swipe_right');
        const isCounter = $(this).hasClass('mes_img_swipe_counter');

        let shouldTriggerReroll = false;

        if (isCounter) {
            shouldTriggerReroll = true;
        } 
        else if (isLeftArrow && current === 1) {
            shouldTriggerReroll = true;
        } 
        else if (isRightArrow && current === total) {
            shouldTriggerReroll = true;
        }

        if (shouldTriggerReroll) {
            e.preventDefault();
            e.stopPropagation();
            
            let $visibleImg = $message.find('.mes_img_container:not([style*="display: none"]) img.mes_img');
            if ($visibleImg.length === 0) $visibleImg = $message.find('img.mes_img').first();
            
            const imgTitle = $visibleImg.attr('title') || $visibleImg.attr('alt') || "";
            
            handleReroll(mesId, imgTitle);
        }

    });
}
async function handleReroll(mesId, currentPrompt) {
    if (!SlashCommandParser.commands['sd']) {
        toastr.error("Stable Diffusion extension not loaded.");
        return;
    }
    
    const context = getContext();
    const message = context.chat[mesId];
    if (!message) return;

    const insertType = extension_settings[extensionName].insertType;
    const picRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/gi;
    const imgRegex = /<img[^>]+>/gi;
    
    let foundItems = []; 

    // 1. 본문 내 <pic> 태그 검색
    let picMatches = [...message.mes.matchAll(picRegex)];
    picMatches.forEach(m => {
        foundItems.push({ 
            originalTag: m[0], 
            prompt: m[1], 
            type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe' 
        });
    });

    // 2. 본문 내 <img> 태그 검색
    let imgMatches = [...message.mes.matchAll(imgRegex)];
    imgMatches.forEach(m => {
        const fullTag = m[0];
        const titleMatch = fullTag.match(/title="([^"]*)"/i);
        const prompt = titleMatch ? titleMatch[1] : "";
        
        if (prompt) {
            if (!foundItems.some(item => item.originalTag === fullTag)) {
                foundItems.push({ 
                    originalTag: fullTag, 
                    prompt: prompt, 
                    type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe' 
                });
            }
        }
    });

    // 3. 메시지 extra 데이터 (이미 생성된 갤러리 이미지들)
    if (message.extra && message.extra.image_swipes && message.extra.image_swipes.length > 0) {
        message.extra.image_swipes.forEach((src, sIdx) => {
            foundItems.push({ 
                swipeIdx: sIdx, 
                prompt: message.extra.title || currentPrompt || "", 
                type: 'swipe' 
            });
        });
    }

    if (foundItems.length === 0) {
        foundItems.push({ 
            originalTag: null, 
            prompt: currentPrompt || "", 
            type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe' 
        });
    }

    let selectedIdx = 0;
    const initialMatchIdx = foundItems.findIndex(item => item.prompt === currentPrompt);
    if (initialMatchIdx !== -1) selectedIdx = initialMatchIdx;

    let editedPrompts = foundItems.map(item => item.prompt);

    let popupHtml = `<div class="reroll_popup_container" style="min-width:300px;">
        <h3 style="margin-bottom:15px; border-bottom:1px solid #4a90e2; padding-bottom:5px;">이미지 다시 생성</h3>
        <p style="font-size:0.85rem; color:#aaa; margin-bottom:15px;">교체할 이미지를 선택하거나 프롬프트를 수정하세요:</p>`;
    
    foundItems.forEach((item, idx) => {
        const typeLabel = item.type === 'tag' ? '태그 치환 모드' : '메시지에 삽입 모드';
        const isChecked = idx === selectedIdx ? 'checked' : '';
        popupHtml += `
            <div class="prompt_option_item" style="margin-bottom:15px; padding:12px; background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:8px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <input type="radio" name="reroll_prompt_choice" class="reroll_radio" id="prompt_choice_${idx}" value="${idx}" ${isChecked}>
                    <label for="prompt_choice_${idx}" style="font-weight:bold; color:#4a90e2; cursor:pointer;">#${idx + 1} ${typeLabel}</label>
                </div>
                <textarea class="reroll_textarea text_pole" data-idx="${idx}" rows="3" style="width: 100%; background:#111; color:#fff; border:1px solid #444; border-radius:5px; padding:8px;">${escapeHtmlAttribute(String(item.prompt))}</textarea>
            </div>
        `;
    });
    popupHtml += `</div>`;

    $(document).on('change', '.reroll_radio', function() {
        selectedIdx = parseInt($(this).val());
    });
    $(document).on('input', '.reroll_textarea', function() {
        const idx = $(this).data('idx');
        editedPrompts[idx] = $(this).val();
    });

    const result = await callGenericPopup(popupHtml, POPUP_TYPE.CONFIRM, '', { okButton: 'Generate', cancelButton: 'Cancel' });

    $(document).off('change', '.reroll_radio');
    $(document).off('input', '.reroll_textarea');

    if (result) {
        const finalPrompt = editedPrompts[selectedIdx];
        const targetItem = foundItems[selectedIdx];

        if (finalPrompt && finalPrompt.trim()) {
            try {
                toastr.info("이미지 생성 중...");
                const resultUrl = await sdCallWithRescale({ quiet: 'true' }, finalPrompt.trim());
                
                if (typeof resultUrl === 'string' && !resultUrl.startsWith('Error')) {
                    const currentInsertType = extension_settings[extensionName].insertType;

                    // [핵심 수정] 태그 치환 모드일 때만 본문(message.mes)을 수정함
                    if (currentInsertType === INSERT_TYPE.REPLACE && targetItem.originalTag) {
                        const idMatch = targetItem.originalTag.match(/data-autopic-id="([^"]*)"/);
                        const idAttr = idMatch ? ` data-autopic-id="${idMatch[1]}"` : ` data-autopic-id="tag-${Date.now()}"`;
                        const newTag = `<img src="${escapeHtmlAttribute(resultUrl)}"${idAttr} title="${escapeHtmlAttribute(finalPrompt.trim())}" alt="${escapeHtmlAttribute(finalPrompt.trim())}">`;
                        message.mes = message.mes.replace(targetItem.originalTag, newTag);
                    } 
                    // [핵심 수정] 그 외(INLINE 등) 모드에서는 본문은 절대 건드리지 않고 갤러리(extra)만 수정
                    else {
                        if (!message.extra) message.extra = {};
                        if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
                        
                        if (targetItem.swipeIdx !== undefined) {
                            message.extra.image_swipes[targetItem.swipeIdx] = resultUrl;
                        } else {
                            message.extra.image_swipes.push(resultUrl);
                        }
                        message.extra.image = resultUrl;
                        message.extra.title = finalPrompt.trim();
                        message.extra.inline_image = true;
                    }

                    updateMessageBlock(mesId, message);
                    appendMediaToMessage(message, $(`.mes[mesid="${mesId}"]`));
                    await context.saveChat();
                    
                    await eventSource.emit(event_types.MESSAGE_UPDATED, mesId);
                    await eventSource.emit(event_types.MESSAGE_RENDERED, mesId);
                    
                    toastr.success("이미지가 교체되었습니다.");
                } else {
                    toastr.error("생성 실패: SD 익스텐션 응답 확인 필요");
                }
            } catch (e) { 
                console.error(e);
                toastr.error("이미지 생성 중 오류 발생."); 
            }
        }
    }
}

/**
 * /sd 커맨드 실행.
 * cfg_rescale은 fetch 인터셉터(installNaiFetchInterceptor)가
 * /api/novelai/generate-image 요청을 가로채서 자동으로 주입하므로
 * 여기서는 별도 처리가 필요 없다.
 */
async function sdCallWithRescale(args, prompt) {
    return await SlashCommandParser.commands['sd'].callback(args, prompt);
}

function applyTheme(theme) {
    const container = $('#autopic_settings_container');
    if (!container.length) return;
    
    container.removeClass('theme-dark theme-light theme-pink');
    container.addClass(`theme-${theme}`);
}
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    if (!extension_settings[extensionName] || extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) return;

    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user) return;

    let regex;
    try {
        let rawRegex = regexFromString(extension_settings[extensionName].promptInjection.regex);
        regex = new RegExp(rawRegex.source, rawRegex.flags.includes('g') ? rawRegex.flags : rawRegex.flags + 'g');
    } catch (e) {
        regex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g;
    }

    const matches = [...message.mes.matchAll(regex)];
    if (matches.length === 0) return;

    setTimeout(async () => {
        try {
            const currentIdx = context.chat.indexOf(message);
            if (currentIdx === -1) return; 

            const insertType = extension_settings[extensionName].insertType;
            const total = matches.length;
            
            toastr.info(`${total}개의 이미지 생성을 시작합니다...`, "AutoPic", { "progressBar": true });
            
            if (!message.extra) message.extra = {};
            if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
            
            const messageElement = $(`.mes[mesid="${currentIdx}"]`);
            let hasChanged = false;
            let lastImageResult = null;
            let lastPromptUsed = "";
            let updatedMes = message.mes;

            for (let i = 0; i < matches.length; i++) {
                toastr.info(`이미지 생성 중... (${i + 1} / ${total})`, "AutoPic", { "timeOut": 2000 });

                const match = matches[i];
                const fullTag = match[0];
                const prompt = match[1] || '';
                
                if (!prompt.trim()) continue;

                const result = await sdCallWithRescale({ quiet: 'true' }, prompt.trim());
                
                if (typeof result === 'string' && result.trim().length > 0 && !result.startsWith('Error')) {
                    hasChanged = true;
                    lastImageResult = result;
                    lastPromptUsed = prompt.trim();
                    
                    if (insertType === INSERT_TYPE.INLINE) {
                        message.extra.image_swipes.push(result);
                    } 
                    else if (insertType === INSERT_TYPE.REPLACE) {
                        const tagId = `tag-${Date.now()}-${i}`; 
                        const newTag = `<img src="${escapeHtmlAttribute(result)}" data-autopic-id="${tagId}" title="${escapeHtmlAttribute(prompt)}" alt="${escapeHtmlAttribute(prompt)}">`;
                        updatedMes = updatedMes.replace(fullTag, () => newTag);
                    }
                } else {
                    toastr.error(`${i + 1}번째 이미지 생성에 실패했습니다.`);
                }
            }

            if (hasChanged) {
                message.extra.title = lastPromptUsed;

                if (insertType === INSERT_TYPE.INLINE) {
                    message.extra.image = lastImageResult; 
                    message.extra.inline_image = true;
                    appendMediaToMessage(message, messageElement);
                } 
                else if (insertType === INSERT_TYPE.REPLACE) {
                    message.mes = updatedMes;
                }
                
                updateMessageBlock(currentIdx, message);
                await context.saveChat();
                
                await eventSource.emit(event_types.MESSAGE_UPDATED, currentIdx);
                await eventSource.emit(event_types.MESSAGE_RENDERED, currentIdx);
                
                toastr.success(`총 ${total}개의 이미지 생성 및 저장 완료!`);
            }
        } catch (e) { 
            console.error("[AutoPic] 오류:", e); 
            toastr.error("이미지 생성 과정에서 오류가 발생했습니다.");
        }
    }, 200);
});

async function attachTagControls(mesId) {
    const context = getContext();
    const message = context.chat[mesId];
    if (!message || message.is_user) return;

    const $mesBlock = $(`.mes[mesid="${mesId}"]`);
    const $images = $mesBlock.find('.mes_text img');

    $images.each(function() {
        const $img = $(this);
        
        if ($img.parent().hasClass('autopic-tag-img-wrapper')) return;
        
        const src = $img.attr('src') || "";
        const title = $img.attr('title') || "";
        const hasAutopicId = $img.attr('data-autopic-id');

        const isAutopicImg = hasAutopicId || 
                             (title && (title.includes('Character') || 
                                        title.includes('indoors') || 
                                        title.includes('outdoors') ||
                                        title.split(',').length > 3)); 

        if (isAutopicImg && src) {
            if (!hasAutopicId) {
                $img.attr('data-autopic-id', `tag-recovered-${Date.now()}`);
            }

            $img.wrap('<div class="autopic-tag-img-wrapper"></div>');
            
            const $controls = $(`
                <div class="autopic-tag-controls">
                    <div class="autopic-control-btn reroll-trigger fa-solid fa-rotate interactable" 
                         data-mesid="${mesId}" 
                         data-prompt="${escapeHtmlAttribute(title)}" 
                         title="Generate Another Image"
                         role="button" 
                         tabindex="0">
                    </div>
                </div>
            `);
            $img.after($controls);
        }
    });
}
/**
 * 모든 메시지를 검사하여 버튼이 누락된 곳에 부착
 */
const initializeAllTagControls = () => {
    const context = getContext();
    if (context && context.chat) {
        const chatLength = context.chat.length;
        const startIndex = Math.max(0, chatLength - 10);
        
        for (let i = startIndex; i < chatLength; i++) {
            setTimeout(() => attachTagControls(i), (i - startIndex) * 10);
        }
    }
};

eventSource.on(event_types.CHAT_COMPLETED, () => {
    initializeAllTagControls();
});

eventSource.on(event_types.CHARACTER_SELECTED, () => {
    renderCharacterLinkUI();
    renderCharacterPrompts();
    initializeAllTagControls();
});

eventSource.on(event_types.CHAT_CHANGED, () => {
    renderCharacterLinkUI();
    renderCharacterPrompts();
    initializeAllTagControls();
});

$(document).off('click', '.reroll-trigger').on('click', '.reroll-trigger', function(e) {
    e.preventDefault(); 
    e.stopPropagation();
    const mesId = $(this).data('mesid');
    const prompt = $(this).data('prompt');
    handleReroll(mesId, prompt);
});