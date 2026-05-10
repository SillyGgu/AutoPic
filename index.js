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
import { ConnectionManagerRequestService } from '../../shared.js';


const extensionName = 'AutoPic';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

function getCurrentAutopicCharacterPromptsForNai() {
    try {
        const context = getContext();
        const charId = context.characterId ?? characters.findIndex(c => c.avatar === context.character?.avatar);

        if (charId === undefined || charId === -1 || !characters[charId]) {
            return [];
        }

        const avatarFile = characters[charId].avatar;
        const charData = extension_settings[extensionName]?.characterPrompts?.[avatarFile];

        if (!Array.isArray(charData)) {
            return [];
        }

        return charData
            .map((item, index) => ({
                name: String(item?.name ?? '').trim(),
                prompt: String(item?.prompt ?? '').trim(),
                uc: String(item?.uc ?? '').trim(),
                enabled: item?.enabled !== false,
                source: 'autopic',
                slot: index + 1,
            }))
            .filter(item => item.enabled && item.prompt);
    } catch (error) {
        console.warn('[AutoPic Interceptor] Failed to collect AutoPic character prompts:', error);
        return [];
    }
}

function shouldUseAutopicNaiProxy() {
    if (!getNaiParams()?.useServerPlugin) return !!pendingNaiPayload;
    return !!pendingNaiPayload || !!getNaiParams()?.useNaiRescale || getCurrentAutopicCharacterPromptsForNai().length > 0;
}

