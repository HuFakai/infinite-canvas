"use client";

import { saveAs } from "file-saver";

import { defaultConfig, normalizeLocalChannels, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { defaultUserStorageProvider, type UserStorageProvider } from "@/services/image-storage";

export type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    storage: UserStorageProvider;
};

export type AppConfigPreview = {
    file: AppConfigFile;
    channelCount: number;
    modelCount: number;
    imageModel: string;
    textModel: string;
    includesStorage: boolean;
};

export function exportSafeAppConfig(config: AiConfig, storage: UserStorageProvider) {
    const safeChannels = normalizeLocalChannels(config).map((channel) => ({ ...channel, apiKey: "" }));
    const safeConfig: AiConfig = {
        ...config,
        apiKey: "",
        baseUrl: safeChannels[0]?.baseUrl || config.baseUrl,
        localChannels: safeChannels,
        publicChannels: [],
        syncModelConfig: false,
        syncStorageConfig: false,
    };
    const safeStorage = {
        ...storage,
        enabled: false,
        accessKeyId: "",
        secretAccessKey: "",
    };
    const payload: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config: safeConfig, storage: safeStorage };
    saveAs(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.safe.json");
}

export async function readAppConfigFile(file: File): Promise<AppConfigPreview> {
    let value: unknown;
    try {
        value = JSON.parse(await file.text());
    } catch {
        throw new Error("配置文件不是有效的 JSON");
    }
    if (!isRecord(value) || value.app !== "infinite-canvas" || value.version !== 1 || !isRecord(value.config)) throw new Error("配置文件版本或结构不受支持");
    const importedConfig = { ...defaultConfig, ...(value.config as Partial<AiConfig>) };
    const channels = normalizeLocalChannels(importedConfig);
    const storage = isRecord(value.storage) ? ({ ...defaultUserStorageProvider(), ...value.storage } as UserStorageProvider) : defaultUserStorageProvider();
    const parsed: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "", config: { ...importedConfig, localChannels: channels }, storage };
    return {
        file: parsed,
        channelCount: channels.length,
        modelCount: new Set(channels.flatMap((channel) => channel.models)).size,
        imageModel: parsed.config.imageModel,
        textModel: parsed.config.textModel,
        includesStorage: Boolean(storage.endpoint || storage.bucket || storage.publicBaseUrl),
    };
}

export function applyAppConfigFile(file: AppConfigFile, currentConfig: AiConfig, currentStorage: UserStorageProvider) {
    const currentChannels = normalizeLocalChannels(currentConfig);
    const localChannels = normalizeLocalChannels(file.config).map((channel) => {
        const current = currentChannels.find((item) => item.id === channel.id);
        return { ...channel, apiKey: current?.apiKey || "" };
    });
    const config: AiConfig = {
        ...defaultConfig,
        ...file.config,
        apiKey: localChannels[0]?.apiKey || currentConfig.apiKey,
        localChannels,
        publicChannels: currentConfig.publicChannels,
        syncModelConfig: false,
        syncStorageConfig: false,
    };
    const storage: UserStorageProvider = {
        ...defaultUserStorageProvider(),
        ...file.storage,
        enabled: false,
        accessKeyId: currentStorage.accessKeyId,
        secretAccessKey: currentStorage.secretAccessKey,
    };
    useConfigStore.setState({ config });
    return storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
