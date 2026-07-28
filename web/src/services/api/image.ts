import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageToBlob, imageToDataUrl, resolveImageUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { nanoid } from "nanoid";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ResponseInputMessage =
    | ChatCompletionMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

export type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = ChatCompletionMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem = Record<string, unknown> &
    (
        | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
        | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string }
    );

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    size?: string;
    quality?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ResponsesApiResponse = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    file_data?: { mime_type?: string; mimeType?: string; file_uri?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    function_call?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponsesApiResponse; error?: string };
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    seed?: number;
    actualSize?: string;
    actualQuality?: string;
    revisedPrompt?: string;
};

type ParsedImageResponse = {
    images: GeneratedImage[];
    responseBody: string;
};

type RequestOptions = { signal?: AbortSignal };

async function referenceImageToFile(image: ReferenceImage) {
    const blob = await imageToBlob(image);
    const mime = blob.type || image.type || "image/png";
    const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    return new File([blob], image.name || `reference.${ext}`, { type: mime });
}

export class ImageRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "ImageRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

type ImageRequestParams = {
    n: number;
    quality: string;
    size?: string;
    outputFormat: "png" | "jpeg" | "webp";
    outputCompression: number;
    moderation: "auto" | "low";
    timeoutSeconds: number;
    streamPartialImages: number;
};

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const MIME_MAP: Record<ImageRequestParams["outputFormat"], string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};
const PROMPT_REWRITE_GUARD_PREFIX = "Use the following text as the complete prompt. Do not rewrite it:";

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    if (!value || value === "auto") return "auto";
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : "auto";
}

function normalizeOutputFormat(value: string): ImageRequestParams["outputFormat"] {
    return value === "jpeg" || value === "webp" ? value : "png";
}

function normalizeModeration(value: string): ImageRequestParams["moderation"] {
    return value === "low" ? "low" : "auto";
}

function normalizeBoundedInteger(value: string | number, fallback: number, min: number, max: number) {
    const number = Math.floor(Math.abs(Number(value)));
    if (!Number.isFinite(number) || number < min) return fallback;
    return Math.max(min, Math.min(max, number));
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". Returns undefined when quality is auto. */
function resolveSize(quality: string, ratio: string): string | undefined {
    const basePixels = QUALITY_BASE[quality];
    if (!basePixels || ratio === "auto" || !ratio) return undefined;

    const parts = ratio.split(":");
    if (parts.length !== 2) return undefined;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) return undefined;

    const targetPixels = basePixels * basePixels;
    const isLandscape = w >= h;
    const longRatio = isLandscape ? w / h : h / w;

    const longSideRaw = Math.sqrt(targetPixels * longRatio);
    const longSide = Math.floor(longSideRaw / 16) * 16;
    const shortSide = Math.round(longSide / longRatio / 16) * 16;

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;

    return `${width}x${height}`;
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value === "auto") return undefined;
    if (/^\d+x\d+$/.test(value)) return value;
    // 用户只选了宽高比时,即使 quality=auto 也要折算成具体像素尺寸,避免 "1:1" 这种非法值发到 API。
    return resolveSize(quality && QUALITY_BASE[quality] ? quality : "low", value);
}

function createImageRequestParams(config: AiConfig): ImageRequestParams {
    const quality = normalizeQuality(config.quality);
    const outputFormat = normalizeOutputFormat(config.outputFormat);
    return {
        n: normalizeBoundedInteger(config.count, 1, 1, 15),
        quality,
        size: resolveRequestSize(quality, config.size),
        outputFormat,
        outputCompression: normalizeBoundedInteger(config.outputCompression, 100, 0, 100),
        moderation: normalizeModeration(config.moderation),
        timeoutSeconds: normalizeBoundedInteger(config.timeout, 600, 1, 3600),
        streamPartialImages: normalizeBoundedInteger(config.streamPartialImages, 1, 0, 3),
    };
}

