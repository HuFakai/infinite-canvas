import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { nanoid } from "nanoid";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ResponsesApiResponse = {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type GeneratedImage = { id: string; dataUrl: string };

type ParsedImageResponse = {
    images: GeneratedImage[];
    responseBody: string;
};

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

function normalizeBase64Image(value: string, fallbackMime: string) {
    return value.startsWith("data:") ? value : `data:${fallbackMime};base64,${value}`;
}

function resolveImageDataUrl(item: Record<string, unknown>, mime: string) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return normalizeBase64Image(item.b64_json, mime);
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.data
            ?.map((item) => resolveImageDataUrl(item, mime))
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("接口没有返回图片", payload);
    }

    return images;
}

function getStringRecordValue(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function collectResponsesImageStrings(value: unknown, depth = 0): string[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.flatMap((item) => collectResponsesImageStrings(item, depth + 1));
    if (typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ["result", "b64_json", "base64", "image", "image_data", "data"].flatMap((key) => collectResponsesImageStrings(record[key], depth + 1));
}

function getResponsesImageResultBase64(result: unknown) {
    return collectResponsesImageStrings(result)[0] || "";
}

function collectResponsesImageBase64(item: Record<string, unknown>) {
    const values: string[] = [];
    const result = getResponsesImageResultBase64(item.result);
    if (result) values.push(result);
    values.push(...collectResponsesImageStrings(item));
    return Array.from(new Set(values));
}

function parseResponsesPayload(payload: ResponsesApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.output
            ?.filter((item) => item.type === "image_generation_call")
            .flatMap((item) => collectResponsesImageBase64(item))
            .filter(Boolean)
            .map((b64) => ({ id: nanoid(), dataUrl: normalizeBase64Image(b64, mime) })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("Responses API 没有返回图片", payload);
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
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

async function withTimeout<T>(timeoutSeconds: number, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await run(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new Error(timeoutError(timeoutSeconds));
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function isTransientStatus(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number) {
    return 700 * attempt;
}

async function requestWithTransientRetry(run: () => Promise<Response>, retries = 2) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await run();
            if (!isTransientStatus(response.status) || attempt === retries) return response;
            lastError = new Error(`上游接口临时不可用：${response.status}`);
        } catch (error) {
            lastError = error;
            if (attempt === retries) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function parseServerSentEventBlock(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return null;
    return JSON.parse(data) as Record<string, unknown>;
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) throw new ImageRequestError("接口未返回可读取的流式响应", `${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];

    const processBlock = (block: string) => {
        let event: Record<string, unknown> | null = null;
        try {
            event = parseServerSentEventBlock(block);
        } catch (error) {
            throw new ImageRequestError(error instanceof Error ? error.message : "流式响应解析失败", block);
        }
        if (!event) return;
        events.push(event);
        const error = event.error;
        if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { message?: unknown }).message === "string") {
            throw new ImageRequestError((error as { message: string }).message, event);
        }
        onEvent(event);
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
        const responsePayload = event.response;
        if (responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)) {
            completedPayload = responsePayload as ResponsesApiResponse;
        }
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "image_generation_call") {
            output.push(item as Record<string, unknown>);
        }
    });
    try {
        return parseResponsesPayload(completedPayload || { output }, mime);
    } catch (error) {
        if (!partialImages.length) {
            throw new ImageRequestError(error instanceof Error ? error.message : "Responses API 没有返回图片", {
                completedPayload,
                output,
                events,
            });
        }
        const lastPartialImage = partialImages[partialImages.length - 1];
        return [{ id: nanoid(), dataUrl: normalizeBase64Image(lastPartialImage, mime) }];
    }
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
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

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = (config.systemPrompts.text || config.systemPrompt).trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

async function requestImageGenerationSingle(config: AiConfig, prompt: string, params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
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
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams): Promise<GeneratedImage[]> {
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
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));

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
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
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

function createResponsesInput(prompt: string, inputImageDataUrls: string[]) {
    const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`;
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

async function requestResponsesSingle(config: AiConfig, prompt: string, inputImageDataUrls: string[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const body: Record<string, unknown> = {
        model: config.model,
        input: createResponsesInput(withSystemPrompt(config, prompt), inputImageDataUrls),
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
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseResponsesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ResponsesApiResponse;
            return { images: parseResponsesPayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestAndParseImages(config: AiConfig, endpoint: string, requestBody: unknown, timeoutSeconds: number, fetchResponse: () => Promise<Response>, parseResponse: (response: Response) => Promise<ParsedImageResponse>) {
    const startedAt = Date.now();
    let logged = false;
    try {
        const response = await fetchResponse();
        if (!response.ok) {
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

async function requestImages(config: AiConfig, prompt: string, references: ReferenceImage[]): Promise<GeneratedImage[]> {
    const params = createImageRequestParams(config);
    const inputImageDataUrls = references.length ? await Promise.all(references.map((image) => imageToDataUrl(image))) : [];
    const useConcurrentSingleRequests = config.apiMode === "responses" || config.codexCli || config.streamImages;
    if (params.n > 1 && useConcurrentSingleRequests) {
        const results = await Promise.allSettled(Array.from({ length: params.n }, () => requestImages({ ...config, count: "1" }, prompt, references)));
        const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (images.length) return images;
        const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstError?.reason || new Error("所有并发请求均失败");
    }
    if (config.apiMode === "responses") return requestResponsesSingle(config, prompt, inputImageDataUrls, params);
    return references.length ? requestImageEditSingle(config, prompt, references, params) : requestImageGenerationSingle(config, prompt, params);
}

export async function requestGeneration(config: AiConfig, prompt: string) {
    try {
        const images = await requestImages(config, prompt, []);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[]) {
    try {
        const images = await requestImages(config, prompt, references);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
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
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
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
