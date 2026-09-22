import { extractImageMetadata } from './nai-metadata.mjs';
self.onmessage = async ({ data }) => {
    try { self.postMessage({ result: await extractImageMetadata(data) }); }
    catch (error) { self.postMessage({ error: error.message }); }
};