function normalizeImageSource(value: string, fallbackMime: string) {
    if (value.startsWith("data:")) return value;
    if (/^https?:\/\//i.test(value)) return value;
    return `data:${fallbackMime};base64,${value}`;
}

function resolveImageDataUrl(item: Record<string, unknown>, mime: string) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return normalizeImageSource(item.b64_json, mime);
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    if (typeof item.image_url === "string" && item.image_url) {
        return item.image_url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    if (payload.error?.message) {
        throw new ImageRequestError(payload.error.message, payload);
    }
    if (payload.msg && !payload.data?.length) {
        throw new ImageRequestError(payload.msg, payload);
    }
    const record = payload as ImageApiResponse & Record<string, unknown>;
    const imageItems = [
        ...(payload.data || []),
        ...collectImageRecords(record.images),
        ...collectImageRecords(record.results),
        ...collectImageRecords(record.output),
    ];
    const seen = new Set<string>();
    const images = imageItems.flatMap((item) => {
        const dataUrl = resolveImageDataUrl(item, mime);
        if (!dataUrl || seen.has(dataUrl)) return [];
        seen.add(dataUrl);
        return [{
            id: nanoid(),
            dataUrl,
            actualSize: getOptionalString(item, "size") || payload.size,
            actualQuality: getOptionalString(item, "quality") || payload.quality,
            revisedPrompt: getOptionalString(item, "revised_prompt") || getOptionalString(item, "revisedPrompt"),
        }];
    });

    if (images.length === 0) {
        throw new ImageRequestError("接口没有返回图片", payload);
    }

    return images;
}

function collectImageRecords(value: unknown, depth = 0): Array<Record<string, unknown>> {
    if (value == null || depth > 4) return [];
    if (typeof value === "string") return [{ url: value }];
    if (Array.isArray(value)) return value.flatMap((item) => collectImageRecords(item, depth + 1));
    if (!isRecord(value)) return [];
    if (resolveImageDataUrl(value, "image/png")) return [value];
    return ["data", "images", "results", "output", "result"].flatMap((key) => collectImageRecords(value[key], depth + 1));
}

function parseJsonPayload<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function unescapeJsonString(value: string) {
    try {
        return JSON.parse(`"${value}"`) as string;
    } catch {
        return value;
    }
}

function extractQuotedValuesByKey(text: string, keys: string[]) {
    const values: string[] = [];
    keys.forEach((key) => {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
            const value = unescapeJsonString(match[1]).trim();
            if (value) values.push(value);
        }
    });
    return Array.from(new Set(values));
}

function parseImageTextPayload(text: string, mime: string): GeneratedImage[] {
    const payload = parseJsonPayload<ImageApiResponse>(text);
    if (payload) return parseImagePayload(payload, mime);
    const sources = extractQuotedValuesByKey(text, ["b64_json", "image_url", "url"]);
    const images = sources.map((source) => ({ id: nanoid(), dataUrl: normalizeImageSource(source, mime) }));
    if (images.length) return images;
    throw new ImageRequestError("图片接口响应解析失败", text);
}

