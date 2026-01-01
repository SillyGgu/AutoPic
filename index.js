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


async function createSettings(settingsHtml) {
    if (!$('#autopic_settings_container').length) {
        $('#extensions_settings2').append(
            '<div id="autopic_settings_container" class="extension_container"></div>',
        );
    }

    $('#autopic_settings_container').empty().append(settingsHtml);


    $('.image-gen-nav-item').on('click', function() {
        $('.image-gen-nav-item').removeClass('active');
        $(this).addClass('active');
        const targetTabId = $(this).data('tab');
        $('.image-gen-tab-content').removeClass('active');
        $('#' + targetTabId).addClass('active');
        
        if (targetTabId === 'tab-gen-linking') renderCharacterLinkUI();
    });


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
        
        const presetContent = extension_settings[extensionName].promptPresets[linkedPreset];
        
        if (extension_settings[extensionName].promptInjection.prompt !== presetContent) {
            extension_settings[extensionName].promptInjection.prompt = presetContent;
            $('#prompt_injection_text').val(presetContent);
            updatePresetSelect();
        }
    } 

    else {
        statusHtml += `<strong>연동 상태:</strong> <span style="color: var(--color-text-vague);">없음 (전역 설정 사용 중)</span>`;
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

function getFinalPrompt() {
    const context = getContext();
    const charId = context.characterId;

    let finalPrompt = extension_settings[extensionName].promptInjection.prompt;

    if (charId && characters[charId]) {
        const avatarFile = characters[charId].avatar;
        const linkedPresetName = extension_settings[extensionName].linkedPresets[avatarFile];
        
        if (linkedPresetName && extension_settings[extensionName].promptPresets[linkedPresetName]) {
            finalPrompt = extension_settings[extensionName].promptPresets[linkedPresetName];
            console.log(`[AutoPic] 캐릭터 '${characters[charId].name}'에 연동된 프리셋 '${linkedPresetName}' 적용.`);
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
                
                @media (max-width: 1000px) {
                    .mes_media_wrapper {
                        margin-bottom: 45px !important;
                    }

                    .mes_img_swipes {
                        opacity: 1 !important;
                        pointer-events: auto !important;
                        z-index: 1000 !important;
                    }

                    .mes_img_swipe_counter {
                        font-size: 0.75rem !important;
                        opacity: 1 !important;
                        display: block !important;
                        visibility: visible !important;
                    }

                    .mes_img_swipe_left, .mes_img_swipe_right {
                        opacity: 0.1 !important; 
                        pointer-events: auto !important;
                        transition: opacity 0.2s !important;
                    }

                    .mes_media_container.ui-active .mes_img_swipe_left,
                    .mes_media_container.ui-active .mes_img_swipe_right {
                        opacity: 1 !important;
                    }
                }

                @media (min-width: 1000px) {
                    .mobile-ui-toggle { display: none; }
                }

				.mes_media_container::after {
					display: none !important;
				}
            </style>
        `);
        }

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

        $('#extensionsMenu').append(`<div id="autopic_menu_item" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="AutoPic">AutoPic</span>
        </div>`);

        $('#autopic_menu_item').off('click').on('click', onExtensionButtonClick);

        await loadSettings();
        await addToWandMenu();
        await createSettings(settingsHtml);

        $('#extensions-settings-button').on('click', () => setTimeout(updateUI, 200));

        eventSource.on(event_types.MESSAGE_RENDERED, (mesId) => {
            addRerollButtonToMessage(mesId);
            addMobileToggleToMessage(mesId);
        });
        eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => {
            addRerollButtonToMessage(mesId);
            addMobileToggleToMessage(mesId);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => renderCharacterLinkUI());

        /* -------------------------------------------------------
         * 모바일 전용: 돋보기 차단 및 UI 토글 로직 (Capture phase)
         * ------------------------------------------------------- */
        document.addEventListener('click', function (e) {
            if (window.innerWidth >= 1000) return;

            const target = e.target;
            const $mediaContainer = $(target).closest('.mes_media_container');
            
            if ($mediaContainer.length === 0) {
                $('.mes_media_container.ui-active').removeClass('ui-active');
                return;
            }

            const isButton = $(target).closest('.mes_img_controls, .mes_img_swipes, .mobile-ui-toggle').length > 0;

            if (!$mediaContainer.hasClass('ui-active')) {
                e.stopImmediatePropagation();
                e.preventDefault();
                $('.mes_media_container.ui-active').removeClass('ui-active');
                $mediaContainer.addClass('ui-active');
            } else {
                if (!isButton) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    $mediaContainer.removeClass('ui-active');
                }
            }
        }, true);

        $(document).on('click', '.image-reroll-button', function (e) {
            const messageBlock = $(this).closest('.mes');
            const mesId = messageBlock.attr('mesid');
            let $visibleImg = messageBlock.find('.mes_img_container:not([style*="display: none"]) img.mes_img');
            if ($visibleImg.length === 0) $visibleImg = messageBlock.find('img.mes_img').first();
            const imgTitle = $visibleImg.attr('title') || $visibleImg.attr('alt') || "";
            handleReroll(mesId, imgTitle);
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
    const imgRegex = /<img[^>]*\stitle="([^"]*)"[^>]*?>/g;

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.is_user) continue;

        const hasPic = message.mes.match(picRegex);
        const hasImg = message.mes.match(imgRegex);

        if (hasPic || hasImg) {
            handleReroll(i, ""); 
            return;
        }

        if (message.extra && (message.extra.image || message.extra.image_swipes)) {
            const currentTitle = message.extra.title || "";
            handleReroll(i, currentTitle);
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
async function handleReroll(mesId, currentPrompt) {
    if (!SlashCommandParser.commands['sd']) {
        toastr.error("Stable Diffusion extension not loaded.");
        return;
    }
    
    const context = getContext();
    const message = context.chat[mesId];
    if (!message) return;

    const currentInsertType = extension_settings[extensionName].insertType;

    const picRegex = /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g;
    const imgRegex = /<img[^>]*\ssrc="([^"]*)"[^>]*\stitle="([^"]*)"[^>]*?>/g;
    
    let foundItems = []; 

    // 1. 본문에서 태그 수집
    let picMatches = [...message.mes.matchAll(picRegex)];
    picMatches.forEach(m => {
        foundItems.push({ originalTag: m[0], prompt: m[1], type: 'tag' });
    });

    let imgMatches = [...message.mes.matchAll(imgRegex)];
    imgMatches.forEach(m => {
        foundItems.push({ originalTag: m[0], prompt: m[2], type: 'tag' });
    });

    // 2. 스와이프 이미지 수집 (인라인 모드 대응)
    if (message.extra && message.extra.image_swipes && message.extra.image_swipes.length > 0) {
        message.extra.image_swipes.forEach((src, sIdx) => {
            foundItems.push({ 
                swipeIdx: sIdx, 
                prompt: message.extra.title || currentPrompt || "", 
                type: 'swipe' 
            });
        });
    }

    // 3. 아무것도 없을 때 예외 처리
    if (foundItems.length === 0 && currentPrompt) {
        foundItems.push({ originalTag: null, prompt: currentPrompt, type: 'extra' });
    }
    if (foundItems.length === 0) {
        foundItems.push({ originalTag: null, prompt: "", type: 'extra' });
    }

    let selectedIdx = 0;
    let editedPrompts = foundItems.map(item => item.prompt);

    let popupHtml = `<div class="reroll_popup_container" style="min-width:300px;">
        <h3 style="margin-bottom:15px; border-bottom:1px solid #4a90e2; padding-bottom:5px;">이미지 다시 생성</h3>
        <p style="font-size:0.85rem; color:#aaa; margin-bottom:15px;">교체할 이미지를 선택하거나 프롬프트를 수정하세요:</p>`;
    
    foundItems.forEach((item, idx) => {
        const typeLabel = item.type === 'tag' ? '본문 태그' : (item.type === 'swipe' ? `스와이프 #${item.swipeIdx + 1}` : '기타');
        popupHtml += `
            <div class="prompt_option_item" style="margin-bottom:15px; padding:12px; background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:8px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <input type="radio" name="reroll_prompt_choice" class="reroll_radio" id="prompt_choice_${idx}" value="${idx}" ${idx === 0 ? 'checked' : ''}>
                    <label for="prompt_choice_${idx}" style="font-weight:bold; color:#4a90e2; cursor:pointer;">이미지 #${idx + 1} (${typeLabel})</label>
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
                const resultUrl = await SlashCommandParser.commands['sd'].callback({ quiet: 'true' }, finalPrompt.trim());
                
                if (typeof resultUrl === 'string' && !resultUrl.startsWith('Error')) {
                    
                    if (currentInsertType === INSERT_TYPE.REPLACE && targetItem.originalTag) {
                        // 1. 태그 치환 모드일 때만 본문 텍스트 수정
                        const newTag = `<img src="${escapeHtmlAttribute(resultUrl)}" title="${escapeHtmlAttribute(finalPrompt.trim())}" alt="${escapeHtmlAttribute(finalPrompt.trim())}">`;
                        message.mes = message.mes.replace(targetItem.originalTag, newTag);
                        updateMessageBlock(mesId, message);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, mesId);
                    } 
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

                        const $mesBlock = $(`.mes[mesid="${mesId}"]`);
                        appendMediaToMessage(message, $mesBlock);
                        updateMessageBlock(mesId, message);
                    }

                    await eventSource.emit(event_types.MESSAGE_RENDERED, mesId);
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

    // 정규식 설정
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
            let firstNewImage = null;
            let updatedMes = message.mes;

            for (let i = 0; i < matches.length; i++) {
                toastr.info(`이미지 생성 중... (${i + 1} / ${total})`, "AutoPic", { "timeOut": 2000 });

                const match = matches[i];
                const fullTag = match[0];
                const prompt = match[1] || '';
                
                if (!prompt.trim()) continue;

                const result = await SlashCommandParser.commands['sd'].callback(
                    { quiet: (insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true') }, 
                    prompt.trim()
                );
                
                if (typeof result === 'string' && result.trim().length > 0 && !result.startsWith('Error')) {
                    hasChanged = true;
                    
                    if (insertType === INSERT_TYPE.INLINE) {
                        message.extra.image_swipes.push(result);
                        if (!firstNewImage) firstNewImage = result;
                    } 
                    else if (insertType === INSERT_TYPE.REPLACE) {
                        const newTag = `<img src="${escapeHtmlAttribute(result)}" title="${escapeHtmlAttribute(prompt)}" alt="${escapeHtmlAttribute(prompt)}">`;
                        updatedMes = updatedMes.replace(fullTag, () => newTag);
                    }
                } else {
                    toastr.error(`${i + 1}번째 이미지 생성에 실패했습니다.`);
                }
            }

            if (hasChanged) {
                if (insertType === INSERT_TYPE.INLINE) {
                    message.extra.image = firstNewImage; 
                    message.extra.inline_image = true;
                    appendMediaToMessage(message, messageElement);
                } 
                else if (insertType === INSERT_TYPE.REPLACE) {
                    message.mes = updatedMes;
                }
                
                updateMessageBlock(currentIdx, message);
                
                await eventSource.emit(event_types.MESSAGE_UPDATED, currentIdx);
                await eventSource.emit(event_types.MESSAGE_RENDERED, currentIdx);
                
                await context.saveChat();
                toastr.success(`총 ${total}개의 이미지 생성 및 저장 완료!`);
            }
        } catch (e) { 
            console.error("[AutoPic] 오류:", e); 
            toastr.error("이미지 생성 과정에서 오류가 발생했습니다.");
        }
    }, 200);
});