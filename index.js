// The main script for the extension
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

// 扩展名称과 경로
const extensionName = 'AutoPic';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// 삽입 유형 상수
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

// 기본 설정
const defaultAutoPicSettings = {
    insertType: INSERT_TYPE.DISABLED,
    lastNonDisabledType: INSERT_TYPE.INLINE, 
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
    linkedPresets: {} 
};

// UI 업데이트
function updateUI() {
    $('#autopic_menu_item').toggleClass(
        'selected',
        extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED,
    );

    if ($('#image_generation_insert_type').length) {
        updatePresetSelect();
        renderCharacterLinkUI();

        $('#image_generation_insert_type').val(extension_settings[extensionName].insertType);
        $('#prompt_injection_enabled').prop('checked', extension_settings[extensionName].promptInjection.enabled);
        $('#prompt_injection_text').val(extension_settings[extensionName].promptInjection.prompt);
        $('#prompt_injection_regex').val(extension_settings[extensionName].promptInjection.regex);
        $('#prompt_injection_position').val(extension_settings[extensionName].promptInjection.position);
        $('#prompt_injection_depth').val(extension_settings[extensionName].promptInjection.depth);
    }
}

// 설정 로드
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
    }
    updateUI();
}

// 설정 페이지 생성 및 이벤트 바인딩
async function createSettings(settingsHtml) {
    if (!$('#autopic_settings_container').length) {
        $('#extensions_settings2').append(
            '<div id="autopic_settings_container" class="extension_container"></div>',
        );
    }

    $('#autopic_settings_container').empty().append(settingsHtml);

    // 탭 전환 로직
    $('.image-gen-nav-item').on('click', function() {
        $('.image-gen-nav-item').removeClass('active');
        $(this).addClass('active');
        const targetTabId = $(this).data('tab');
        $('.image-gen-tab-content').removeClass('active');
        $('#' + targetTabId).addClass('active');
        
        if (targetTabId === 'tab-gen-linking') renderCharacterLinkUI();
    });

    // 기본 설정 이벤트
    $('#image_generation_insert_type').on('change', function () {
        extension_settings[extensionName].insertType = $(this).val();
        updateUI();
        saveSettingsDebounced();
    });

    $('#prompt_injection_enabled').on('change', function () {
        extension_settings[extensionName].promptInjection.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#prompt_injection_text').on('input', function () {
        extension_settings[extensionName].promptInjection.prompt = $(this).val();
        updatePresetSelect(); 
        saveSettingsDebounced();
    });

    // 템플릿 관리 이벤트
    $('#prompt_preset_select').on('change', function() {
        const selectedKey = $(this).val();
        const presets = extension_settings[extensionName].promptPresets;
        if (selectedKey && presets[selectedKey]) {
            extension_settings[extensionName].promptInjection.prompt = presets[selectedKey];
            $('#prompt_injection_text').val(presets[selectedKey]);
            saveSettingsDebounced();
        }
    });

    $('#save_prompt_preset').on('click', async function() {
        const currentPrompt = $('#prompt_injection_text').val();
        if (!currentPrompt || !currentPrompt.trim()) {
            toastr.warning("Prompt content is empty.");
            return;
        }
        const currentSelection = $('#prompt_preset_select').val();
        const defaultName = currentSelection || "New Prompt";

        const name = await callGenericPopup(
            `Enter a name for this prompt template:`,
            POPUP_TYPE.INPUT,
            defaultName,
            { okButton: "Save", cancelButton: "Cancel" }
        );

        if (name && name.trim()) {
            const cleanName = name.trim();
            extension_settings[extensionName].promptPresets[cleanName] = currentPrompt;
            saveSettingsDebounced();
            updatePresetSelect();
            $('#prompt_preset_select').val(cleanName);
            toastr.success(`Prompt template "${cleanName}" saved.`);
        }
    });

    $('#delete_prompt_preset').on('click', async function() {
        const selectedKey = $('#prompt_preset_select').val();
        if (!selectedKey) {
            toastr.warning("Please select a preset to delete first.");
            return;
        }
        const confirm = await callGenericPopup(
            `Are you sure you want to delete the preset "${selectedKey}"?`,
            POPUP_TYPE.CONFIRM
        );
        if (confirm) {
            delete extension_settings[extensionName].promptPresets[selectedKey];
            saveSettingsDebounced();
            updatePresetSelect();
            toastr.success(`Preset "${selectedKey}" deleted.`);
        }
    });

    // 캐릭터 연동 이벤트
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

    // 기타 설정
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

    updateUI();
}

