// Instructions only: never truncate user prompts or weighted tag expressions in code.
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
