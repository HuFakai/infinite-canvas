"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { apiGet } from "@/services/api/request";
import type { AdminPublicSettings } from "@/services/api/admin";

export type LocalModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    localChannels: LocalModelChannel[];
    imageChannelId: string;
    videoChannelId: string;
    textChannelId: string;
    activeChannelId: string;
    apiMode: "images" | "responses";
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    timeout: string;
    streamImages: boolean;
    streamPartialImages: string;
    responseFormatB64Json: boolean;
    codexCli: boolean;
    videoSeconds: string;
    vquality: string;
    systemPrompt: string;
    systemPrompts: {
        image: string;
        video: string;
        text: string;
        workflow: string;
        workflowAgent: string;
    };
    syncModelConfig: boolean;
    syncStorageConfig: boolean;
    models: string[];
    publicChannels: AdminPublicSettings["modelChannel"]["channels"];
    quality: string;
    size: string;
    outputFormat: "png" | "jpeg" | "webp";
    outputCompression: string;
    moderation: "auto" | "low";
    count: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    localChannels: [],
    imageChannelId: "",
    videoChannelId: "",
    textChannelId: "",
    activeChannelId: "",
    apiMode: "images",
    model: "gpt-image-2",
    imageModel: "gpt-image-2",
    videoModel: "grok-imagine-video",
    textModel: "gpt-5.5",
    timeout: "600",
    streamImages: false,
    streamPartialImages: "1",
    responseFormatB64Json: true,
    codexCli: false,
    videoSeconds: "6",
    vquality: "720",
    systemPrompt: "",
    systemPrompts: { image: "", video: "", text: "", workflow: "", workflowAgent: "" },
    syncModelConfig: false,
    syncStorageConfig: false,
    models: [],
    publicChannels: [],
    quality: "auto",
    size: "1:1",
    outputFormat: "png",
    outputCompression: "100",
    moderation: "auto",
    count: "1",
};