/** -------------------------------------------------------
 * 캐릭터 연동 로직
 * ------------------------------------------------------- */

function renderCharacterLinkUI() {
    const context = getContext();
    const charId = context.characterId;
    
    if (!charId || !characters[charId]) {
        $('#gen-char-link-info-area').html('<span style="color: var(--color-text-vague);">캐릭터 정보를 불러올 수 없습니다.</span>');
        $('#gen-save-char-link-btn').prop('disabled', true);
        return;
    }

    const character = characters[charId];
    const avatarFile = character.avatar;
    const linkedPreset = extension_settings[extensionName].linkedPresets[avatarFile];

    let statusHtml = `<strong>현재 캐릭터:</strong> ${character.name}<br>`;
    if (linkedPreset && extension_settings[extensionName].promptPresets[linkedPreset]) {
        statusHtml += `<strong>연동된 템플릿:</strong> <span style="color: var(--accent-color); font-weight: bold;">${linkedPreset}</span>`;
        $('#gen-remove-char-link-btn').show();
        
        // 추가: 현재 설정된 프롬프트와 연동된 프롬프트가 다르면 동기화
        const presetContent = extension_settings[extensionName].promptPresets[linkedPreset];
        if (extension_settings[extensionName].promptInjection.prompt !== presetContent) {
            extension_settings[extensionName].promptInjection.prompt = presetContent;
            $('#prompt_injection_text').val(presetContent);
            updatePresetSelect();
        }
    } else {
        statusHtml += `<strong>연동 상태:</strong> <span style="color: var(--color-text-vague);">없음 (기본 템플릿 사용 중)</span>`;
        $('#gen-remove-char-link-btn').hide();
    }

    $('#gen-char-link-info-area').html(statusHtml);
    $('#gen-save-char-link-btn').prop('disabled', false);
}

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
    
    // 1. 연동 정보 저장
    extension_settings[extensionName].linkedPresets[avatarFile] = presetName;
    
    // 2. 현재 활성 프롬프트도 해당 템플릿 내용으로 즉시 교체
    extension_settings[extensionName].promptInjection.prompt = presetContent;
    
    // 3. UI 동기화
    $('#prompt_injection_text').val(presetContent);
    updatePresetSelect(); // 드롭다운 선택 상태 업데이트
    
    saveSettingsDebounced();
    renderCharacterLinkUI();
    toastr.success(`${characters[charId].name} 캐릭터에게 '${presetName}' 템플릿이 연동되었습니다.`);
}

function onRemoveCharLink() {
    const context = getContext();
    const charId = context.characterId;
    if (!charId || !characters[charId]) return;

    const avatarFile = characters[charId].avatar;
    delete extension_settings[extensionName].linkedPresets[avatarFile];
    
    // 연동 해제 시 현재 텍스트 영역은 유지하되 드롭다운 상태 등만 갱신
    saveSettingsDebounced();
    renderCharacterLinkUI();
    updatePresetSelect();
    toastr.info("캐릭터 연동이 해제되었습니다.");
}