function getStringRecordValue(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getOptionalString(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectResponsesImageStrings(value: unknown, depth = 0): string[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.flatMap((item) => collectResponsesImageStrings(item, depth + 1));
    if (typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ["result", "b64_json", "base64", "image", "image_url", "url", "image_data", "data", "content", "output"].flatMap((key) => collectResponsesImageStrings(record[key], depth + 1));
}

function getResponsesImageResultSource(result: unknown) {
    return collectResponsesImageStrings(result)[0] || "";
}

function collectResponsesImageSources(item: Record<string, unknown>) {
    const values: string[] = [];
    const result = getResponsesImageResultSource(item.result);
    if (result) values.push(result);
    values.push(...collectResponsesImageStrings(item));
    return Array.from(new Set(values));
}

function parseResponsesPayload(payload: ResponsesApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    if (payload.error?.message) {
        throw new ImageRequestError(payload.error.message, payload);
    }
    if (payload.msg && !payload.output?.length) {
        throw new ImageRequestError(payload.msg, payload);
    }
    const images =
        payload.output
            ?.filter((item) => item.type === "image_generation_call")
            .flatMap((item) =>
                collectResponsesImageSources(item)
                    .filter(Boolean)
                    .map((source) => ({
                        id: nanoid(),
                        dataUrl: normalizeImageSource(source, mime),
                        actualSize: getOptionalString(item, "size"),
                        actualQuality: getOptionalString(item, "quality"),
                        revisedPrompt: getOptionalString(item, "revised_prompt") || getOptionalString(item, "revisedPrompt"),
                    })),
            ) || [];

    if (images.length === 0) {
        throw new ImageRequestError("Responses API 没有返回图片", payload);
    }

    return images;
}

function parseResponsesTextPayload(text: string, mime: string): GeneratedImage[] {
    const payload = parseJsonPayload<ResponsesApiResponse>(text);
    if (payload) return parseResponsesPayload(payload, mime);
    const output: Record<string, unknown>[] = [];
    const partialImages: string[] = [];
    parseJsonDataPayloads(text).forEach((event) => {
        if (event.type === "response.image_generation_call.partial_image") {
            const b64 = getStringRecordValue(event, "partial_image_b64");
            if (b64) partialImages.push(b64);
        }
        if (event.type === "response.image_generation_call.completed") {
            output.push({ type: "image_generation_call", result: event.result, image_url: event.image_url, url: event.url });
        }
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "image_generation_call") {
            output.push(item as Record<string, unknown>);
        }
        const responsePayload = event.response;
        if (responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)) {
            output.push(...(((responsePayload as ResponsesApiResponse).output || []) as Record<string, unknown>[]));
        }
    });
    const directSources = extractQuotedValuesByKey(text, ["result", "b64_json", "image_url", "url", "partial_image_b64"]);
    const images = [
        ...output.flatMap((item) => collectResponsesImageSources(item)),
        ...directSources,
        ...(partialImages.length ? [partialImages[partialImages.length - 1]] : []),
    ]
        .filter(Boolean)
        .map((source) => ({ id: nanoid(), dataUrl: normalizeImageSource(source, mime) }));
    if (images.length) return Array.from(new Map(images.map((image) => [image.dataUrl, image])).values());
    throw new ImageRequestError("Responses API 响应解析失败", text);
}

function readAxiosError(error: unknown, fallback: string) {
    if (isRequestCanceled(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

async function fetchErrorDetail(response: Response, fallback: string) {
    try {
        const text = await response.text();
        if (!text.trim()) return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
        try {
            const payload = JSON.parse(text) as { error?: { message?: string }; msg?: string; message?: string };
            return { message: payload.msg || payload.error?.message || payload.message || `${fallback}：${response.status}`, detail: payload };
        } catch {
            return { message: text.trim() || `${fallback}：${response.status}`, detail: text };
        }
    } catch {
        return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
    }
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function timeoutError(timeoutSeconds: number) {
    return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`;
}

function isRequestCanceled(error: unknown) {
    return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && (error.name === "AbortError" || error.message === "请求已取消")) || axios.isCancel(error);
}

async function withTimeout<T>(timeoutSeconds: number, run: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) throw new Error("请求已取消");
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await run(controller.signal);
    } catch (error) {
        if (parentSignal?.aborted) throw new Error("请求已取消");
        if (controller.signal.aborted) throw new Error(timeoutError(timeoutSeconds));
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
        parentSignal?.removeEventListener("abort", abort);
    }
}

function isTransientStatus(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number) {
    return 700 * attempt;
}

async function requestWithTransientRetry(run: () => Promise<Response>, retries = 0) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await run();
            if (!isTransientStatus(response.status) || attempt === retries) return response;
            lastError = new Error(`上游接口临时不可用：${response.status}`);
        } catch (error) {
            lastError = error;
            if (isRequestCanceled(error)) throw error;
            if (attempt === retries) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function readBalancedJson(text: string, start: number) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }
        if (char === "\"") {
            inString = true;
        } else if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(start, index + 1);
        }
    }
    return "";
}

function parseJsonDataPayloads(text: string) {
    const events: Record<string, unknown>[] = [];
    let index = 0;
    while (index < text.length) {
        const dataIndex = text.indexOf("data:", index);
        if (dataIndex < 0) break;
        let start = dataIndex + 5;
        while (/\s/.test(text[start] || "")) start += 1;
        if (text.startsWith("[DONE]", start)) {
            index = start + 6;
            continue;
        }
        if (text[start] !== "{") {
            index = start + 1;
            continue;
        }
        const jsonText = readBalancedJson(text, start);
        if (!jsonText) break;
        const event = parseJsonPayload<Record<string, unknown>>(jsonText);
        if (event) events.push(event);
        index = start + jsonText.length;
    }
    return events;
}

function parseServerSentEventBlock(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (data && data !== "[DONE]") return [JSON.parse(data) as Record<string, unknown>];
    return parseJsonDataPayloads(block);
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) throw new ImageRequestError("接口未返回可读取的流式响应", `${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];

    const processBlock = (block: string) => {
        let parsedEvents: Record<string, unknown>[] = [];
        try {
            parsedEvents = parseServerSentEventBlock(block);
        } catch (error) {
            throw new ImageRequestError(error instanceof Error ? error.message : "流式响应解析失败", block);
        }
        parsedEvents.forEach((event) => {
            events.push(event);
            const error = event.error;
            if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { message?: unknown }).message === "string") {
                throw new ImageRequestError((error as { message: string }).message, event);
            }
            onEvent(event);
        });
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.search(/\r?\n\r?\n/);
        while (separatorIndex >= 0) {
            const separator = buffer.match(/\r?\n\r?\n/)?.[0] || "\n\n";
            processBlock(buffer.slice(0, separatorIndex));
            buffer = buffer.slice(separatorIndex + separator.length);
            separatorIndex = buffer.search(/\r?\n\r?\n/);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return events;
}

function isEventStreamResponse(response: Response) {
    return response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream") ?? false;
}

async function parseImagesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    const completedItems: Record<string, unknown>[] = [];
    let resultPayload: ImageApiResponse | null = null;
    const events = await readJsonServerSentEvents(response, (event) => {
        const type = typeof event.type === "string" ? event.type : "";
        const object = typeof event.object === "string" ? event.object : "";
        if (object === "image.generation.result" || object === "image.edit.result") {
            resultPayload = event as ImageApiResponse;
        }
        if (type === "image_generation.completed" || type === "image_edit.completed") {
            completedItems.push(event);
        }
    });
    if (resultPayload) return parseImagePayload(resultPayload, mime);
    if (completedItems.length) return parseImagePayload({ data: completedItems }, mime);
    throw new ImageRequestError("流式接口未返回最终图片数据", events);
}

async function parseResponsesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    let completedPayload: ResponsesApiResponse | null = null;
    const output: Record<string, unknown>[] = [];
    const partialImages: string[] = [];
    const events = await readJsonServerSentEvents(response, (event) => {
        if (event.type === "response.image_generation_call.partial_image") {
            const b64 = getStringRecordValue(event, "partial_image_b64");
            if (b64) partialImages.push(b64);
            return;
        }
        if (event.type === "response.image_generation_call.completed") {
            output.push({ type: "image_generation_call", result: event.result, image_url: event.image_url, url: event.url });
        }
        const responsePayload = event.response;
        if (responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)) {
            completedPayload = responsePayload as ResponsesApiResponse;
        }
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "image_generation_call") {
            output.push(item as Record<string, unknown>);
        }
    });
    const combinedOutput = [...((completedPayload?.output || []) as Record<string, unknown>[]), ...output];
    try {
        return parseResponsesPayload({ ...(completedPayload || {}), output: combinedOutput }, mime);
    } catch (error) {
        if (!partialImages.length) {
            throw new ImageRequestError(error instanceof Error ? error.message : "Responses API 没有返回图片", {
                completedPayload,
                output,
                events,
            });
        }
        const lastPartialImage = partialImages[partialImages.length - 1];
        return [{ id: nanoid(), dataUrl: normalizeImageSource(lastPartialImage, mime) }];
    }
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .replace(/^ /, "");
        if (!data || data === "[DONE]") continue;
        const payload = parseJsonPayload<{ error?: { message?: string }; choices?: Array<{ delta?: { content?: string } }> }>(data);
        if (!payload) continue;
        if (payload.error?.message) throw new ImageRequestError(payload.error.message, payload);
        const delta = payload.choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = (config.systemPrompts.image || config.systemPrompt).trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withPromptGuard(config: AiConfig, prompt: string) {
    return config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    return config.channelMode === "remote"
        ? {
              Authorization: `Bearer ${token}`,
              ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
          }
        : {
              Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function activeProtocol(config: AiConfig) {
    if (config.channelMode === "local") return localChannelForActiveModel(config)?.protocol || "openai";
    const channelId = channelIdForActiveModel(config);
    return config.publicChannels.find((channel) => channel.id === channelId)?.protocol || config.publicChannels.find((channel) => channel.models.includes(config.model))?.protocol || "openai";
}

function geminiConfig(config: AiConfig): AiConfig {
    const channel = localChannelForActiveModel(config);
    return {
        ...config,
        baseUrl: channel?.baseUrl || config.baseUrl,
        apiKey: channel?.apiKey || config.apiKey,
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com").trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function validateResponsePayload(payload: ResponsesApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new ImageRequestError(payload.msg || "请求失败", payload);
    if (payload.error?.message) throw new ImageRequestError(payload.error.message, payload);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new ImageRequestError(payload.error.message, payload);
    if (payload.promptFeedback?.blockReason) throw new ImageRequestError(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`, payload);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return response.status ? `${fallback}：${response.status}` : fallback;
    try {
        return responseErrorMessage(JSON.parse(text)) || (response.status ? `${fallback}：${response.status}` : fallback);
    } catch {
        return text.slice(0, 300) || (response.status ? `${fallback}：${response.status}` : fallback);
    }
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [{ type: "function_call", call_id: message.call_id, name: message.name, arguments: message.arguments }];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponsesApiResponse): ToolResponseResult {
    validateResponsePayload(payload);
    const output = (payload.output || []) as ResponseApiOutputItem[];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: stringValue(item.call_id) || stringValue(item.id) || nanoid(),
            type: "function" as const,
            function: { name: stringValue(item.name), arguments: stringValue(item.arguments) || "{}" },
        }))
        .filter((item) => item.function.name);
    return { content, toolCalls };
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponsesApiResponse;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponsesApiResponse;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        consumeResponseStreamBlock(state.buffer.slice(0, match.index), state, onDelta);
        state.buffer = state.buffer.slice(match.index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new ImageRequestError(await readFetchError(response, "请求失败"));
    if (!response.body) return parseToolResponse((await response.json()) as ResponsesApiResponse);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new ImageRequestError(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new ImageRequestError(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        (config.systemPrompts.text || config.systemPrompt).trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig = typeof toolChoice === "object" ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] } : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new ImageRequestError(await readFetchError(response, "请求失败"));
    if (!response.body) return parseGeminiToolResponse((await response.json()) as GeminiPayload);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new ImageRequestError(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new ImageRequestError(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        consumeGeminiStreamBlock(state.buffer.slice(0, match.index), state, onDelta);
        state.buffer = state.buffer.slice(match.index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall || part.function_call)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call || item.function_call === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: withPromptGuard(config, withSystemPrompt(config, prompt)) }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        },
        { headers: geminiHeaders(config), signal: options?.signal, timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000 },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                const fileData = part.fileData || (part.file_data ? { mimeType: part.file_data.mimeType || part.file_data.mime_type, fileUri: part.file_data.fileUri || part.file_data.file_uri } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new ImageRequestError("Gemini 接口没有返回图片", payload);
    return images;
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

async function writeLocalAICallLog(config: AiConfig, endpoint: string, startedAt: number, status: number, timeoutSeconds: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local") return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method: "POST",
            model: config.model,
            channelId: channel?.id || config.activeChannelId || "",
            channelName: channel?.name || "本地直连",
            status,
            durationMs: Date.now() - startedAt,
            credits: 0,
            requestBody,
            responseBody,
            error,
        }),
    }).catch(() => {});
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogImages(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogImages(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogImages);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || item.length > 2048 && looksLikeBase64(item))) {
            record[key] = `[redacted image/string len=${item.length}]`;
            continue;
        }
        redactLogImages(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function summarizeFormData(formData: FormData) {
    const fields: Record<string, string[]> = {};
    const files: Array<{ field: string; name: string; size: number; type: string }> = [];
    formData.forEach((value, key) => {
        if (value instanceof File) {
            files.push({ field: key, name: value.name, size: value.size, type: value.type });
            return;
        }
        fields[key] = [...(fields[key] || []), String(value)];
    });
    return { fields, files };
}

function summarizeGeneratedImages(images: GeneratedImage[], source: string) {
    return stringifyLogPayload({
        source,
        imageCount: images.length,
        images: images.map((image) => ({ id: image.id, dataUrl: image.dataUrl.startsWith("data:image/") ? `[redacted image len=${image.dataUrl.length}]` : image.dataUrl })),
    });
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = (config.systemPrompts.text || config.systemPrompt).trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

async function requestImageGenerationSingle(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, params: ImageRequestParams, options: RequestOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];

    // Agnes 对请求体比较严格，默认只发送官方通用字段；用户显式填写 seed 时再放入 extra_body。
    if (isAgnesImageModel(config.model)) {
        const seedValue = config.seed ? generateDiscreteSeed(config.seedIndex, config.seedCount, config.seed) : undefined;
        const body: Record<string, unknown> = {
            model: config.model,
            prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        };
        if (seedValue !== undefined) body.extra_body = { seed: seedValue };
        if (params.size) body.size = params.size;

        return requestAndParseImages(
            config,
            "/images/generations",
            body,
            params.timeoutSeconds,
            () =>
                requestWithTransientRetry(() =>
                    withTimeout(params.timeoutSeconds, (signal) =>
                        fetch(aiApiUrl(config, "/images/generations"), {
                            method: "POST",
                            headers: aiHeaders(config, "application/json"),
                            body: JSON.stringify(body),
                            signal,
                        }),
                        options.signal,
                    ),
                ),
            async (response) => {
                if (config.streamImages && isEventStreamResponse(response)) {
                    const images = await parseImagesStreamResponse(response, mime);
                    return { images: images.map((img) => (seedValue === undefined ? img : { ...img, seed: seedValue })), responseBody: summarizeGeneratedImages(images, "event-stream") };
                }
                const text = await response.text();
                const images = parseImageTextPayload(text, mime);
                return { images: images.map((img) => (seedValue === undefined ? img : { ...img, seed: seedValue })), responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "text-fallback")) };
            },
        );
    }

    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        output_format: params.outputFormat,
        moderation: params.moderation,
    };
    if (params.n > 1) body.n = params.n;
    if (params.size) body.size = params.size;
    if (params.quality && !config.codexCli) body.quality = params.quality;
    if (params.outputFormat !== "png") body.output_compression = params.outputCompression;
    if (config.responseFormatB64Json) body.response_format = "b64_json";
    if (config.streamImages) {
        body.stream = true;
        body.partial_images = params.streamPartialImages;
    }

    return requestAndParseImages(
        config,
        "/images/generations",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                    withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                    options.signal,
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const text = await response.text();
            const images = parseImageTextPayload(text, mime);
            return { images, responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "text-fallback")) };
        },
    );
}

async function requestImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams, maskDataUrl?: string, options: RequestOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withPromptGuard(config, withSystemPrompt(config, prompt)));
    formData.set("output_format", params.outputFormat);
    formData.set("moderation", params.moderation);
    if (params.n > 1) formData.set("n", String(params.n));
    if (params.size) formData.set("size", params.size);
    if (params.quality && !config.codexCli) formData.set("quality", params.quality);
    if (params.outputFormat !== "png") formData.set("output_compression", String(params.outputCompression));
    if (config.responseFormatB64Json) formData.set("response_format", "b64_json");
    if (config.streamImages) {
        formData.set("stream", "true");
        formData.set("partial_images", String(params.streamPartialImages));
    }
    const files = await Promise.all(references.map((image) => referenceImageToFile(image)));
    files.forEach((file) => formData.append("image", file));
    if (maskDataUrl) formData.set("mask", dataUrlToFile({ id: "mask", name: "mask.png", type: "image/png", dataUrl: maskDataUrl }));

    return requestAndParseImages(
        config,
        "/images/edits",
        summarizeFormData(formData),
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                    withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/edits"), {
                        method: "POST",
                        headers: aiHeaders(config),
                        body: formData,
                        signal,
                    }),
                    options.signal,
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const text = await response.text();
            const images = parseImageTextPayload(text, mime);
            return { images, responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "text-fallback")) };
        },
    );
}

async function requestArkImageEdit(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams, options: RequestOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        image: await Promise.all(references.map((image) => imageToDataUrl(image))),
        response_format: config.responseFormatB64Json ? "b64_json" : "url",
        output_format: params.outputFormat,
    };
    if (params.n > 1) body.n = params.n;
    if (params.size) body.size = params.size;
    if (params.quality && params.quality !== "auto") body.quality = params.quality;

    return requestAndParseImages(
        config,
        "/images/generations",
        { ...body, image: references.map((image) => ({ id: image.id, name: image.name, type: image.type })) },
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(
                    params.timeoutSeconds,
                    (signal) =>
                        fetch(aiApiUrl(config, "/images/generations"), {
                            method: "POST",
                            headers: aiHeaders(config, "application/json"),
                            body: JSON.stringify(body),
                            signal,
                        }),
                    options.signal,
                ),
            ),
        async (response) => {
            const text = await response.text();
            const images = parseImageTextPayload(text, mime);
            return { images, responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "ark-image-edit")) };
        },
    );
}

function createResponsesImageTool(config: AiConfig, params: ImageRequestParams, isEdit: boolean) {
    const tool: Record<string, unknown> = {
        type: "image_generation",
        action: isEdit ? "edit" : "generate",
        size: params.size || "auto",
        output_format: params.outputFormat,
        moderation: params.moderation,
    };
    if (params.quality && !config.codexCli) tool.quality = params.quality;
    if (params.outputFormat !== "png") tool.output_compression = params.outputCompression;
    if (config.streamImages) tool.partial_images = params.streamPartialImages;
    return tool;
}

function createResponsesInput(config: AiConfig, prompt: string, inputImageDataUrls: string[]) {
    const text = config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
    if (!inputImageDataUrls.length) return text;
    return [
        {
            role: "user",
            content: [
                { type: "input_text", text },
                ...inputImageDataUrls.map((dataUrl) => ({
                    type: "input_image",
                    image_url: dataUrl,
                })),
            ],
        },
    ];
}

async function requestResponsesSingle(config: AiConfig, prompt: string, inputImageDataUrls: string[], params: ImageRequestParams, options: RequestOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const body: Record<string, unknown> = {
        model: config.model,
        input: createResponsesInput(config, withSystemPrompt(config, prompt), inputImageDataUrls),
        tools: [createResponsesImageTool(config, params, inputImageDataUrls.length > 0)],
        tool_choice: "required",
    };
    if (config.streamImages) body.stream = true;

    return requestAndParseImages(
        config,
        "/responses",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                    withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/responses"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                    options.signal,
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseResponsesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const text = await response.text();
            const images = parseResponsesTextPayload(text, mime);
            return { images, responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "text-fallback")) };
        },
    );
}

async function requestAndParseImages(config: AiConfig, endpoint: string, requestBody: unknown, timeoutSeconds: number, fetchResponse: () => Promise<Response>, parseResponse: (response: Response) => Promise<ParsedImageResponse>) {
    const startedAt = Date.now();
    let logged = false;
    try {
        const response = await fetchResponse();
        if (!response.ok) {
            try {
                const parsed = await parseResponse(response.clone());
                logged = true;
                void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), parsed.responseBody, "");
                return parsed.images;
            } catch {
                // Fall through to the normal error detail path when the body does not contain usable images.
            }
            const error = await fetchErrorDetail(response, "请求失败");
            logged = true;
            void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), stringifyLogPayload(error.detail || error.message), error.message);
            throw new ImageRequestError(error.message, error.detail);
        }
        const parsed = await parseResponse(response);
        logged = true;
        void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), parsed.responseBody, "");
        return parsed.images;
    } catch (error) {
        if (!logged) {
            void writeLocalAICallLog(config, endpoint, startedAt, 0, timeoutSeconds, stringifyLogPayload(requestBody), "", error instanceof ImageRequestError ? error.detail || error.message : error instanceof Error ? error.message : "请求失败");
        }
        throw error;
    }
}

async function requestImages(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], options: { maskDataUrl?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage[]> {
    const params = createImageRequestParams(config);
    const protocol = activeProtocol(config);
    if (protocol === "gemini" && config.channelMode === "local") {
        if (options.maskDataUrl) throw new ImageRequestError("Gemini 调用格式暂不支持蒙版编辑");
        return requestGeminiImages(geminiConfig(config), prompt, references, params.n, options);
    }
    if (protocol === "ark" && references.length) {
        if (options.maskDataUrl) throw new ImageRequestError("火山方舟调用格式暂不支持蒙版编辑");
        return requestArkImageEdit(config, prompt, references, params, options);
    }
    const useConcurrentSingleRequests = config.apiMode === "responses" || config.codexCli || config.streamImages;
    if (params.n > 1 && useConcurrentSingleRequests) {
        const results = await Promise.allSettled(Array.from({ length: params.n }, () => requestImages({ ...config, count: "1" }, prompt, references, options)));
        const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (images.length) return images;
        const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstError?.reason || new Error("所有并发请求均失败");
    }
    if (references.length && isAgnesImageModel(config.model) && !options.maskDataUrl) {
        return requestAgnesImageEdit(config, prompt, references, params, options);
    }
    if (references.length && options.maskDataUrl) return requestImageEditSingle(config, prompt, references, params, options.maskDataUrl, options);
    if (config.apiMode === "responses" && !options.maskDataUrl) {
        const inputImageDataUrls = references.length ? await Promise.all(references.map((image) => imageToDataUrl(image))) : [];
        return requestResponsesSingle(config, prompt, inputImageDataUrls, params, options);
    }
    return references.length ? requestImageEditSingle(config, prompt, references, params, options.maskDataUrl, options) : requestImageGenerationSingle(config, prompt, params, options);
}

export async function requestGeneration(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, options: RequestOptions = {}) {
    try {
        const images = await withAiRequestRetry(config, () => requestImages(config, prompt, [], options), options);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], options: { maskDataUrl?: string; signal?: AbortSignal } = {}) {
    try {
        const images = await withAiRequestRetry(config, () => requestImages(config, prompt, references, options), options);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

async function withAiRequestRetry<T>(config: AiConfig, run: () => Promise<T>, options: RequestOptions = {}): Promise<T> {
    const retries = normalizeBoundedInteger(config.retryAttempts, 0, 0, 5);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await run();
        } catch (error) {
            lastError = error;
            if (options.signal?.aborted || isRequestCanceled(error)) throw error;
            if (attempt >= retries) break;
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        }
    }
    throw lastError;
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void, options: RequestOptions = {}) {
    if (activeLocalProtocol(config) === "gemini") {
        try {
            const answer = (await requestGeminiStreamingResponse(geminiConfig(config), toGeminiBody(geminiConfig(config), withSystemMessage(config, messages)), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return answer;
        } catch (error) {
            if (isRequestCanceled(error)) throw new Error("请求已取消");
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    let buffer = "";
    let answer = "";
    let processedLength = 0;

    try {
        const response = await axios.post(
            aiApiUrl(config, "/chat/completions"),
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                } as Record<string, string>,
                responseType: "text",
                timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
                signal: options.signal,
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer.trim()) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        if (answer.trim()) {
            refreshRemoteUser(config);
            return answer;
        }
        throw new Error(readAxiosError(error, "请求失败"));
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options: RequestOptions = {}): Promise<ToolResponseResult> {
    try {
        if (activeLocalProtocol(config) === "gemini") {
            return await requestGeminiStreamingResponse(geminiConfig(config), toGeminiBody(geminiConfig(config), messages, toGeminiToolOptions(tools, toolChoice)), onDelta, options);
        }
        return await requestStreamingResponse(
            config,
            {
                model: config.model,
                input: toResponseInput(withSystemMessage(config, messages)),
                tools: tools.map(toResponseTool),
                tool_choice: toolChoice,
                parallel_tool_calls: false,
            },
            onDelta,
            options,
        );
    } catch (error) {
        if (isRequestCanceled(error)) throw new Error("请求已取消");
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
        if (activeLocalProtocol(config) === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl(geminiConfig(config)), {
                headers: geminiHeaders(geminiConfig(config)),
                timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
            });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
            timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
function isAgnesImageModel(model: string) {
    const m = model.toLowerCase().replace(/[\s_]+/g, "-");
    return m.startsWith("agnes-image") || m.startsWith("agens-image");
}
function generateDiscreteSeed(seedIndex?: number, seedCount?: number, customSeed?: string): number {
    if (customSeed && !isNaN(Number(customSeed))) {
        const baseSeed = Math.floor(Number(customSeed));
        if (baseSeed >= 0) {
            if (typeof seedIndex === "number" && seedIndex >= 0) {
                return (baseSeed + seedIndex) % 2147483648;
            }
            return baseSeed;
        }
    }

    let randVal = 0;
    if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
        const array = new Uint32Array(1);
        window.crypto.getRandomValues(array);
        randVal = array[0];
    } else {
        // 降级使用微秒级时空杂凑
        const timeSalt = Date.now() * 1000 + Math.floor(performance.now() * 1000) % 1000;
        const mathRand = Math.random() * 1000000;
        randVal = timeSalt ^ mathRand;
    }

    if (typeof seedIndex === "number" && seedIndex >= 0) {
        const chunks = typeof seedCount === "number" && seedCount > 0 ? Math.floor(seedCount) : 100;
        const index = Math.floor(seedIndex) % chunks;
        const chunkSize = Math.floor(2147483647 / chunks);
        const minVal = index * chunkSize + 1;
        const maxVal = (index + 1) * chunkSize;
        const range = maxVal - minVal;
        return (randVal % range) + minVal;
    }

    // 默认依然在全域进行真随机
    return (randVal % 2147483647) + 1;
}

function publicHttpUrl(value?: string) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return "";
    try {
        const url = new URL(value, typeof window === "undefined" ? undefined : window.location.origin);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "";
        return url.href;
    } catch {
        return "";
    }
}

async function requestAgnesImageEdit(config: AiConfig & { seedIndex?: number; seedCount?: number }, prompt: string, references: ReferenceImage[], params: ImageRequestParams, options: RequestOptions = {}): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];

    // 获取所有参考图的公共 HTTP 链接或降级为 base64 数组，完美对齐 extra_body.image
    const imageUrls = await Promise.all(
        references.map(async (ref) => {
            const resolvedUrl = await resolveImageUrl(ref.storageKey, "");
            for (const url of [ref.dataUrl, ref.url, resolvedUrl]) {
                const publicUrl = publicHttpUrl(url);
                if (publicUrl) return publicUrl;
            }
            return imageToDataUrl(ref);
        })
    );

    const seedValue = config.seed ? generateDiscreteSeed(config.seedIndex, config.seedCount, config.seed) : undefined;
    const extraBody: Record<string, unknown> = { image: imageUrls };
    if (seedValue !== undefined) extraBody.seed = seedValue;
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        extra_body: extraBody,
    };
    if (params.size) body.size = params.size; // 👈 官方支持参数
    // 彻底剔除 response_format、output_format、moderation、quality、stream 等 LiteLLM/agnes-i2i 模型不支持的冗余参数，防止引发 400 阻断

    return requestAndParseImages(
        config,
        "/images/generations", // 核心对齐：官方图生图同样使用 /images/generations 接口
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                    options.signal,
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images: images.map((img) => (seedValue === undefined ? img : { ...img, seed: seedValue })), responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const text = await response.text();
            const images = parseImageTextPayload(text, mime);
            return { images: images.map((img) => (seedValue === undefined ? img : { ...img, seed: seedValue })), responseBody: stringifyLogPayload(parseJsonPayload(text) || summarizeGeneratedImages(images, "text-fallback")) };
        },
    );
}