type ConfigStore = {
    config: AiConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

function resolveEffectiveConfig(config: AiConfig, modelChannel: AdminPublicSettings["modelChannel"] | null) {
    const channelMode = modelChannel?.allowCustomChannel ? config.channelMode : "remote";
    if (channelMode === "local" || !modelChannel) return { ...normalizeLocalConfig(config), channelMode };
    const models = modelChannel.availableModels;
    const fallbackModel = modelChannel.defaultModel || models[0] || "";
    const imageChannelId = validChannelId(config.imageChannelId, modelChannel.channels, config.imageModel) || channelIdForModel(modelChannel.channels, modelChannel.defaultImageModel || fallbackModel);
    const videoChannelId = validChannelId(config.videoChannelId, modelChannel.channels, config.videoModel) || channelIdForModel(modelChannel.channels, modelChannel.defaultVideoModel || fallbackModel);
    const textChannelId = validChannelId(config.textChannelId, modelChannel.channels, config.textModel) || channelIdForModel(modelChannel.channels, modelChannel.defaultTextModel || fallbackModel);
    return {
        ...config,
        channelMode,
        models,
        publicChannels: modelChannel.channels || [],
        model: models.includes(config.model) ? config.model : fallbackModel,
        imageModel: models.includes(config.imageModel) ? config.imageModel : modelChannel.defaultImageModel || fallbackModel,
        videoModel: models.includes(config.videoModel) ? config.videoModel : modelChannel.defaultVideoModel || fallbackModel,
        textModel: models.includes(config.textModel) ? config.textModel : modelChannel.defaultTextModel || fallbackModel,
        imageChannelId,
        videoChannelId,
        textChannelId,
        systemPrompt: modelChannel.systemPrompts?.image || modelChannel.systemPrompt,
        systemPrompts: modelChannel.systemPrompts || defaultConfig.systemPrompts,
    };
}

function normalizeLocalConfig(config: AiConfig) {
    const localChannels = normalizeLocalChannels(config);
    const models = Array.from(new Set(localChannels.flatMap((channel) => channel.models)));
    return { ...config, localChannels, models };
}

export function normalizeLocalChannels(config: Partial<AiConfig>) {
    const channels = Array.isArray(config.localChannels) ? config.localChannels : [];
    const normalized = channels.map((channel, index) => ({
        id: channel.id || `local-${index + 1}`,
        name: channel.name || `本地渠道 ${index + 1}`,
        baseUrl: channel.baseUrl || "",
        apiKey: channel.apiKey || "",
        models: Array.isArray(channel.models) ? channel.models.filter(Boolean) : [],
    }));
    if (!normalized.length) {
        normalized.push({ id: "local-default", name: "本地直连", baseUrl: config.baseUrl || defaultConfig.baseUrl, apiKey: config.apiKey || "", models: Array.isArray(config.models) ? config.models.filter(Boolean) : [] });
    }
    return normalized;
}

function validChannelId(channelId: string, channels: AdminPublicSettings["modelChannel"]["channels"], model: string) {
    return channels.some((channel) => channel.id === channelId && channel.models.includes(model)) ? channelId : "";
}

function channelIdForModel(channels: AdminPublicSettings["modelChannel"]["channels"], model: string) {
    return channels.find((channel) => channel.models.includes(model))?.id || channels[0]?.id || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = localChannelForActiveModel({ ...config, model });
    return Boolean(model.trim()) && (config.channelMode === "remote" || Boolean(channel?.baseUrl.trim() && channel?.apiKey.trim()));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings") });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config }),
            merge: (persisted, current) => {
                const config = { ...defaultConfig, ...((persisted as Partial<ConfigStore>).config || {}) };
                const localChannels = normalizeLocalChannels(config);
                return {
                    ...current,
                    config: {
                        ...config,
                        localChannels,
                        baseUrl: localChannels[0]?.baseUrl || config.baseUrl,
                        apiKey: localChannels[0]?.apiKey || config.apiKey,
                        imageChannelId: config.imageChannelId || localChannels[0]?.id || "",
                        videoChannelId: config.videoChannelId || localChannels[0]?.id || "",
                        textChannelId: config.textChannelId || localChannels[0]?.id || "",
                        activeChannelId: config.activeChannelId || "",
                        channelMode: config.channelMode || "remote",
                        apiMode: config.apiMode === "responses" ? "responses" : "images",
                        imageModel: config.imageModel || config.model,
                        videoModel: config.videoModel || "grok-imagine-video",
                        textModel: config.textModel || config.model,
                        timeout: config.timeout || "600",
                        streamPartialImages: config.streamPartialImages || "1",
                        responseFormatB64Json: config.responseFormatB64Json !== false,
                        outputFormat: ["jpeg", "webp"].includes(config.outputFormat) ? config.outputFormat : "png",
                        outputCompression: config.outputCompression || "100",
                        moderation: config.moderation === "low" ? "low" : "auto",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        systemPrompts: { ...defaultConfig.systemPrompts, ...(config.systemPrompts || {}) },
                        syncModelConfig: config.syncModelConfig === true,
                        syncStorageConfig: config.syncStorageConfig === true,
                    },
                };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel || null);
    return useMemo(() => resolveEffectiveConfig(config, modelChannel), [config, modelChannel]);
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const apiBaseUrl = normalizedBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

export function channelIdForActiveModel(config: AiConfig) {
    if (config.activeChannelId) return config.activeChannelId;
    if (config.model === config.videoModel) return config.videoChannelId;
    if (config.model === config.textModel) return config.textChannelId;
    return config.imageChannelId;
}

export function localChannelForActiveModel(config: AiConfig) {
    const channels = normalizeLocalChannels(config);
    const preferredId = channelIdForActiveModel(config);
    return channels.find((channel) => channel.id === preferredId && channel.models.includes(config.model)) || channels.find((channel) => channel.models.includes(config.model)) || channels.find((channel) => channel.id === preferredId) || channels[0];
}
