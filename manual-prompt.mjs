/** Current connection uses ST's own quiet pipeline; explicit profiles retain their prior route. */
export async function requestManualPrompt({ profileId, prompt, maxTokens, generateQuietPrompt, profileService }) {
    if (!profileId) {
        return String(await generateQuietPrompt({quietPrompt: prompt, responseLength: maxTokens, quietToLoud: false}) || '').trim();
    }
    const response = await profileService.sendRequest(profileId, prompt, maxTokens,
        {extractData:true, includePreset:true, includeInstruct:true, stream:false});
    return String(response?.content || '').trim();
}
