// Instructions only: never truncate user prompts or weighted tag expressions in code.
export const OUTFIT_PROMPT = `ATTIRE AND ACCESSORIES:
- <apchar_outfit> is a clothing reference, not appearance. Read it as attire and worn accessories only: shirt, coat, skirt, shoes, hat, necklace, glasses, etc.
- Ignore physical traits accidentally written in outfit references: real horns, animal ears, tails, wings, hair, eye color, skin, anatomy and species are NOT attire/accessories. Never move them into clothing tags. A worn horned headband is an accessory; actual horns are anatomy.
- Adapt only clothing/accessories to the current scene. Do not copy the outfit reference wholesale.
- Put each character's clothing and worn accessories as short English tags in that character's <apchar> block. Keep permanent appearance separate.`;
export function buildOutfitPrompt(template = OUTFIT_PROMPT) {
    const text = String(template ?? '').trim();
    return text ? `\n\n<autopic_outfit_rules>\nFor clothing selection, adaptation and output, the following user-editable rules take precedence over other clothing guidance in the template.\n${text}\n</autopic_outfit_rules>` : '';
}
const rules = `
TAG FORMAT:
- Use familiar English NovelAI/Danbooru-style tags, comma-separated. No prose, sentences, dialogue, metaphors, explanations, or invented descriptive phrases.
- Each <scene>, each <apchar>, and <uc> contains at most 4 tags. One compact line per block. Select the most important visible facts; omit the rest. Do not evade the limit with semicolons or long phrases.
- Good: sitting, looking at another, hand on chest, open shirt.
- Bad: she rests her head against his chest while listening to his heartbeat.
- <scene>: counts, location, lighting, composition only. Keep individual actions and appearance in that character's <apchar>.
REFS AND APPEARANCE:
- The exact names in <autopic_registered_characters> are the only valid ref names. Never guess names or use {{char}}/{{user}} as ref unless literally listed.
- For a registered character, use <apchar ref="exact listed name"> with temporary pose/expression/action and worn clothing/accessory tags only. AutoPic adds permanent appearance; do not repeat hair, eyes, skin, body shape, horns, ears, tails, wings, species or age.
- For an unregistered character, use <apchar> without ref. Use up to 4 essential identity/appearance/pose tags; do not borrow another character's ref.
ATTIRE AND ACCESSORIES:
- <apchar_outfit> is a clothing reference, not appearance. Read it as attire and worn accessories only: shirt, coat, skirt, shoes, hat, necklace, glasses, etc.
- Ignore physical traits accidentally written in outfit references: real horns, animal ears, tails, wings, hair, eye color, skin, anatomy and species are NOT attire/accessories. Never move them into clothing tags. A worn horned headband is an accessory; actual horns are anatomy.
- Adapt only clothing/accessories to the scene. Do not copy the outfit reference wholesale.
- Do not add Character 1 labels, markdown fences, or legacy <pic prompt="..."> tags.
`;
const example = `<autopic>
<scene>1girl, 1boy, rowboat, moonlight</scene>
<apchar ref="Alice">leaning forward, looking at another, hand on chest, white shirt</apchar>
<apchar ref="Bob">sitting, looking down, open shirt, necklace</apchar>
<uc>blurry, watermark, text</uc>
</autopic>`;
const manualInstructions = `You create illustrations for a selected chat message. Do not continue the roleplay or explain your answer.
${rules}
Follow the requested illustration count. Each illustration must show a different moment, action, or composition, never duplicate the same scene for alternate samples.
If a scene request is provided, prioritize it over automatic scene selection. Otherwise choose suitable scenes from TARGET.
Use only the supplied context; do not assume later conversation. Registered appearance is added by AutoPic.
Output only the requested number of complete <autopic> blocks, with <scene>, <apchar> and optional <uc> inside each.`;
const manualExample = `<autopic>
<scene>1girl, cafe, sunset</scene>
<apchar ref="Alice">sitting, smiling, white shirt</apchar>
</autopic>`;
export const MANUAL_GENERATION_PROMPT = `${manualInstructions}
Example of the block contents:
${manualExample}`;
export const PREVIOUS_FREE_PLACEMENT_PROMPT = 'Match each illustration to the TARGET paragraph where its depicted moment happens. Insert it immediately after that paragraph, before the story moves on. For multiple illustrations, choose different matching paragraphs when possible and keep them in story order. Use the final paragraph only for a scene that belongs at the end.';
export const MANUAL_PLACEMENT_PROMPTS = Object.freeze({
    free: `For each illustration, choose the TARGET paragraph that best supports its visual tags. Use that paragraph's exact ID in the opening tag, e.g. <autopic after="p2"> if p2 is listed.

- Match by visible action, pose, interaction, or setting. If several paragraphs fit equally well, choose the earliest one that shows the full scene.
- For multiple illustrations, prefer different matching paragraphs. Use the same paragraph only if it is the best match for each scene.
- Use the final paragraph only when it best matches the scene or is the only available paragraph.
- Return only the requested <autopic> blocks with image tags. Do not rewrite the story, add narration, or explain your choices.`,
    bottom: `Place all illustrations together at the end of the target message. Order them by when their scenes happen in the story.`,
});
// Migrate only the exact previous built-in text; preserve user-edited manual templates.
export const LEGACY_MANUAL_GENERATION_PROMPT = `${manualInstructions}
For free placement, add after="pN" to each <autopic> opening tag, using an exact paragraph ID from TARGET. This means insert after that paragraph. Never rewrite TARGET.
For bottom placement, use after="bottom". Example:
${manualExample.replace('<autopic>', '<autopic after="p1">')}`;
export const PREVIOUS_MANUAL_GENERATION_PROMPT = LEGACY_MANUAL_GENERATION_PROMPT.replace(
    'Output only the requested number',
    'An outfit override replaces that character\'s default clothing reference for this request only. Adapt it to the request; never treat anatomy as clothing.\nOutput only the requested number');
export const STRUCTURED_BLOCKS_PROMPT = `<image_generation>
When an image is appropriate, append exactly one <autopic> block after the story. Keep the story outside this block.
${rules}
FORMAT EXAMPLE (Alice and Bob must actually be registered; substitute exact valid names, otherwise use unregistered <apchar>):
${example}
Use one <scene>, one <apchar> per visible character, and an optional <uc>. Omit UC when unnecessary.
</image_generation>`;
export const STRICT_TAG_BLOCKS_PROMPT = `<image_generation>
When an image is appropriate, append exactly one <autopic> block after the story. Treat its contents as an image tag list, never narrative.
${rules}
Before output, silently check: each block has at most 4 comma-separated tags; refs exactly match the allow-list; registered characters have no permanent appearance tags; outfit references contribute only attire/accessories. Rewrite any sentence into short tags. Output no checklist.
VALID FORMAT EXAMPLE (only if Alice and Bob are registered):
${example}
</image_generation>`;
