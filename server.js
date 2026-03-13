/**
 * AutoPic - server.js
 * ST 파일을 수정하지 않고 cfg_rescale을 NAI API에 전달하기 위한 프록시 라우터.
 * ST가 /api/novelai/generate-image 로 보내는 요청을 index.js의 fetch 인터셉터가
 * /api/plugins/autopic/generate-image 로 리다이렉트하면 여기서 처리한다.
 */

import fetch from 'node-fetch';
import { readSecret, SECRET_KEYS } from '../../secrets.js';
import { extractFileFromZipBuffer } from '../../../util.js';
import express from 'express';

const IMAGE_NOVELAI = 'https://image.novelai.net';
const API_NOVELAI   = 'https://api.novelai.net';

const REFERENCE_PIXEL_COUNT   = 1011712;
const SIGMA_MAGIC_NUMBER       = 19;
const SIGMA_MAGIC_NUMBER_V4_5  = 58;

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magicConstant = modelName?.includes('nai-diffusion-4-5')
        ? SIGMA_MAGIC_NUMBER_V4_5
        : SIGMA_MAGIC_NUMBER;
    const pixelCount = width * height;
    const ratio = pixelCount / REFERENCE_PIXEL_COUNT;
    return Math.pow(ratio, 0.5) * magicConstant;
}

export const router = express.Router();

/**
 * POST /api/plugins/autopic/generate-image
 * ST의 /api/novelai/generate-image 와 동일한 body를 받되,
 * cfg_rescale 필드를 추가로 처리해서 NAI에 전달한다.
 */
router.post('/generate-image', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    const key = readSecret(request.user.directories, SECRET_KEYS.NOVEL);
    if (!key) {
        console.warn('[AutoPic] NovelAI Access Token이 없습니다.');
        return response.sendStatus(400);
    }

    const body = request.body;
    const cfgRescale = typeof body.cfg_rescale === 'number' ? body.cfg_rescale : 0;

    console.debug(`[AutoPic] generate-image 프록시 호출 | cfg_rescale=${cfgRescale}`);

    try {
        const generateUrl = `${IMAGE_NOVELAI}/ai/generate-image`;
        const generateResult = await fetch(generateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'generate',
                input: body.prompt ?? '',
                model: body.model ?? 'nai-diffusion',
                parameters: {
                    params_version: 3,
                    prefer_brownian: true,
                    negative_prompt: body.negative_prompt ?? '',
                    height: body.height ?? 512,
                    width: body.width ?? 512,
                    scale: body.scale ?? 9,
                    cfg_rescale: cfgRescale,           // ★ 핵심 추가
                    seed: body.seed >= 0 ? body.seed : Math.floor(Math.random() * 9999999999),
                    sampler: body.sampler ?? 'k_dpmpp_2m',
                    noise_schedule: body.scheduler ?? 'karras',
                    steps: body.steps ?? 28,
                    n_samples: 1,
                    ucPreset: 0,
                    qualityToggle: false,
                    add_original_image: false,
                    controlnet_strength: 1,
                    deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: body.decrisper ?? false,
                    legacy: false,
                    legacy_v3_extend: false,
                    sm: body.sm ?? false,
                    sm_dyn: body.sm_dyn ?? false,
                    uncond_scale: 1,
                    skip_cfg_above_sigma: body.variety_boost
                        ? calculateSkipCfgAboveSigma(
                            body.width ?? 512,
                            body.height ?? 512,
                            body.model ?? 'nai-diffusion',
                        )
                        : null,
                    use_coords: false,
                    characterPrompts: [],
                    reference_image_multiple: [],
                    reference_information_extracted_multiple: [],
                    reference_strength_multiple: [],
                    v4_negative_prompt: {
                        caption: {
                            base_caption: body.negative_prompt ?? '',
                            char_captions: [],
                        },
                    },
                    v4_prompt: {
                        caption: {
                            base_caption: body.prompt ?? '',
                            char_captions: [],
                        },
                        use_coords: false,
                        use_order: true,
                    },
                },
            }),
        });

        if (!generateResult.ok) {
            const text = await generateResult.text();
            console.warn('[AutoPic] NAI 오류:', generateResult.statusText, text);
            return response.sendStatus(500);
        }

        const archiveBuffer = await generateResult.arrayBuffer();
        const imageBuffer   = await extractFileFromZipBuffer(archiveBuffer, '.png');

        if (!imageBuffer) {
            console.error('[AutoPic] PNG 파일을 ZIP에서 찾을 수 없음.');
            return response.sendStatus(500);
        }

        const originalBase64 = imageBuffer.toString('base64');

        // 업스케일 없으면 바로 반환
        if (isNaN(body.upscale_ratio) || body.upscale_ratio <= 1) {
            return response.send(originalBase64);
        }

        // 업스케일
        try {
            console.info('[AutoPic] 업스케일 중...');
            const upscaleResult = await fetch(`${API_NOVELAI}/ai/upscale`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    image: originalBase64,
                    height: body.height,
                    width: body.width,
                    scale: body.upscale_ratio,
                }),
            });

            if (!upscaleResult.ok) {
                const text = await upscaleResult.text();
                throw new Error('NAI 업스케일 오류', { cause: text });
            }

            const upscaledArchive = await upscaleResult.arrayBuffer();
            const upscaledBuffer  = await extractFileFromZipBuffer(upscaledArchive, '.png');

            if (!upscaledBuffer) throw new Error('업스케일 PNG를 찾을 수 없음.');

            return response.send(upscaledBuffer.toString('base64'));
        } catch (err) {
            console.warn('[AutoPic] 업스케일 실패, 원본 반환:', err);
            return response.send(originalBase64);
        }

    } catch (error) {
        console.error('[AutoPic] generate-image 프록시 오류:', error);
        return response.sendStatus(500);
    }
});
