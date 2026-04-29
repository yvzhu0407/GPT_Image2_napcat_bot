import OpenAI from "openai";
import {mkdir, writeFile} from "node:fs/promises"
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import 'dotenv/config'
const DEBUG = process.env.DEBUG === '1'
const apiKey = process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.OPENAI_BASE_URL || "http://127.0.0.1:8317/v1").replace(/\/+$/, "");
const client = new OpenAI(
    {
        baseURL: BASE_URL,
        apiKey: apiKey
    } 
)


if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
}

const RESPONSES_MODEL = process.env.RESPONSES_MODEL || "gpt-5.4";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-2";
const DEFAULT_PROMPT = process.env.DEFAULT_PROMPT || "Generate a clean product shot of a glass honey jar on a light background.";
let PROMPT = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
const QUALITY = process.env.IMAGE_QUALITY || "high";
const FORMAT = (process.env.IMAGE_FORMAT || "png").toLowerCase();
const BACKGROUND = process.env.IMAGE_BACKGROUND || "opaque";
const MODERATION = process.env.IMAGE_MODERATION || "low";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "output";

function logInfo(...args) {
    console.log('[image]', ...args)
}

function logError(...args) {
    console.error('[image]', ...args)
}

function logDebug(...args) {
    if (DEBUG) {
        console.log('[image:debug]', ...args)
    }
}

function normalizeBase64(value) {
    return value.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").trim();
}

function parseSseChunk(chunk) {
    const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);

    let eventName = "";
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith(":")) {
            continue;
        }

        if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trim());
        }
    }

    return {
        eventName,
        data: dataLines.join("\n"),
    };
}

function extractImageBase64(eventName, payload) {
    if (
        eventName === "response.output_item.done" &&
        payload?.item?.type === "image_generation_call" &&
        typeof payload.item.result === "string" &&
        payload.item.result.length > 0
    ) {
        return payload.item.result;
    }

    if (
        payload?.type === "image_generation_call" &&
        typeof payload.result === "string" &&
        payload.result.length > 0
    ) {
        return payload.result;
    }

    if (eventName === "response.completed" && Array.isArray(payload?.response?.output)) {
        const imageItem = payload.response.output.find(
            (item) => item?.type === "image_generation_call" && typeof item.result === "string"
        );

        if (imageItem?.result) {
            return imageItem.result;
        }
    }

    return "";
}

async function requestImageGeneration(prompt, resolution = 'auto', img_edit, img_url) {
    if (img_edit || img_url) {
        throw new Error('当前图像接口仅支持 #画图 文生图，不支持改图。')
    }

    const response = await fetch(`${BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt,
            n: 1,
            size: resolution === 'auto' ? undefined : resolution,
            quality: QUALITY,
            response_format: "b64_json",
            background: BACKGROUND,
        }),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}\n${await response.text()}`);
    }

    const payload = await response.json();
    logDebug('image generation response', payload)

    const imageBase64 = payload?.data?.[0]?.b64_json || payload?.data?.[0]?.b64
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
        throw new Error('No image base64 returned from /v1/images/generations.')
    }

    return imageBase64;
}


export async function gen_img(prompt, resolution = 'auto', img_edit=false, img_url='') {
    logInfo('generate image', {
        base_url: BASE_URL,
        image_model: IMAGE_MODEL,
        prompt,
        resolution,
        img_edit,
        hasImageReference: Boolean(img_url),
        img_url: img_url || '',
    })
    const imageBase64 = await requestImageGeneration(prompt, resolution, img_edit=img_edit, img_url=img_url);
    if (!imageBase64) {
        throw new Error("No final image returned from /v1/images/generations.");
    }
    const outputPath = resolve(OUTPUT_DIR, `generated-${Date.now()}.${FORMAT}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(normalizeBase64(imageBase64), "base64"));

    logInfo('image saved', outputPath);
    return outputPath
}


export async function get_discrption_from_img(img_url, user_msg, img_edit=false) {
    // return 'testtesttesttesttest'
    const stream = await client.responses.create({
    model: "gpt-5.4",
    stream: true,
    input: [
        {
        role: "user",
        content: [
            { type: "input_text", text: img_edit?`请你为这张图片生成适合 gpt image 2的描述，**只**生成描述,不要加其他东西\r\n用户消息：${user_msg}`:`请你为这张图片生成适合 gpt image 2的描述，**只**生成描述,不要加其他东西\r\n用户消息：${user_msg}\r\n注意不是图像编辑，你要重新从 0 开始描述反推这张图片的提示词` },
            {
            type: "input_image",
            image_url: img_url
            }
        ]
        }
    ]
    })

    let text = ''
    for await (const res_chunk of stream) {
        if (res_chunk.type === "response.output_text.delta") {
            text += res_chunk.delta
            logDebug('description stream', text)

        }
    }
    return text

}


export async function chat_with_content(img_url=null, text_info=null, user_msg='') {
    // return 111
    const stream = await client.responses.create({
    model: "gpt-5.4",
    stream: true,
    input: [
        {
        role: "user",
        content: [
            { type: "input_text", text: text_info?`${text_info}\r\n用户信息：${user_msg}`:user_msg},
            // img_url?{
            // type: "input_image",
            // image_url: img_url
            // }:
            ...(img_url ? [{
                type: "input_image",
                image_url: img_url
            }] : [])
        ]
        }
    ]
    })

    let text = ''
    for await (const res_chunk of stream) {
        if (res_chunk.type === "response.output_text.delta") {
            text += res_chunk.delta
            logDebug('chat stream', text)

        }
    }
    return text

}


async function main() {
    logInfo('cli generate image', {
        base_url: BASE_URL,
        image_model: IMAGE_MODEL,
        prompt: PROMPT,
    })

    const imageBase64 = await requestImageGeneration(PROMPT);

    if (!imageBase64) {
        throw new Error("No final image returned from /v1/images/generations.");
    }

    const outputPath = resolve(OUTPUT_DIR, `generated-${Date.now()}.${FORMAT}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(normalizeBase64(imageBase64), "base64"));

    logInfo('image saved', outputPath);
}

const isMain = process.argv[0] && import.meta.url === pathToFileURL(process.argv[0]).href
if (isMain){main().catch((err)=>logError(err))}
