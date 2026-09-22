// Local-only image metadata reader. No image data is uploaded.
// Stealth layout: NovelAI/novelai-image-metadata (column-major, MSB-first bits).
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_PIXELS = 24 * 1024 * 1024;
const utf8 = new TextDecoder();
const ascii = bytes => Array.from(bytes, b => String.fromCharCode(b)).join('');
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const clean = text => text.replace(/^\uFEFF/, '').replace(/\0+$/, '').trim();
const json = text => { try { const obj = JSON.parse(clean(text)); return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null; } catch { return null; } };

async function decompress(bytes, format, limit = MAX_TEXT) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error('압축된 이미지 정보가 허용 크기를 초과합니다.');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
}

function exifText(bytes, unicode = false, little = true) {
    let encoding = unicode ? 'utf-16le' : 'utf-8';
    const marker = ascii(bytes.subarray(0, 8));
    if (marker.startsWith('UNICODE')) {
        bytes = bytes.subarray(8);
        encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0 && bytes[1] !== 0 ? 'utf-16be' : bytes[1] === 0 && bytes[0] !== 0 ? 'utf-16le' : bytes[0] === 123 && bytes[1] === 34 ? 'utf-8' : little ? 'utf-16le' : 'utf-16be';
    } else if (marker.startsWith('ASCII') || marker.startsWith('JIS')) {
        encoding = marker.startsWith('JIS') ? 'shift-jis' : 'utf-8'; bytes = bytes.subarray(8);
    } else if (bytes.subarray(0, 8).every(b => b === 0)) bytes = bytes.subarray(8);
    return clean(new TextDecoder(encoding).decode(bytes));
}

export function readExif(bytes) {
    if (ascii(bytes.subarray(0, 6)) === 'Exif\0\0') bytes = bytes.subarray(6);
    const values = [];
    if (bytes.length < 8) return values;
    const endian = ascii(bytes.subarray(0, 2));
    if (endian !== 'II' && endian !== 'MM') return values;
    const little = endian === 'II', d = view(bytes), visited = new Set(); let textSize = 0;
    if (d.getUint16(2, little) !== 42) return values;
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    function readIfd(offset, depth = 0) {
        if (!offset || depth > 6 || visited.has(offset) || offset + 2 > bytes.length) return;
        visited.add(offset);
        const count = d.getUint16(offset, little);
        if (count > 512 || offset + 2 + count * 12 + 4 > bytes.length) return;
        for (let i = 0; i < count; i++) {
            const p = offset + 2 + i * 12, tag = d.getUint16(p, little), type = d.getUint16(p + 2, little);
            const amount = d.getUint32(p + 4, little), size = amount * (sizes[type] || 0);
            if (!size || size > MAX_TEXT) continue;
            const start = size <= 4 ? p + 8 : d.getUint32(p + 8, little);
            if (start + size > bytes.length) continue;
            if ([0x8769, 0x8825, 0xa005].includes(tag) && type === 4) readIfd(d.getUint32(start, little), depth + 1);
            if ([0x010e, 0x0131, 0x9286, 0x9c9b, 0x9c9c, 0x02bc].includes(tag)) {
                textSize += size;
                if (textSize > MAX_TEXT || values.length >= 64) return;
                const names = { 0x010e: 'Description', 0x0131: 'Software', 0x9286: 'Comment', 0x9c9b: 'Title', 0x9c9c: 'Comment', 0x02bc: 'XMP' };
                values.push({ key: names[tag], text: exifText(bytes.subarray(start, start + size), tag === 0x9c9b || tag === 0x9c9c, little) });
            }
        }
        readIfd(d.getUint32(offset + 2 + count * 12, little), depth + 1);
    }
    readIfd(d.getUint32(4, little));
    return values;
}

function xmlUnescape(text) {
    return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
        const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        if (named[entity]) return named[entity];
        const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}