// ── NAI fetch 인터셉터 ────────────────────────────────────────
// ST의 /api/novelai/generate-image 요청을 가로채서
// AutoPic 프록시(/api/plugins/autopic/generate-image)로 리다이렉트한다.
// 프록시는 cfg_rescale을 포함해 NAI API에 전달한다.
(function installNaiFetchInterceptor() {
    const _fetch = window.fetch.bind(window);
    window.fetch = async function (input, init, ...rest) {
        const url = typeof input === 'string' ? input
            : (input instanceof Request ? input.url : String(input));

        if (url.includes('/api/novelai/generate-image') && init?.body && shouldUseAutopicNaiProxy()) {
            try {
                const body = JSON.parse(init.body);
                const naiParams = getNaiParams();
                const cfg  = naiParams?.cfg_rescale ?? 0;
				let autopicCharacterPrompts;
				if (pendingNaiPayload) {
					autopicCharacterPrompts = [];
				} else {
					// ST 기본 reroll: body.input에 <autopic> 블록이 포함된 경우 직접 파싱
					const stRerollParsed = (() => {
						try {
							const mainPrompt = body.input || body.prompt || '';
							const parsed = getStructuredRequestsFromText(mainPrompt);
							if (parsed.length > 0 && parsed[0].naiPayload?.characterPrompts?.length > 0) {
								return parsed[0].naiPayload;
							}
						} catch (_) {}
						return null;
					})();

					if (stRerollParsed) {
						autopicCharacterPrompts = stRerollParsed.characterPrompts;
						console.log('[AutoPic Interceptor] ST reroll: body.prompt에서 apchar extra prompt 파싱 성공:', autopicCharacterPrompts);
						// <autopic> 블록을 body.prompt에서 제거하고 scene을 주입
						const scenePrompt = stRerollParsed.prompt || '';
						body.prompt = (body.prompt || '').replace(/<autopic\b[^>]*>[\s\S]*?<\/autopic>/gi, '').trim();
						if (scenePrompt) {
							body.prompt = body.prompt ? body.prompt + ', ' + scenePrompt : scenePrompt;
						}
						console.log('[AutoPic Interceptor] ST reroll: body.prompt에서 <autopic> 제거 및 scene 주입 완료:', scenePrompt);
					} else {
						autopicCharacterPrompts = getCurrentAutopicCharacterPromptsForNai();
					}
				}
                const existingCharacterPrompts = Array.isArray(body.characterPrompts) ? body.characterPrompts : [];
                const pendingCharacterPrompts = Array.isArray(pendingNaiPayload?.characterPrompts)
                    ? pendingNaiPayload.characterPrompts
                    : [];

                body.cfg_rescale = cfg;
                body.character_positions_ai_choice = !!naiParams?.useCharacterPositionsAiChoice;
                if (pendingNaiPayload?.negative_prompt) {
                    body.negative_prompt = [body.negative_prompt, pendingNaiPayload.negative_prompt]
                        .filter(Boolean)
                        .join(', ');
                }
                body.characterPrompts = [
                    ...existingCharacterPrompts,
                    ...pendingCharacterPrompts,
                    ...autopicCharacterPrompts,
                ];
                console.log('[AutoPic Interceptor] cfg_rescale 주입:', cfg, '→ 프록시로 리다이렉트');

                console.log('[AutoPic Interceptor] characterPrompts:', body.characterPrompts.length);

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
const NAI_DEFAULTS = {
    cfg_rescale: 0.0,
    useNaiRescale: false,
    useServerPlugin: false,
    useCharacterPositionsAiChoice: true,
};
const MANUAL_DEFAULTS = {
    enabled: true,
    profileId: '',
    maxTokens: 700,
};

function getNaiParams() {
    const s = extension_settings[extensionName];
    if (!s.naiParams) s.naiParams = { ...NAI_DEFAULTS };
    for (const [k, v] of Object.entries(NAI_DEFAULTS)) {
        if (s.naiParams[k] === undefined) s.naiParams[k] = v;
    }
    return s.naiParams;
}

function getManualParams() {
    const s = extension_settings[extensionName];
    if (!s.manualGeneration) s.manualGeneration = { ...MANUAL_DEFAULTS };
    for (const [k, v] of Object.entries(MANUAL_DEFAULTS)) {
        if (s.manualGeneration[k] === undefined) s.manualGeneration[k] = v;
    }
    return s.manualGeneration;
}
// ─────────────────────────────────────────────────────────────

const INSERT_TYPE = {
    DISABLED: 'disabled',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

let pendingNaiPayload = null;

function initializeAllManualButtons() {
    const context = getContext();
    if (context && context.chat) {
        context.chat.forEach((_, index) => addManualGenerateButtonToMessage(index));
    }
}

function addManualGenerateButtonToMessage(mesId) {
    const manual = getManualParams();
    const $message = $(`.mes[mesid="${mesId}"]`);
    const message = getContext()?.chat?.[mesId];

    if (!$message.length || !message || message.is_user) return;

    if (!manual.enabled) {
        $message.find('.autopic-manual-generate-btn').remove();
        return;
    }

    if ($message.find('.autopic-manual-generate-btn').length) return;

    const $target = $message.find('.extraMesButtons').first();
    if (!$target.length) return;

    const $btn = $('<div>')
        .addClass('mes_button autopic-manual-generate-btn fa-solid fa-image interactable')
        .attr('title', 'AutoPic 수동 이미지 생성')
        .css({ opacity: '0.8', 'margin-left': '5px', color: '#4a90e2' })
        .on('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const currentId = $btn.closest('.mes').attr('mesid');
            await handleManualGenerate(currentId !== undefined ? currentId : mesId);
        });

    $target.append($btn);
}

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

function decodeHtmlAttribute(value) {
    if (typeof value !== 'string') return '';

    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
}

function normalizeRefName(value) {
    return String(value ?? '').trim().toLowerCase();
}

function getTagContents(source, tagName) {
    const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    return [...String(source ?? '').matchAll(regex)].map(match => ({
        attrs: match[1] || '',
        content: decodeHtmlAttribute(match[2] || '').trim(),
    }));
}

function getAttrValue(attrs, name) {
    const regex = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
    const match = String(attrs ?? '').match(regex);
    return match ? decodeHtmlAttribute(match[1]).trim() : '';
}

function createAutopicImageTag(src, title, idPrefix = 'tag') {
    const tagId = `${idPrefix}-${Date.now()}`;
    const titleText = escapeHtmlAttribute(String(title || ''));
    return `<img src="${escapeHtmlAttribute(src)}" data-autopic-id="${tagId}" title="${titleText}">`;
}

function findFirstAutopicImageRange(messageText) {
    const text = String(messageText ?? '');
    const idMatch = text.match(/data-autopic-id=["'][^"']*["']/i);
    if (!idMatch) return null;

    const idIndex = idMatch.index ?? -1;
    const imageStart = idIndex >= 0 ? text.lastIndexOf('<img', idIndex) : -1;
    if (imageStart < 0) return null;

    const lowerText = text.toLowerCase();
    const rawAutopicEnd = lowerText.indexOf('</autopic>', idIndex);
    const escapedAutopicEnd = lowerText.indexOf('&lt;/autopic&gt;', idIndex);
    let imageEnd = -1;

    if (rawAutopicEnd >= 0) {
        imageEnd = rawAutopicEnd + '</autopic>'.length;
    } else if (escapedAutopicEnd >= 0) {
        imageEnd = escapedAutopicEnd + '&lt;/autopic&gt;'.length;
    } else {
        imageEnd = text.indexOf('>', idIndex);
        if (imageEnd >= 0) imageEnd += 1;
    }

    if (imageEnd < 0) return null;

    while (text.slice(imageEnd, imageEnd + 2) === '">' || text.slice(imageEnd, imageEnd + 2) === "'>") {
        imageEnd += 2;
    }
    while (text.slice(imageEnd, imageEnd + 10).toLowerCase() === '&quot;&gt;') {
        imageEnd += 10;
    }

    return { start: imageStart, end: imageEnd };
}

function replaceFirstAutopicImageOrAppend(messageText, replacement) {
    const text = String(messageText ?? '');
    const value = String(replacement ?? '');
    const range = findFirstAutopicImageRange(text);

    if (range) {
        return text.slice(0, range.start) + value + text.slice(range.end);
    }

    return value ? `${text}${text ? '<br>' : ''}${value}` : text;
}

function stripAutopicImagesForStructuredScan(messageText) {
    let text = String(messageText ?? '');
    let guard = 0;

    while (guard < 20) {
        const range = findFirstAutopicImageRange(text);
        if (!range) break;
        text = text.slice(0, range.start) + text.slice(range.end);
        guard++;
    }

    return text;
}

function getAutopicImageTagById(messageText, autopicId) {
    const id = String(autopicId ?? '');
    if (!id) return null;

    const text = String(messageText ?? '');
    const tempDiv = document.createElement('div');

    for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
        tempDiv.innerHTML = match[0];
        const img = tempDiv.querySelector('img');
        if (img?.getAttribute('data-autopic-id') === id) {
            return match[0];
        }
    }

    return null;
}

function getAutopicImageRangeById(messageText, autopicId) {
    const id = String(autopicId ?? '');
    if (!id) return null;

    const text = String(messageText ?? '');
    const tempDiv = document.createElement('div');

    for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
        tempDiv.innerHTML = match[0];
        const img = tempDiv.querySelector('img');
        if (img?.getAttribute('data-autopic-id') === id) {
            return { start: match.index, end: match.index + match[0].length };
        }
    }

    return null;
}

function replaceOrAppendAutopicTag(messageText, fullTag, replacement) {
    const text = String(messageText ?? '');
    const value = String(replacement ?? '');
    const rawTag = String(fullTag ?? '');
    const escapedTag = rawTag ? escapeHtmlAttribute(rawTag) : '';
    const idMatch = rawTag.match(/data-autopic-id=["']([^"']*)["']/i);

    if (idMatch?.[1]) {
        const range = getAutopicImageRangeById(text, idMatch[1]);
        if (range) {
            return text.slice(0, range.start) + value + text.slice(range.end);
        }

        const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const imageByIdRegex = new RegExp(`<img\\b(?=[\\s\\S]*?data-autopic-id=["']${id}["'])[\\s\\S]*?(?:"?>|&quot;&gt;)`, 'i');
        if (imageByIdRegex.test(text)) {
            return text.replace(imageByIdRegex, value);
        }
    }

    if (rawTag && text.includes(rawTag)) {
        return text.replace(rawTag, value);
    }

    if (escapedTag && text.includes(escapedTag)) {
        return text.replace(escapedTag, value);
    }

    const rawAutopicRegex = /<autopic\b[^>]*>[\s\S]*?<\/autopic>/i;
    if (rawAutopicRegex.test(text)) {
        return text.replace(rawAutopicRegex, value);
    }

    const escapedAutopicRegex = /&lt;autopic\b[\s\S]*?&lt;\/autopic&gt;/i;
    if (escapedAutopicRegex.test(text)) {
        return text.replace(escapedAutopicRegex, value);
    }

    const rawPicRegex = /<pic[^>]*\sprompt="[^"]*"[^>]*>/i;
    if (rawPicRegex.test(text)) {
        return text.replace(rawPicRegex, value);
    }

    const escapedPicRegex = /&lt;pic[\s\S]*?&gt;/i;
    if (escapedPicRegex.test(text)) {
        return text.replace(escapedPicRegex, value);
    }

    return value ? `${text}${text ? '<br>' : ''}${value}` : text;
}

function getCurrentAutopicCharacterLibraryForNai() {
    const items = getCurrentAutopicCharacterPromptsForNai();
    const byName = new Map();

    for (const item of items) {
        if (item.name) {
            byName.set(normalizeRefName(item.name), item);
        }
    }

    return { items, byName };
}

function parseStructuredPicBlock(fullTag, content) {
    const scene = getTagContents(content, 'scene').map(item => item.content).filter(Boolean).join(', ');
    const uc = getTagContents(content, 'uc').map(item => item.content).filter(Boolean).join(', ');
    const charBlocks = getTagContents(content, 'apchar');
    const { byName } = getCurrentAutopicCharacterLibraryForNai();
    const characterPrompts = [];

    for (const block of charBlocks) {
        const ref = getAttrValue(block.attrs, 'ref') || getAttrValue(block.attrs, 'name');
        const refKey = normalizeRefName(ref);
        const extraPrompt = block.content;

        if (refKey && byName.has(refKey)) {
            const baseCharacter = byName.get(refKey);
            characterPrompts.push({
                name: baseCharacter.name,
                prompt: [baseCharacter.prompt, extraPrompt].filter(Boolean).join(', '),
                uc: baseCharacter.uc || '',
                enabled: true,
                source: 'autopic-ref',
                ref,
            });
            continue;
        }

        if (refKey) {
            console.warn(`[AutoPic] Character ref not found: "${ref}". Treating it as a normal character prompt.`);
        }

        if (extraPrompt) {
            characterPrompts.push({
                name: ref || '',
                prompt: extraPrompt,
                enabled: true,
                source: refKey ? 'unmatched-ref' : 'structured',
                ref,
            });
        }
    }

    return {
        fullTag,
        prompt: scene,
        editText: fullTag,
        naiPayload: {
            prompt: scene,
            negative_prompt: uc,
            characterPrompts,
        },
        isStructured: true,
    };
}

function getStructuredRequestsFromText(text) {
    return extractPicRequests(text, /<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g)
        .filter(request => request.isStructured);
}

function extractPicRequests(messageText, fallbackRegex) {
    const text = decodeHtmlAttribute(String(messageText ?? ''));
    const requests = [];
    const structuredRegex = /<autopic\b([^>]*)>([\s\S]*?)<\/autopic>/gi;

    for (const match of text.matchAll(structuredRegex)) {
        const request = parseStructuredPicBlock(match[0], match[2] || '');
        if (request.prompt || request.naiPayload.characterPrompts.length > 0) {
            requests.push(request);
        }
    }

    if (requests.length > 0) {
        return requests;
    }

    return [...text.matchAll(fallbackRegex)].map(match => ({
        fullTag: match[0],
        prompt: decodeHtmlAttribute(match[1] || '').trim(),
        editText: decodeHtmlAttribute(match[1] || '').trim(),
        naiPayload: null,
        isStructured: false,
    }));
}

const defaultAutoPicSettings = {
    insertType: INSERT_TYPE.DISABLED,
    lastNonDisabledType: INSERT_TYPE.INLINE, 
    theme: 'dark',
    promptInjection: {
        enabled: true,
        prompt: `<image_generation>\nWhen an image should be generated, insert exactly one structured image block at the end of the reply.\nUse this format:\n<autopic>\n<scene>background, location, mood, composition, camera distance, lighting, non-character situation tags</scene>\n<apchar ref="registered character name">temporary expression, pose, action, outfit changes, interaction tags only</apchar>\n<apchar>full visual tags for an unregistered character</apchar>\n<uc>optional negative prompt tags only when needed</uc>\n</autopic>\nRules:\n- Write image tags in English.\n- Do not write final NovelAI character prompts yourself; AutoPic will assemble them.\n- If a character is registered in AutoPic, use <apchar ref="name"> and do not repeat their base appearance tags.\n- If a character is not registered in AutoPic, use <apchar> with their full appearance tags.\n- Put background, place, mood, composition, count tags, and shared actions in <scene>.\n- Put character-specific pose, expression, action, and temporary clothing in the matching <apchar> block.\n- Do not use Character 1: labels inside <scene>.\n</image_generation>`,
        regex: '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
        position: 'deep_system',
        depth: 0, 
    },
    promptPresets: {
        "Default": `<image_generation>\nWhen an image should be generated, insert exactly one structured image block at the end of the reply.\nUse this format:\n<autopic>\n<scene>background, location, mood, composition, camera distance, lighting, non-character situation tags</scene>\n<apchar ref="registered character name">temporary expression, pose, action, outfit changes, interaction tags only</apchar>\n<apchar>full visual tags for an unregistered character</apchar>\n<uc>optional negative prompt tags only when needed</uc>\n</autopic>\nRules:\n- Write image tags in English.\n- Do not write final NovelAI character prompts yourself; AutoPic will assemble them.\n- If a character is registered in AutoPic, use <apchar ref="name"> and do not repeat their base appearance tags.\n- If a character is not registered in AutoPic, use <apchar> with their full appearance tags.\n- Put background, place, mood, composition, count tags, and shared actions in <scene>.\n- Put character-specific pose, expression, action, and temporary clothing in the matching <apchar> block.\n- Do not use Character 1: labels inside <scene>.\n</image_generation>`
    },
    linkedPresets: {},
    characterPrompts: {},
    naiParams: { ...NAI_DEFAULTS },
    manualGeneration: { ...MANUAL_DEFAULTS },
};

const STRUCTURED_BLOCKS_PROMPT_VERSION = 3;
const STRUCTURED_BLOCKS_PROMPT = `<image_generation>\nWhen an image should be generated, insert exactly one structured image block at the end of the reply.\nUse this exact format:\n<autopic>\n<scene>character count tags, background, location, mood, composition, camera distance, lighting, shared actions, non-character situation tags</scene>\n<apchar ref="registered character name">temporary expression, pose, action, gaze, outfit changes, interaction tags only</apchar>\n<apchar>full visual tags for an unregistered character only</apchar>\n<uc>optional negative prompt tags only when needed</uc>\n</autopic>\nRules:\n- Write image tags in English.\n- AutoPic assembles NovelAI character prompts. Do not write a final combined NovelAI prompt yourself.\n- If a character appears in <autopic_registered_characters>, you must use <apchar ref="exact name"> for that character.\n- For registered characters, never copy their base appearance tags into <scene>.\n- For registered characters, never repeat their base appearance tags inside the <apchar ref> body. Only write temporary expression, pose, action, gaze, outfit changes, and interaction tags there.\n- Put character count tags such as 1girl, 1boy, 2girls, 1girl 1boy in <scene>.\n- Put background, place, mood, composition, camera distance, lighting, and shared actions in <scene>.\n- Use plain <apchar> only for unregistered characters, and include their full visual tags there.\n- Do not use Character 1: labels.\n- Do not use the old <pic prompt="..."> format.\n</image_generation>`;
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
		$('#nai_use_server_plugin').prop('checked', !!nai.useServerPlugin);
		$('#nai_plugin_options').css({ opacity: nai.useServerPlugin ? '1' : '0.4', 'pointer-events': nai.useServerPlugin ? 'auto' : 'none' });
        $('#nai_character_positions_ai_choice').prop('checked', !!nai.useCharacterPositionsAiChoice);
		$('#nai_cfg_rescale').val(nai.cfg_rescale);
		$('#nai_cfg_rescale_display').text(Number(nai.cfg_rescale).toFixed(2));
        renderManualProfileSelect();
        const manual = getManualParams();
        $('#autopic_manual_enabled').prop('checked', !!manual.enabled);
        $('#autopic_manual_profile').val(manual.profileId || '');
        $('#autopic_manual_max_tokens').val(manual.maxTokens);
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
        if (
            !extension_settings[extensionName].promptPresets["Structured Blocks"] ||
            extension_settings[extensionName].structuredBlocksPromptVersion !== STRUCTURED_BLOCKS_PROMPT_VERSION
        ) {
            extension_settings[extensionName].promptPresets["Structured Blocks"] = STRUCTURED_BLOCKS_PROMPT;
            extension_settings[extensionName].structuredBlocksPromptVersion = STRUCTURED_BLOCKS_PROMPT_VERSION;
        }
        if (!extension_settings[extensionName].promptPresets["Structured Blocks"]) {
            extension_settings[extensionName].promptPresets["Structured Blocks"] = defaultAutoPicSettings.promptInjection.prompt;
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
			// 구버전 호환: useServerPlugin이 없던 시절 저장된 경우 기본 false
			if (extension_settings[extensionName].naiParams.useServerPlugin === undefined) {
				extension_settings[extensionName].naiParams.useServerPlugin = false;
			}
            if (extension_settings[extensionName].naiParams.useCharacterPositionsAiChoice === undefined) {
                extension_settings[extensionName].naiParams.useCharacterPositionsAiChoice = true;
            }
        }
        if (!extension_settings[extensionName].manualGeneration) {
            extension_settings[extensionName].manualGeneration = { ...MANUAL_DEFAULTS };
        } else {
            for (const [k, v] of Object.entries(MANUAL_DEFAULTS)) {
                if (extension_settings[extensionName].manualGeneration[k] === undefined) {
                    extension_settings[extensionName].manualGeneration[k] = v;
                }
            }
        }
    }
    if (!extension_settings[extensionName].promptPresets) {
        extension_settings[extensionName].promptPresets = {};
    }
    if (
        !extension_settings[extensionName].promptPresets["Structured Blocks"] ||
        extension_settings[extensionName].structuredBlocksPromptVersion !== STRUCTURED_BLOCKS_PROMPT_VERSION
    ) {
        extension_settings[extensionName].promptPresets["Structured Blocks"] = STRUCTURED_BLOCKS_PROMPT;
        extension_settings[extensionName].structuredBlocksPromptVersion = STRUCTURED_BLOCKS_PROMPT_VERSION;
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
    localizeSettingsLabels();


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
    $('#autopic_manual_enabled').on('change', function () {
        getManualParams().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        initializeAllManualButtons();
    });
    $('#autopic_manual_profile').on('change', function () {
        getManualParams().profileId = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#autopic_manual_max_tokens').on('input', function () {
        const value = Number($(this).val());
        getManualParams().maxTokens = Number.isFinite(value) && value > 0 ? value : MANUAL_DEFAULTS.maxTokens;
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
	$('#nai_use_server_plugin').on('change', function() {
		const enabled = $(this).prop('checked');
		getNaiParams().useServerPlugin = enabled;
		getNaiParams().useNaiRescale = enabled ? getNaiParams().useNaiRescale : false;
		$('#nai_plugin_options').css({ opacity: enabled ? '1' : '0.4', 'pointer-events': enabled ? 'auto' : 'none' });
		saveSettingsDebounced();
	});

	$('#nai_cfg_rescale').on('input', function() {
		const val = parseFloat($(this).val());
		getNaiParams().cfg_rescale = isNaN(val) ? 0 : val;
		$('#nai_cfg_rescale_display').text(getNaiParams().cfg_rescale.toFixed(2));
		saveSettingsDebounced();
	});
    $('#nai_character_positions_ai_choice').on('change', function() {
        getNaiParams().useCharacterPositionsAiChoice = $(this).prop('checked');
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
                        <span style="font-weight:bold; font-size:0.8rem; color:var(--ap-accent);">#${slotNum} - {autopic_char${slotNum}} - ${escapeHtmlAttribute(item.name || 'unnamed')}</span>
                    </label>
                    <button class="remove-char-prompt-btn gen-btn gen-btn-red" data-index="${index}" style="padding:2px 8px; font-size:0.7rem;">삭제</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <input class="gen-custom-input char-name-input" data-index="${index}" value="${escapeHtmlAttribute(item.name || '')}" placeholder="Reference name for &lt;apchar ref=&quot;name&quot;&gt;">
                    <textarea class="gen-custom-input char-prompt-input" data-index="${index}" rows="2" placeholder="캐릭터 외형 프롬프트" style="resize: vertical;">${item.prompt || ''}</textarea>
                    <textarea class="gen-custom-input char-uc-input" data-index="${index}" rows="1" placeholder="캐릭터 UC (선택사항)" style="resize: vertical;">${item.uc || ''}</textarea>
                </div>
            </div>
        `;
        $list.append(html);
    });

    $('.char-name-input').off('input').on('input', function() {
        const idx = $(this).data('index');
        charData[idx].name = $(this).val();
        saveSettingsDebounced();
    });

    $('.char-prompt-input').off('input').on('input', function() {
        const idx = $(this).data('index');
        charData[idx].prompt = $(this).val();
        saveSettingsDebounced();
    });

    $('.char-uc-input').off('input').on('input', function() {
        const idx = $(this).data('index');
        charData[idx].uc = $(this).val();
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

    extension_settings[extensionName].characterPrompts[avatarFile].push({ name: '', prompt: '', enabled: true });
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

function renderManualProfileSelect() {
    const $select = $('#autopic_manual_profile');
    if (!$select.length) return;

    const manual = getManualParams();
    const current = manual.profileId || '';
    const context = getContext();
    const manager = context?.extensionSettings?.connectionManager;
    const profiles = Array.isArray(manager?.profiles) ? manager.profiles : [];

    $select.empty();
    $select.append('<option value="">연결 프로필 선택</option>');

    for (const profile of profiles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const value = escapeHtmlAttribute(profile.id || '');
        const label = escapeHtmlAttribute(profile.name || profile.id || 'Unnamed profile');
        $select.append(`<option value="${value}">${label}</option>`);
    }

    if (current && profiles.some(profile => profile.id === current)) {
        $select.val(current);
    } else {
        $select.val('');
    }
}

function localizeSettingsLabels() {
    const legacyCodeStyle = 'background:var(--ap-bg-item); color:var(--ap-text); border:1px solid var(--ap-border); padding: 1px 5px; border-radius: 3px;';

    $('#prompt_injection_regex')
        .attr('placeholder', '예: /<pic[^>]*\\sprompt=([^>]*?)>/g')
        .prev('p')
        .html(`구버전 <code style="${legacyCodeStyle}">&lt;pic prompt="..."&gt;</code> 방식 전용입니다. <code style="${legacyCodeStyle}">&lt;autopic&gt;</code> 사용 시 무시됩니다.`);

    $('#autopic_settings_container .gen-section-title').each(function () {
        if ($(this).text().trim() === 'Manual Image Generation') {
            $(this).text('수동 이미지 생성');
        }
    });
}

function buildAvailableCharacterRefsPrompt(charData) {
    const refs = Array.isArray(charData)
        ? charData
            .map((item, index) => ({
                name: String(item?.name ?? '').trim(),
                prompt: String(item?.prompt ?? '').trim(),
                enabled: item?.enabled !== false,
                slot: index + 1,
            }))
            .filter(item => item.enabled && item.name && item.prompt)
        : [];

    if (refs.length === 0) {
        return '';
    }

    const lines = refs.map(item => `- ${item.name}: ${item.prompt}`);

    return `\n\n<autopic_registered_characters>\nAvailable registered character refs. Use these names exactly in <char ref=\"name\">. Do not copy these base appearance tags into <scene> or into the <char> body.\n${lines.join('\n')}\n</autopic_registered_characters>`;
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
        finalPrompt += buildAvailableCharacterRefsPrompt(charData);

        const charCount = Math.max(charData.length, 1);
        for (let i = 1; i <= charCount; i++) {
            const placeholder = `{autopic_char${i}}`;
            const item = charData[i - 1];
            let replacement = "";

            if (item && item.enabled !== false && item.prompt && item.prompt.trim()) {
                replacement = item.prompt;
            }

            finalPrompt = finalPrompt.split(placeholder).join(replacement);
        }
    } else {
        for (let i = 1; i <= 20; i++) {
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
                const picMatch = message.mes.match(picRegex);
                if (picMatch && picMatch[1]) {
                    if (!message.extra) message.extra = {};
                    message.extra.title = picMatch[1];
                } else {
                    // img 태그의 title은 내부에 따옴표가 포함될 수 있으므로 DOM 파싱 사용
                    const imgTagMatch = message.mes.match(/<img[^>]+>/i);
                    if (imgTagMatch) {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = imgTagMatch[0];
                        const imgEl = tempDiv.querySelector('img');
                        const titleVal = imgEl ? (imgEl.getAttribute('title') || imgEl.getAttribute('alt') || '') : '';
                        if (titleVal) {
                            if (!message.extra) message.extra = {};
                            message.extra.title = titleVal;
                        }
                    }
                }
            }
            addRerollButtonToMessage(mesId);
            addManualGenerateButtonToMessage(mesId);
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
            addManualGenerateButtonToMessage(mesId);
            addMobileToggleToMessage(mesId);
            attachSwipeRerollListeners(mesId);
            setTimeout(() => attachTagControls(mesId), 150);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            renderCharacterLinkUI();
            renderCharacterPrompts();
            initializeAllManualButtons();
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
                // ST 스와이프 렌더링이 끝날 때까지 충분히 기다린 후 버튼 재부착
                setTimeout(() => attachTagControls(mesId), 300);
                setTimeout(() => attachTagControls(mesId), 700);
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

function stripAutopicRuntimeMarkup(text) {
    const temp = document.createElement('div');
    temp.innerHTML = String(text ?? '');
    temp.querySelectorAll('img, script, style').forEach(node => node.remove());
    return decodeHtmlAttribute(temp.textContent || temp.innerText || String(text ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function getManualContextText(mesId) {
    const context = getContext();
    const chat = context.chat || [];
    const targetIndex = Number(mesId);
    const start = Math.max(0, targetIndex - 4);
    const end = Math.min(chat.length - 1, targetIndex + 1);
    const lines = [];

    for (let i = start; i <= end; i++) {
        const message = chat[i];
        if (!message) continue;
        const speaker = message.is_user ? 'User' : (message.name || 'Assistant');
        const marker = i === targetIndex ? ' [TARGET]' : '';
        const text = stripAutopicRuntimeMarkup(message.mes);
        if (text) {
            lines.push(`${speaker}${marker}: ${text}`);
        }
    }

    return lines.join('\n');
}

function buildManualAutopicPrompt(mesId) {
    const targetMessage = getContext().chat?.[mesId];
    const targetText = stripAutopicRuntimeMarkup(targetMessage?.mes);

    return `${getFinalPrompt()}

Manual AutoPic task:
Create exactly one <autopic> structured block for an illustration of the TARGET message.
Base the image on the chat context below, but focus on the TARGET message.
Do not continue the roleplay. Do not explain. Output only the <autopic> block.

<chat_context>
${getManualContextText(mesId)}
</chat_context>

<target_message>
${targetText}
</target_message>`;
}

async function handleManualGenerate(mesId) {
    if (!SlashCommandParser.commands['sd']) {
        toastr.error("Stable Diffusion extension not loaded.");
        return;
    }

    const context = getContext();
    const numericMesId = Number(mesId);
    const message = context.chat?.[numericMesId];
    const manual = getManualParams();

    if (!message || message.is_user) return;
    if (!manual.profileId) {
        toastr.warning('AutoPic 설정에서 수동 생성용 Connection Profile을 선택해 주세요.');
        return;
    }

    try {
        toastr.info('AutoPic 수동 생성 프롬프트 작성 중...');
        const response = await ConnectionManagerRequestService.sendRequest(
            manual.profileId,
            buildManualAutopicPrompt(numericMesId),
            Number(manual.maxTokens) || MANUAL_DEFAULTS.maxTokens,
            { extractData: true, includePreset: true, includeInstruct: true, stream: false },
        );
        const generatedText = String(response?.content || '').trim();
        const prepared = preparePromptForGeneration(generatedText);

        if (!prepared.naiPayload) {
            console.warn('[AutoPic] Manual generation did not return a structured block:', generatedText);
            toastr.error('수동 생성 결과에서 올바른 <autopic> 블록을 찾지 못했습니다.');
            return;
        }

        toastr.info('AutoPic 이미지 생성 중...');
        const resultUrl = await sdCallWithRescale(
            { quiet: 'true' },
            prepared.prompt,
            prepared.naiPayload,
        );

        if (typeof resultUrl !== 'string' || !resultUrl.trim() || resultUrl.startsWith('Error')) {
            toastr.error('수동 이미지 생성에 실패했습니다.');
            return;
        }

        if (!message.extra) message.extra = {};
        if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
        if (!Array.isArray(message.extra.autopic_swipe_payloads)) message.extra.autopic_swipe_payloads = [];

        const storedPayload = buildStoredAutopicPayload(prepared);
        message.extra.autopic_last_payload = storedPayload;

        const currentInsertType = extension_settings[extensionName].insertType;
        if (currentInsertType === INSERT_TYPE.REPLACE) {
            const titleForTag = prepared.editText || prepared.prompt || '';
            const newTag = createAutopicImageTag(resultUrl, titleForTag, 'manual');
            message.mes = replaceFirstAutopicImageOrAppend(message.mes, newTag);
        } else {
            message.extra.image_swipes.push(resultUrl);
            message.extra.autopic_swipe_payloads.push(storedPayload);
            message.extra.image = resultUrl;
            message.extra.title = prepared.editText;
            message.extra.inline_image = true;
        }

        updateMessageBlock(numericMesId, message);
        appendMediaToMessage(message, $(`.mes[mesid="${numericMesId}"]`));
        await context.saveChat();
        await eventSource.emit(event_types.MESSAGE_UPDATED, numericMesId);
        await eventSource.emit(event_types.MESSAGE_RENDERED, numericMesId);

        toastr.success('AutoPic 수동 이미지 생성 완료.');
    } catch (error) {
        console.error('[AutoPic] Manual generation failed:', error);
        toastr.error('AutoPic 수동 생성 중 오류가 발생했습니다.');
    }
}

async function handleReroll(mesId, currentPrompt, targetAutopicId = null) {
    currentPrompt = decodeHtmlAttribute(String(currentPrompt ?? ''));
    targetAutopicId = decodeHtmlAttribute(String(targetAutopicId ?? ''));
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

    const clickedImageTag = getAutopicImageTagById(message.mes, targetAutopicId);
    if (clickedImageTag) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = clickedImageTag;
        const imgEl = tempDiv.querySelector('img');
        const prompt = imgEl ? (imgEl.getAttribute('title') || imgEl.getAttribute('alt') || currentPrompt || '') : currentPrompt;
        const prepared = preparePromptForGeneration(prompt);

        foundItems.push({
            originalTag: clickedImageTag,
            prompt: prepared.editText || prompt,
            _parsedNaiPayload: prepared.naiPayload,
            _parsedPrompt: prepared.prompt,
            type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe',
        });
    }

    // 0. 본문 내 <autopic> structured 블록 직접 파싱 (최우선)
    if (foundItems.length === 0) {
        getStructuredRequestsFromText(stripAutopicImagesForStructuredScan(message.mes)).forEach(parsed => {
            if (parsed.prompt || parsed.naiPayload?.characterPrompts?.length > 0) {
                foundItems.push({
                    originalTag: parsed.fullTag,
                    prompt: parsed.editText,
                    _parsedNaiPayload: parsed.naiPayload,
                    _parsedPrompt: parsed.prompt,
                    type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe',
                });
            }
        });
    }

    if (foundItems.length === 0 && currentPrompt) {
        getStructuredRequestsFromText(currentPrompt).forEach(parsed => {
            if (parsed.prompt || parsed.naiPayload?.characterPrompts?.length > 0) {
                foundItems.push({
                    originalTag: null,
                    prompt: parsed.editText,
                    _parsedNaiPayload: parsed.naiPayload,
                    _parsedPrompt: parsed.prompt,
                    type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe',
                });
            }
        });
    }

    // 1. 본문 내 <pic> 태그 검색 (레거시)
    if (foundItems.length === 0) {
        let picMatches = [...message.mes.matchAll(picRegex)];
        picMatches.forEach(m => {
            foundItems.push({ 
                originalTag: m[0], 
                prompt: m[1], 
                _parsedNaiPayload: null,
                _parsedPrompt: m[1],
                type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe' 
            });
        });
    }

    // 2. 본문 내 <img> 태그 검색 (이미 치환된 경우)
    let imgMatches = foundItems.length === 0 ? [...message.mes.matchAll(imgRegex)] : [];
    imgMatches.forEach(m => {
        const fullTag = m[0];
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = fullTag;
        const imgEl = tempDiv.querySelector('img');
        const prompt = imgEl ? (imgEl.getAttribute('title') || imgEl.getAttribute('alt') || '') : '';
        
        if (prompt) {
            if (!foundItems.some(item => item.originalTag === fullTag)) {
                // img[title]에 저장된 editText로 재파싱 시도
                const reparseResult = (() => {
                    const structReq = getStructuredRequestsFromText(prompt);
                    if (structReq.length > 0) return { naiPayload: structReq[0].naiPayload, prompt: structReq[0].prompt };
                    return { naiPayload: null, prompt };
                })();
                foundItems.push({ 
                    originalTag: fullTag, 
                    prompt: prompt,
                    _parsedNaiPayload: reparseResult.naiPayload,
                    _parsedPrompt: reparseResult.prompt,
                    type: insertType === INSERT_TYPE.REPLACE ? 'tag' : 'swipe' 
                });
            }
        }
    });

    // 3. 메시지 extra 데이터 (이미 생성된 갤러리 이미지들)
    if (message.extra && message.extra.image_swipes && message.extra.image_swipes.length > 0) {
        const structuredSource = foundItems.find(i => i._parsedNaiPayload);
        message.extra.image_swipes.forEach((src, sIdx) => {
            const savedPayload = Array.isArray(message.extra.autopic_swipe_payloads)
                ? message.extra.autopic_swipe_payloads[sIdx]
                : null;

            let resolvedNaiPayload = structuredSource?._parsedNaiPayload || null;
            let resolvedPrompt = structuredSource?._parsedPrompt || message.extra.title || currentPrompt || "";
            let resolvedEditText = structuredSource?.prompt || message.extra.title || currentPrompt || "";

            if (!resolvedNaiPayload && savedPayload?.rawAutopicTag) {
                // rawAutopicTag를 현재 캐릭터 등록 정보로 새로 파싱 (태그 변경 반영)
                const reparsed = parseStructuredPicBlock(savedPayload.rawAutopicTag, savedPayload.rawAutopicTag.replace(/^<autopic[^>]*>|<\/autopic>$/gi, ''));
                resolvedNaiPayload = reparsed.naiPayload;
                resolvedPrompt = reparsed.prompt;
                resolvedEditText = savedPayload.editText || savedPayload.rawAutopicTag;
            }

            if (!resolvedNaiPayload && savedPayload?.editText) {
                const reparsed = preparePromptForGeneration(savedPayload.editText);
                if (reparsed.naiPayload) {
                    resolvedNaiPayload = reparsed.naiPayload;
                    resolvedPrompt = reparsed.prompt;
                    resolvedEditText = reparsed.editText;
                }
            }

            if (!resolvedNaiPayload && savedPayload?.naiPayload) {
                resolvedNaiPayload = savedPayload.naiPayload;
                resolvedPrompt = savedPayload.naiPayload.prompt || resolvedPrompt;
                resolvedEditText = savedPayload.editText || resolvedEditText;
            }

            foundItems.push({
                swipeIdx: sIdx,
                prompt: resolvedEditText,
                _parsedNaiPayload: resolvedNaiPayload,
                _parsedPrompt: resolvedPrompt,
                _savedPayload: savedPayload,
                type: 'swipe',
            });
        });
    }


    if (foundItems.length === 0) {
        foundItems.push({ 
            originalTag: null, 
            prompt: currentPrompt || "",
            _parsedNaiPayload: null,
            _parsedPrompt: currentPrompt || "",
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
		const reparsedFinalPrompt = resolveRerollGenerationPrompt(finalPrompt, targetItem, message, currentPrompt);
		// message.mes에서 직접 파싱한 naiPayload가 있으면 재파싱 없이 사용
		let generationPrompt = reparsedFinalPrompt.naiPayload
			? reparsedFinalPrompt
			: targetItem._parsedNaiPayload
			? {
				prompt: targetItem._parsedPrompt || finalPrompt,
				naiPayload: targetItem._parsedNaiPayload,
				editText: finalPrompt,
			}
			: reparsedFinalPrompt;

		if (!generationPrompt.naiPayload && /<autopic\b/i.test(decodeHtmlAttribute(generationPrompt.prompt))) {
			const repairedPrompt = preparePromptForGeneration(generationPrompt.prompt);
			if (repairedPrompt.naiPayload) {
				generationPrompt = repairedPrompt;
			} else {
				console.warn('[AutoPic] Reroll found an <autopic> block but could not parse it:', generationPrompt.prompt);
			}
		}

		if (generationPrompt.prompt || generationPrompt.naiPayload?.characterPrompts?.length) {

            try {
                toastr.info("이미지 생성 중...");
                const resultUrl = await sdCallWithRescale(
                    { quiet: 'true' },
                    generationPrompt.prompt,
                    generationPrompt.naiPayload,
                );
                
                if (typeof resultUrl === 'string' && !resultUrl.startsWith('Error')) {
                    const currentInsertType = extension_settings[extensionName].insertType;


                    if (currentInsertType === INSERT_TYPE.REPLACE) {
                        // 다음 재생성에서도 구조 전체를 복원할 수 있도록
                        // editText(<pic>...</pic> 원본)를 title에 보존한다
                        const titleForTag = generationPrompt.editText || generationPrompt.prompt || '';
                        const newTag = createAutopicImageTag(resultUrl, titleForTag, 'tag');
                        message.mes = targetItem.originalTag
                            ? replaceOrAppendAutopicTag(message.mes, targetItem.originalTag, newTag)
                            : replaceFirstAutopicImageOrAppend(message.mes, newTag);
                    } 

                    else {
                        if (!message.extra) message.extra = {};
                        if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
                        
                        if (targetItem.swipeIdx !== undefined) {
                            message.extra.image_swipes[targetItem.swipeIdx] = resultUrl;
                        } else {
                            message.extra.image_swipes.push(resultUrl);
                        }
                        if (!Array.isArray(message.extra.autopic_swipe_payloads)) message.extra.autopic_swipe_payloads = [];
                        const storedPayload = buildStoredAutopicPayload(generationPrompt);
                        if (targetItem.swipeIdx !== undefined) {
                            message.extra.autopic_swipe_payloads[targetItem.swipeIdx] = storedPayload;
                        } else {
                            message.extra.autopic_swipe_payloads.push(storedPayload);
                        }
                        message.extra.autopic_last_payload = storedPayload;
                        message.extra.image = resultUrl;
                        message.extra.title = generationPrompt.editText;
                        message.extra.inline_image = true;
                    }

                    updateMessageBlock(mesId, message);
                    if (currentInsertType !== INSERT_TYPE.REPLACE) {
                        appendMediaToMessage(message, $(`.mes[mesid="${mesId}"]`));
                    }
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
async function sdCallWithRescale(args, prompt, naiPayload = null) {
    const previousPendingNaiPayload = pendingNaiPayload;
    pendingNaiPayload = naiPayload;

    try {
        return await SlashCommandParser.commands['sd'].callback(args, prompt);
    } finally {
        pendingNaiPayload = previousPendingNaiPayload;
    }
}

function preparePromptForGeneration(promptText) {
    const text = decodeHtmlAttribute(String(promptText ?? '')).trim();
    const structuredRequests = getStructuredRequestsFromText(text);

    if (structuredRequests.length > 0) {
        const request = structuredRequests[0];
        return {
            prompt: request.prompt,
            naiPayload: request.naiPayload,
            editText: request.editText,
        };
    }

    return {
        prompt: text,
        naiPayload: null,
        editText: text,
    };
}

function resolveRerollGenerationPrompt(finalPrompt, targetItem, message, currentPrompt) {
    const candidates = [
        finalPrompt,
        targetItem?.prompt,
        targetItem?._savedPayload?.rawAutopicTag,
        targetItem?._savedPayload?.editText,
        message?.extra?.autopic_last_payload?.rawAutopicTag,
        message?.extra?.autopic_last_payload?.editText,
        message?.extra?.title,
        currentPrompt,
        message?.mes,
    ];

    for (const candidate of candidates) {
        const prepared = preparePromptForGeneration(candidate);
        if (prepared.naiPayload) {
            return prepared;
        }
    }

    if (targetItem?._parsedNaiPayload) {
        return {
            prompt: targetItem._parsedPrompt || finalPrompt,
            naiPayload: targetItem._parsedNaiPayload,
            editText: finalPrompt,
        };
    }

    if (targetItem?._savedPayload?.naiPayload) {
        return {
            prompt: targetItem._savedPayload.naiPayload.prompt || finalPrompt,
            naiPayload: targetItem._savedPayload.naiPayload,
            editText: targetItem._savedPayload.editText || finalPrompt,
        };
    }

    return preparePromptForGeneration(finalPrompt);
}

function buildStoredAutopicPayload(generationPrompt) {
    const editText = generationPrompt?.editText || generationPrompt?.prompt || '';
    const structuredRequests = getStructuredRequestsFromText(editText);
    const rawAutopicTag = structuredRequests.length > 0 ? structuredRequests[0].fullTag : null;

    return {
        editText,
        rawAutopicTag,
        naiPayload: generationPrompt?.naiPayload || structuredRequests[0]?.naiPayload || null,
    };
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

    const picRequests = extractPicRequests(message.mes, regex);
    if (picRequests.length === 0) return;

    setTimeout(async () => {
        try {
            const currentIdx = context.chat.indexOf(message);
            if (currentIdx === -1) return; 

            const insertType = extension_settings[extensionName].insertType;
            const total = picRequests.length;
            
            toastr.info(`${total}개의 이미지 생성을 시작합니다...`, "AutoPic", { "progressBar": true });
            
            if (!message.extra) message.extra = {};
            if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
            
            const messageElement = $(`.mes[mesid="${currentIdx}"]`);
            let hasChanged = false;
            let lastImageResult = null;
            let lastPromptUsed = "";
            let updatedMes = message.mes;

            for (let i = 0; i < picRequests.length; i++) {
                toastr.info(`이미지 생성 중... (${i + 1} / ${total})`, "AutoPic", { "timeOut": 2000 });

                const request = picRequests[i];
                const fullTag = request.fullTag;
                const prompt = request.prompt || '';
                const editText = request.editText || prompt;
                
                if (!prompt.trim() && !request.naiPayload?.characterPrompts?.length) continue;

                const result = await sdCallWithRescale({ quiet: 'true' }, prompt.trim(), request.naiPayload);
                
                if (typeof result === 'string' && result.trim().length > 0 && !result.startsWith('Error')) {
                    hasChanged = true;
                    lastImageResult = result;
                    lastPromptUsed = editText.trim();
                    
				if (insertType === INSERT_TYPE.INLINE) {
					message.extra.image_swipes.push(result);
					if (!Array.isArray(message.extra.autopic_swipe_payloads)) message.extra.autopic_swipe_payloads = [];
					message.extra.autopic_swipe_payloads.push(buildStoredAutopicPayload({
						editText,
						prompt,
						naiPayload: request.naiPayload,
					}));
					updatedMes = replaceOrAppendAutopicTag(updatedMes, fullTag, '').trim();
				}
				else if (insertType === INSERT_TYPE.REPLACE) {
					const newTag = createAutopicImageTag(result, editText, `tag-${i}`);
					updatedMes = replaceOrAppendAutopicTag(updatedMes, fullTag, newTag);
				}
                } else {
                    toastr.error(`${i + 1}번째 이미지 생성에 실패했습니다.`);
                }
            }

            if (hasChanged) {
				message.extra.title = lastPromptUsed;
				if (Array.isArray(message.extra.autopic_swipe_payloads) && message.extra.autopic_swipe_payloads.length > 0) {
					const last = message.extra.autopic_swipe_payloads[message.extra.autopic_swipe_payloads.length - 1];
					message.extra.autopic_last_payload = last;
				}

                if (insertType === INSERT_TYPE.INLINE) {
                    message.mes = updatedMes;
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
            const autopicId = $img.attr('data-autopic-id') || "";

            $img.wrap('<div class="autopic-tag-img-wrapper"></div>');
            
            const $controls = $('<div class="autopic-tag-controls"></div>');
            const $btn = $('<div class="autopic-control-btn reroll-trigger fa-solid fa-rotate interactable" title="Generate Another Image" role="button" tabindex="0"></div>');
            $btn.attr('data-mesid', mesId);
            $btn.attr('data-prompt', title);
            $btn.attr('data-autopic-id', autopicId);
            $controls.append($btn);
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
    initializeAllManualButtons();
});

eventSource.on(event_types.CHARACTER_SELECTED, () => {
    renderCharacterLinkUI();
    renderCharacterPrompts();
    initializeAllTagControls();
    initializeAllManualButtons();
});

eventSource.on(event_types.CHAT_CHANGED, () => {
    renderCharacterLinkUI();
    renderCharacterPrompts();
    initializeAllTagControls();
    initializeAllManualButtons();
});

$(document).off('click', '.reroll-trigger').on('click', '.reroll-trigger', function(e) {
    e.preventDefault(); 
    e.stopPropagation();
    const mesId = $(this).data('mesid');
    const prompt = $(this).data('prompt');
    const autopicId = $(this).attr('data-autopic-id');
    handleReroll(mesId, prompt, autopicId);
});
