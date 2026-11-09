export function getManualPresetEntries(context, presetName) {
    const source = presetName
        ? context.getPresetManager?.('openai')?.getCompletionPresetByName?.(presetName)
        : context.chatCompletionSettings;
    const prompts = Array.isArray(source?.prompts) ? source.prompts : [];
    return prompts.filter(prompt => !prompt?.marker && typeof prompt?.identifier === 'string'
        && prompt.identifier && typeof prompt.content === 'string' && prompt.content.trim());
}

export function composeManualPrompt(template, task, selection, context, roles) {
    if (!selection?.enabled) return `${template}\n\n${task}`;

    const messages = [];
    function append(content, chosenRole, defaultRole) {
        const role = ['system', 'user', 'assistant'].includes(chosenRole) ? chosenRole : defaultRole;
        const last = messages.at(-1);
        if (last?.role === role) last.content += `\n\n${content}`;
        else messages.push({ role, content });
    }

    append(template, roles?.instruction, 'system');
    if (selection.itemId) {
        const selected = getManualPresetEntries(context, selection.presetName).find(item => item.identifier === selection.itemId);
        if (selected) append(selected.content.trim(), roles?.preset ?? selection.role, 'system');
    }
    append(task, roles?.task, 'user');
    return messages;
}

/** Raw generation keeps the selected context explicit instead of adding the whole chat. */
export async function requestManualPrompt({ profileId, prompt, maxTokens, generateRaw, profileService }) {
    if (!profileId) {
        return String(await generateRaw({prompt, responseLength: maxTokens, quietToLoud: true, trimNames: false}) || '').trim();
    }
    const response = await profileService.sendRequest(profileId, prompt, maxTokens,
        {extractData:true, includePreset:true, includeInstruct:true, stream:false});
    return String(response?.content || '').trim();
}