function readXmp(text) {
    const values = [];
    // Read metadata values as inert text, never insert or execute XML/HTML.
    for (const match of text.matchAll(/<(?:[\w-]+:)?(Description|UserComment|Comment|parameters|li)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?\1>/gi)) {
        const nested = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(match[2]);
        values.push({ key: match[1], text: clean(xmlUnescape(nested ? nested[1] : match[2])) });
    }
    for (const m of text.matchAll(/(?:[\w-]+:)?(UserComment|Comment|Description|parameters)\s*=\s*(["'])([\s\S]*?)\2/gi)) values.push({ key: m[1], text: xmlUnescape(m[3]) });
    return values;
}

async function pngChunks(bytes) {
    const chunks = [], entries = [], warnings = []; const d = view(bytes);
    let metadataBytes = 0;
    for (let p = 8; p + 12 <= bytes.length && chunks.length < 4096;) {
        const length = d.getUint32(p), type = ascii(bytes.subarray(p + 4, p + 8));
        if (length > bytes.length - p - 12) { warnings.push('일부 PNG 청크가 손상되어 건너뛰었습니다.'); break; }
        const data = bytes.subarray(p + 8, p + 8 + length); chunks.push({ type, data }); p += length + 12;
        if (type === 'IEND') break;
        try {
            if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
                if (length > MAX_TEXT) throw new Error('텍스트 크기 제한');
                const sep = data.indexOf(0); if (sep < 1 || sep > 79) continue;
                const key = ascii(data.subarray(0, sep)); let text;
                if (type === 'tEXt') text = utf8.decode(data.subarray(sep + 1));
                if (type === 'zTXt') {
                    if (data[sep + 1] !== 0) continue;
                    text = utf8.decode(await decompress(data.subarray(sep + 2), 'deflate'));
                }
                if (type === 'iTXt') {
                    const flag = data[sep + 1], method = data[sep + 2];
                    const langEnd = data.indexOf(0, sep + 3), translatedEnd = data.indexOf(0, langEnd + 1);
                    if (langEnd < 0 || translatedEnd < 0 || flag > 1 || method !== 0) continue;
                    const content = data.subarray(translatedEnd + 1);
                    text = utf8.decode(flag ? await decompress(content, 'deflate') : content);
                }
                metadataBytes += text.length;
                if (metadataBytes > MAX_TEXT) throw new Error('텍스트 크기 제한');
                entries.push({ key, text, source: `PNG ${type}` });
            } else if (type === 'eXIf') entries.push(...readExif(data).map(v => ({ ...v, source: 'PNG EXIF' })));
        } catch { warnings.push(`${type} 메타데이터를 읽지 못했습니다.`); }
        if (metadataBytes > MAX_TEXT) break;
    }
    return { chunks, entries, warnings };
}

function containerEntries(bytes, type) {
    const entries = [], d = view(bytes);
    const append = (data, label) => {
        const values = label.includes('XMP') ? [{ key: 'XMP', text: utf8.decode(data) }] : label.includes('EXIF') ? readExif(data) : [{ key: 'Comment', text: utf8.decode(data) }];
        entries.push(...values.map(v => ({ ...v, source: label })));
    };
    if (type === 'webp') {
        const end = Math.min(bytes.length, d.getUint32(4, true) + 8);
        for (let p = 12; p + 8 <= end;) {
            const name = ascii(bytes.subarray(p, p + 4)), size = d.getUint32(p + 4, true);
            if (size > end - p - 8) break;
            if ((name === 'EXIF' || name === 'XMP ') && size <= MAX_TEXT) append(bytes.subarray(p + 8, p + 8 + size), `WebP ${name.trim()}`);
            p += 8 + size + (size % 2);
        }
    } else {
        for (let p = 2; p + 4 <= bytes.length;) {
            if (bytes[p++] !== 0xff) break;
            while (bytes[p] === 0xff) p++;
            const marker = bytes[p++];
            if (marker === 0xda || marker === 0xd9) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            const size = d.getUint16(p); if (size < 2 || p + size > bytes.length) break;
            const data = bytes.subarray(p + 2, p + size); p += size;
            if (marker === 0xfe) append(data, 'JPEG Comment');
            if (marker === 0xe1) {
                if (ascii(data.subarray(0, 6)) === 'Exif\0\0') append(data, 'JPEG EXIF');
                else if (utf8.decode(data.subarray(0, 40)).includes('http://ns.adobe.com/xap/1.0/')) append(data.subarray(data.indexOf(0) + 1), 'JPEG XMP');
            }
        }
    }
    return entries;
}

// Decode PNG bytes directly: browser canvas color conversion/premultiplication can corrupt RGB LSBs.
async function decodePng(chunks) {
    const header = chunks.find(c => c.type === 'IHDR')?.data;
    if (!header || header.length !== 13) return null;
    const d = view(header), width = d.getUint32(0), height = d.getUint32(4), depth = header[8], type = header[9];
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('숨김 정보 검사는 최대 24메가픽셀까지 지원합니다.');
    if (header[12] !== 0 || ![8, 16].includes(depth)) return null;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]; if (!channels) return null;
    const bpp = channels * (depth / 8), stride = width * bpp;
    const idat = chunks.filter(c => c.type === 'IDAT'); const compressed = new Uint8Array(idat.reduce((sum, c) => sum + c.data.length, 0));
    let at = 0; for (const c of idat) { compressed.set(c.data, at); at += c.data.length; }
    const raw = await decompress(compressed, 'deflate', (stride + 1) * height);
    if (raw.length !== (stride + 1) * height) throw new Error('PNG 픽셀 데이터가 불완전합니다.');
    const pixels = new Uint8Array(width * height * 4), palette = chunks.find(c => c.type === 'PLTE')?.data, trns = chunks.find(c => c.type === 'tRNS')?.data;
    let previous = new Uint8Array(stride), row = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const start = y * (stride + 1), filter = raw[start]; if (filter > 4) throw new Error('잘못된 PNG 필터입니다.');
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? row[x - bpp] : 0, b = previous[x], c = x >= bpp ? previous[x - bpp] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            row[x] = raw[start + x + 1] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? pa <= pb && pa <= pc ? a : pb <= pc ? b : c : 0);
        }
        for (let x = 0; x < width; x++) {
            const from = x * bpp, to = (y * width + x) * 4, step = depth / 8;
            if (type === 3) { const i = row[from]; pixels[to] = palette?.[i * 3] ?? 0; pixels[to + 1] = palette?.[i * 3 + 1] ?? 0; pixels[to + 2] = palette?.[i * 3 + 2] ?? 0; pixels[to + 3] = trns?.[i] ?? 255; }
            else { pixels[to] = row[from]; pixels[to + 1] = type === 0 || type === 4 ? row[from] : row[from + step]; pixels[to + 2] = type === 0 || type === 4 ? row[from] : row[from + 2 * step]; pixels[to + 3] = type === 4 ? row[from + step] : type === 6 ? row[from + 3 * step] : 255; }
        }
        [previous, row] = [row, previous];
    }
    return { width, height, data: pixels };
}