function renderAllLinkedPresetsList() {
    const $container = $('#gen-linked-char-list-container');
    $container.empty();

    const linked = extension_settings[extensionName].linkedPresets;
    if (!linked || Object.keys(linked).length === 0) {
        $container.append('<div style="padding: 15px; text-align: center; font-size: 0.85rem; color: var(--color-text-vague);">연동된 캐릭터가 없습니다.</div>');
        return;
    }

    const avatarToName = {};
    characters.forEach(c => avatarToName[c.avatar] = c.name);

    Object.keys(linked).forEach(avatarFile => {
        const presetName = linked[avatarFile];
        const charName = avatarToName[avatarFile] || `(알 수 없음: ${avatarFile})`;
        
        const $item = $(`
            <div class="gen-linked-item">
                <div style="font-size: 0.85rem; color: var(--color-text); flex: 1; min-width: 0;">
                    <div style="font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${charName}</div>
                    <div style="color: #4a90e2; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${presetName}</div>
                </div>
                <!-- 버튼에 gen-btn, gen-btn-red 클래스 추가 및 구조 개선 -->
                <button class="gen-btn gen-btn-red gen-delete-link-btn" data-avatar="${avatarFile}">삭제</button>
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

function updatePresetSelect() {
    const select = $('#prompt_preset_select');
    if (!select.length) return;

    const currentPrompt = extension_settings[extensionName].promptInjection.prompt;
    const presets = extension_settings[extensionName].promptPresets || {};
    
    select.empty();
    select.append('<option value="" disabled selected>-- Select Preset --</option>');

    let matchedKey = null;
    Object.keys(presets).sort().forEach(key => {
        const option = $('<option></option>').val(key).text(key);
        select.append(option);
        if (presets[key] === currentPrompt) matchedKey = key;
    });

    if (matchedKey) select.val(matchedKey);
    else select.val("");
}

// 주입할 프롬프트 결정 (연동 우선)
function getFinalPrompt() {
    const context = getContext();
    const charId = context.characterId;
    let finalPrompt = extension_settings[extensionName].promptInjection.prompt;

    if (charId && characters[charId]) {
        const avatarFile = characters[charId].avatar;
        const linkedPresetName = extension_settings[extensionName].linkedPresets[avatarFile];
        
        if (linkedPresetName && extension_settings[extensionName].promptPresets[linkedPresetName]) {
            finalPrompt = extension_settings[extensionName].promptPresets[linkedPresetName];
            console.log(`[Image Auto Gen] 연동된 프리셋 '${linkedPresetName}' 적용됨.`);
        }
    }
    return finalPrompt;
}

// 监听CHAT_COMPLETION_PROMPT_READY事件以注入提示词
eventSource.on(
    event_types.CHAT_COMPLETION_PROMPT_READY,
    async function (eventData) {
        try {
            if (!extension_settings[extensionName]?.promptInjection?.enabled || 
                extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) {
                return;
            }

            const prompt = getFinalPrompt(); // 연동된 프롬프트 가져오기
            const depth = extension_settings[extensionName].promptInjection.depth || 0;
            const role = extension_settings[extensionName].promptInjection.position.replace('deep_', '') || 'system';

            if (depth === 0) {
                eventData.chat.push({ role: role, content: prompt });
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
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        
        // 메뉴 아이템 ID 변경: auto_generation -> autopic_menu_item
        $('#extensionsMenu').append(`<div id="autopic_menu_item" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="AutoPic">AutoPic</span>
        </div>`);

        $('#autopic_menu_item').off('click').on('click', onExtensionButtonClick);

        await loadSettings();
        await addToWandMenu(); 
        await createSettings(settingsHtml);

        $('#extensions-settings-button').on('click', () => setTimeout(updateUI, 200));
        
        eventSource.on(event_types.MESSAGE_RENDERED, (mesId) => addRerollButtonToMessage(mesId));
        eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => addRerollButtonToMessage(mesId));

        $(document).on('click', '.image-reroll-button', function (e) {
            e.preventDefault(); e.stopPropagation();
            const messageBlock = $(this).closest('.mes');
            const mesId = messageBlock.attr('mesid');
            let $visibleImg = messageBlock.find('.mes_img_container:not([style*="display: none"]) img.mes_img');
            if ($visibleImg.length === 0) $visibleImg = messageBlock.find('img.mes_img').first();
            const imgTitle = $visibleImg.attr('title') || $visibleImg.attr('alt') || "";
            handleReroll(mesId, imgTitle);
        });
    })();
});

// 요술봉 메뉴 추가
async function addToWandMenu() {
    try {
        if ($('#st_image_reroll_wand_button').length > 0) return;
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        const extensionsMenu = $("#extensionsMenu");
        if (extensionsMenu.length > 0) {
            extensionsMenu.append(buttonHtml);
            
            // 이벤트 바인딩
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
        // i18n 속성이 있으면 동적 텍스트 변경을 방해할 수 있으므로 제거
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
    // UI 업데이트가 확실히 적용되도록 지연 없이 호출
    updateToggleButtonStyle();
}

async function handleLastImageReroll() {
    const context = getContext();
    const chat = context.chat;
    const regexString = extension_settings[extensionName]?.promptInjection?.regex || '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g';
    let imgTagRegex;
    try {
        imgTagRegex = regexFromString(regexString);
    } catch (e) {
        imgTagRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.is_user) continue;

        // 이미지가 이미 있는 메시지인 경우
        if (message.extra && (message.extra.image || message.extra.image_swipes)) {
            const currentTitle = message.extra.title || "";
            handleReroll(i, currentTitle);
            return;
        }

        // 텍스트에 태그만 있는 경우
        const match = message.mes.match(imgTagRegex);
        if (match) {
            // 정규식 결과에서 프롬프트 내용 추출 (첫 번째 매치 사용)
            const cleanMatch = match[0].match(/prompt="([^"]*)"/);
            const initialPrompt = cleanMatch ? cleanMatch[1] : "";
            handleReroll(i, initialPrompt);
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
            const rerollBtn = `<div title="Generate Another Image" class="right_menu_button fa-lg fa-solid fa-clone image-reroll-button interactable" role="button" tabindex="0"></div>`;
            const deleteBtn = $this.find('.mes_media_delete');
            if (deleteBtn.length) $(rerollBtn).insertBefore(deleteBtn);
            else $this.append(rerollBtn);
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

    // 1. 정규식 준비 및 모든 프롬프트 추출
    const regexString = extension_settings[extensionName]?.promptInjection?.regex || '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g';
    let regex;
    try {
        regex = regexFromString(regexString);
        if (!regex.global) regex = new RegExp(regex.source, regex.flags + 'g');
    } catch (e) {
        regex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g;
    }
    
    let textMatches = [];
    if (message.mes) {
        textMatches = [...message.mes.matchAll(regex)].map(m => m[1]);
    }
    
    // [수정됨] 텍스트 태그가 존재하면 태그 내용만 사용 (중복 방지), 태그가 없으면 현재 이미지 타이틀 사용
    let allPrompts = [];
    if (textMatches.length > 0) {
        allPrompts = [...new Set(textMatches)].filter(p => p && String(p).trim().length > 0);
    } else {
        allPrompts = [currentPrompt].filter(p => p && String(p).trim().length > 0);
    }
    
    if (allPrompts.length === 0) allPrompts = [""];

    // 2. 상태 저장용 변수
    let selectedIdx = 0;
    let editedPrompts = [...allPrompts];

    // 3. 팝업 HTML 생성
    let popupHtml = `<div class="reroll_popup_container" style="min-width:300px;">
        <h3 style="margin-bottom:15px; border-bottom:1px solid #4a90e2; padding-bottom:5px;">이미지 다시 생성</h3>
        <p style="font-size:0.85rem; color:#aaa; margin-bottom:15px;">생성할 프롬프트를 선택하거나 수정하세요:</p>`;
    
    allPrompts.forEach((prompt, idx) => {
        popupHtml += `
            <div class="prompt_option_item" style="margin-bottom:15px; padding:12px; background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:8px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <input type="radio" name="reroll_prompt_choice" class="reroll_radio" id="prompt_choice_${idx}" value="${idx}" ${idx === 0 ? 'checked' : ''}>
                    <label for="prompt_choice_${idx}" style="font-weight:bold; color:#4a90e2; cursor:pointer;">프롬프트 #${idx + 1}</label>
                </div>
                <textarea class="reroll_textarea text_pole" data-idx="${idx}" rows="3" style="width: 100%; background:#111; color:#fff; border:1px solid #444; border-radius:5px; padding:8px;">${escapeHtmlAttribute(String(prompt))}</textarea>
            </div>
        `;
    });
    popupHtml += `</div>`;

    // 4. 이벤트 리스너 등록 (팝업이 떠 있는 동안 작동)
    $(document).on('change', '.reroll_radio', function() {
        selectedIdx = parseInt($(this).val());
    });
    $(document).on('input', '.reroll_textarea', function() {
        const idx = $(this).data('idx');
        editedPrompts[idx] = $(this).val();
    });

    // 5. 모달 호출
    const result = await callGenericPopup(popupHtml, POPUP_TYPE.CONFIRM, '', { okButton: 'Generate', cancelButton: 'Cancel' });

    // 6. 리스너 해제 (중요: 메모리 누수 방지)
    $(document).off('change', '.reroll_radio');
    $(document).off('input', '.reroll_textarea');

    // 7. 결과 처리
    if (result) {
        const finalPrompt = editedPrompts[selectedIdx];
        if (finalPrompt && finalPrompt.trim()) {
            try {
                toastr.info("이미지 생성 중...");
                const resultUrl = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt.trim());
                
                if (typeof resultUrl === 'string' && !resultUrl.startsWith('Error')) {
                    if (!message.extra) message.extra = {};
                    message.extra.image_swipes = [resultUrl]; 
                    message.extra.image = resultUrl;
                    message.extra.title = finalPrompt.trim();
                    message.extra.inline_image = true;

                    const $mesBlock = $(`.mes[mesid="${mesId}"]`);
                    appendMediaToMessage(message, $mesBlock);
                    await context.saveChat();
                    toastr.success("이미지가 교체되었습니다.");
                } else {
                    toastr.error("생성 실패: SD 익스텐션 응답 확인 필요");
                }
            } catch (e) { 
                console.error(e);
                toastr.error("생성 중 오류 발생."); 
            }
        }
    }
}

// 메시지 수신 감시 및 자동 생성
eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    if (!extension_settings[extensionName] || extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) return;

    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user) return;

    const regex = regexFromString(extension_settings[extensionName].promptInjection.regex);
    const matches = regex.global ? [...message.mes.matchAll(regex)] : [message.mes.match(regex)].filter(Boolean);

    if (matches.length > 0) {
        setTimeout(async () => {
            try {
                toastr.info(`Generating ${matches.length} images...`);
                const insertType = extension_settings[extensionName].insertType;
                if (!message.extra) message.extra = {};
                if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
                const messageElement = $(`.mes[mesid="${context.chat.length - 1}"]`);

                for (const match of matches) {
                    const prompt = match?.[1] || '';
                    if (!prompt.trim()) continue;

                    const result = await SlashCommandParser.commands['sd'].callback({ quiet: insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true' }, prompt);
                    
                    if (typeof result === 'string' && result.trim().length > 0) {
                        if (insertType === INSERT_TYPE.INLINE) {
                            message.extra.image_swipes.push(result);
                            message.extra.image = result;
                            message.extra.title = prompt;
                            message.extra.inline_image = true;
                            appendMediaToMessage(message, messageElement);
                        } else if (insertType === INSERT_TYPE.REPLACE) {
                            const newTag = `<img src="${escapeHtmlAttribute(result)}" title="${escapeHtmlAttribute(prompt)}" alt="${escapeHtmlAttribute(prompt)}">`;
                            message.mes = message.mes.replace(match[0], newTag);
                            updateMessageBlock(context.chat.length - 1, message);
                            await eventSource.emit(event_types.MESSAGE_UPDATED, context.chat.length - 1);
                        }
                    }
                }
                await context.saveChat();
                toastr.success("Generation complete.");
            } catch (e) { console.error(e); }
        }, 100);
    }
});