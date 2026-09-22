import { imageKey, imageRecord, rememberImage } from './image-records.mjs';
export function gallerySources(message) {
    const extra = message?.extra || {};
    return Array.isArray(extra.media) ? extra.media.map(m => m.url) : extra.image_swipes || (extra.image ? [extra.image] : []);
}
export function selectedGallerySource(message) {
    const extra = message?.extra || {};
    return extra.media?.[extra.media_index ?? 0]?.url || extra.image || gallerySources(message)[0] || '';
}
export function recoverGalleryRecords(message) {
    for (const media of message.extra?.media || []) {
        if (!imageRecord(message, media.url) && /(?:^|\/)autopic_/i.test(imageKey(media.url)) && media.title && media.title !== 'AutoPic') rememberImage(message, media.url, media.title);
    }
}
export function syncGalleryMedia(message, src, previous, constants) {
    if (!constants.MEDIA_TYPE?.IMAGE) return;
    const extra = message.extra ??= {};
    if (!Array.isArray(extra.media)) extra.media = gallerySources(message).map(url => ({ url, type: constants.MEDIA_TYPE.IMAGE, title: 'AutoPic', source: constants.MEDIA_SOURCE?.GENERATED }));
    let index = previous ? extra.media.findIndex(m => imageKey(m.url) === imageKey(previous)) : -1;
    if (index < 0) index = extra.media.findIndex(m => imageKey(m.url) === imageKey(src));
    const item = { url: src, type: constants.MEDIA_TYPE.IMAGE, title: 'AutoPic', source: constants.MEDIA_SOURCE?.GENERATED };
    if (index < 0) { extra.media.push(item); index = extra.media.length - 1; }
    else extra.media[index] = { ...extra.media[index], ...item };
    extra.media_index = index;
    extra.media_display ??= constants.MEDIA_DISPLAY?.GALLERY;
    // ST may expose legacy fields as non-configurable accessors over media.
    // Keep those aliases; remove only ordinary obsolete stored properties.
    for (const key of ['image', 'image_swipes', 'autopic_swipe_payloads']) {
        if (Object.getOwnPropertyDescriptor(extra, key)?.configurable) delete extra[key];
    }
}