export async function readStealth({ width, height, data }) {
    if (!width || !height || width * height > MAX_PIXELS || data.length < width * height * 4) return null;
    for (const channel of ['alpha', 'rgb']) {
        let bit = 0; const channels = channel === 'alpha' ? 1 : 3, capacity = width * height * channels;
        const readByte = () => {
            let value = 0;
            for (let i = 0; i < 8; i++, bit++) {
                const pixel = Math.floor(bit / channels), x = Math.floor(pixel / height), y = pixel % height;
                value = value * 2 + (data[(y * width + x) * 4 + (channel === 'alpha' ? 3 : bit % 3)] & 1);
            }
            return value;
        };
        if (capacity < 152) continue;
        const signature = ascii(Uint8Array.from({ length: 15 }, readByte));
        if (!['stealth_pnginfo', 'stealth_pngcomp', 'stealth_rgbinfo', 'stealth_rgbcomp'].includes(signature)) continue;
        if (signature.includes('png') !== (channel === 'alpha')) continue;
        let length = 0; for (let i = 0; i < 4; i++) length = length * 256 + readByte();
        if (length % 8 || length > capacity - bit || length / 8 > MAX_TEXT) throw new Error('숨김 메타데이터 길이가 올바르지 않습니다.');
        const bytes = Uint8Array.from({ length: length / 8 }, readByte);
        return { key: 'Comment', text: utf8.decode(signature.endsWith('comp') ? await decompress(bytes, 'gzip') : bytes), source: `Stealth ${channel}` };
    }
    return null;
}

async function browserPixels(bytes, type) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${type}` }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
        if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('숨김 정보 검사는 최대 24메가픽셀까지 지원합니다.');
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally { bitmap.close(); }
}

function generationObject(value, depth = 0) {
    if (depth > 5 || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.v4_prompt || ((typeof value.prompt === 'string' || typeof value.uc === 'string') && ['seed', 'steps', 'scale', 'sampler'].some(k => k in value))) return value;
    for (const key of ['Comment', 'comment', 'parameters', 'metadata', 'generation_data', 'Description', 'description']) {
        const child = typeof value[key] === 'string' ? json(value[key]) : value[key];
        const found = generationObject(child, depth + 1);
        if (found) return { ...found, ...(typeof value.model === 'string' ? { model: value.model } : {}), _source: value.Source || value.source || found._source };
    }
    return null;
}

export async function extractImageMetadata(buffer, { decodePixels = browserPixels } = {}) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('40MB 이하의 이미지를 선택해 주세요.');
    const type = bytes[0] === 137 && ascii(bytes.subarray(1, 4)) === 'PNG' ? 'png' : ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WEBP' ? 'webp' : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg' : null;
    if (!type) throw new Error('PNG, WebP 또는 JPEG 원본 이미지를 선택해 주세요.');
    const parsed = type === 'png' ? await pngChunks(bytes) : { entries: containerEntries(bytes, type), warnings: [] };
    let stealth;
    try {
        const pixels = type === 'png' ? await decodePng(parsed.chunks) || await decodePixels(bytes, type) : await decodePixels(bytes, type);
        if (pixels) stealth = await readStealth(pixels);
    } catch (e) { parsed.warnings.push(`숨김 정보: ${e.message}`); }
    const entries = [...stealth ? [stealth] : [], ...parsed.entries.flatMap(e => e.key === 'XMP' || e.key.includes('XML') ? readXmp(e.text).map(x => ({ ...x, source: e.source })) : [e])];
    const candidates = entries.map(e => ({ data: generationObject(json(e.text)), source: e.source })).filter(e => e.data);
    if (!candidates.length) throw new Error('NovelAI 생성 설정을 찾지 못했습니다. 원본 파일을 사용해 주세요. 메타데이터가 제거되거나 손실 압축된 정보는 복원할 수 없습니다.');
    const selected = candidates[0];
    const source = parsed.entries.find(e => e.key === 'Source')?.text;
    if (!selected.data._source && source) selected.data._source = source;
    if (candidates.some(c => c.data.seed !== undefined && selected.data.seed !== undefined && c.data.seed !== selected.data.seed)) parsed.warnings.push('일반 정보와 숨김 정보가 달라 숨김 정보를 우선했습니다.');
    return { data: selected.data, source: selected.source, format: type, warnings: parsed.warnings };
}
