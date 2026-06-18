import { apiDelete, apiGet, apiPost, compactApiParams } from "@/services/api/request";
import type { Prompt, PromptListResponse } from "@/services/api/prompts";

export type AdminPromptCategory = {
    category: string;
    name: string;
    description: string;
    file: string;
    githubUrl: string;
    remote: boolean;
};

export type AdminAICallLog = {
    id: string;
    userId: string;
    userDisplayName: string;
    endpoint: string;
    method: string;
    model: string;
    channelId: string;
    channelName: string;
    status: number;
    durationMs: number;
    credits: number;
    requestBody: string;
    responseBody: string;
    error: string;
    createdAt: string;
};

export type AdminAICallLogListResponse = {
    items: AdminAICallLog[];
    total: number;
};

export type AdminUserQuery = {
    keyword?: string;
    page?: number;
    pageSize?: number;
};

export async function fetchAdminAICallLogs(token: string, query: AdminUserQuery = {}) {
    return apiGet<AdminAICallLogListResponse>("/api/admin/ai-logs", compactApiParams(query), token);
}

export async function deleteAdminAICallLogs(token: string, olderThanDays = 7) {
    return apiDelete<{ removedFiles: number }>(`/api/admin/ai-logs?olderThanDays=${encodeURIComponent(String(olderThanDays))}`, token);
}

export async function fetchAdminPromptCategories(token: string) {
    return apiGet<AdminPromptCategory[]>("/api/admin/prompt-categories", undefined, token);
}

export async function syncAdminPromptCategory(token: string, category: string) {
    return apiPost<AdminPromptCategory[]>("/api/admin/prompt-categories/sync", { category }, token);
}

export type AdminPromptQuery = {
    keyword?: string;
    category?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export type AdminAsset = {
    id: string;
    title: string;
    type: "text" | "image";
    coverUrl: string;
    tags: string[];
    category: string;
    description: string;
    content: string;
    url: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminAssetListResponse = {
    items: AdminAsset[];
    tags: string[];
    total: number;
};

export async function fetchAdminPrompts(token: string, query: AdminPromptQuery = {}) {
    return apiGet<PromptListResponse>("/api/admin/prompts", compactApiParams(query), token);
}

export async function saveAdminPrompt(token: string, prompt: Partial<Prompt>) {
    return apiPost<Prompt>("/api/admin/prompts", prompt, token);
}

export async function deleteAdminPrompt(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/prompts/${encodeURIComponent(id)}`, token);
}

export async function deleteAdminPrompts(token: string, ids: string[]) {
    return apiPost<boolean>("/api/admin/prompts/batch-delete", { ids }, token);
}

export type AdminAssetQuery = {
    keyword?: string;
    type?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export async function fetchAdminAssets(token: string, query: AdminAssetQuery = {}) {
    return apiGet<AdminAssetListResponse>("/api/admin/assets", compactApiParams(query), token);
}

export async function saveAdminAsset(token: string, asset: Partial<AdminAsset>) {
    return apiPost<AdminAsset>("/api/admin/assets", asset, token);
}

export async function deleteAdminAsset(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/assets/${encodeURIComponent(id)}`, token);
}

export type AdminModelChannel = {
    id: string;
    protocol: "openai";
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    weight: number;
    timeout: number;
    enabled: boolean;
    remark: string;
};

export type AdminPublicModelChannelSettings = {
    availableModels: string[];
    modelCosts: AdminModelCost[];
    channels: AdminPublicModelChannelInfo[];
    defaultModel: string;
    defaultImageModel: string;
    defaultTextModel: string;
    systemPrompt: string;
    systemPrompts: {
        image: string;
        text: string;
        workflow: string;
        workflowAgent: string;
    };
    allowCustomChannel: boolean;
};

export type AdminPublicModelChannelInfo = {
    id: string;
    name: string;
    baseUrl: string;
    models: string[];
    weight: number;
    timeout: number;
    enabled: boolean;
    remark: string;
};

export type AdminModelCost = {
    model: string;
    credits: number;
};

export type AdminPublicSettings = {
    site: {
        name: string;
        subtitle: string;
        description: string;
        logoUrl: string;
        faviconUrl: string;
        copyright: string;
    };
    modelChannel: AdminPublicModelChannelSettings;
    auth: {
        allowRegister: boolean;
        linuxDo: {
            enabled: boolean;
        };
        oidc: {
            enabled: boolean;
            displayName: string;
            iconUrl: string;
        };
    };
    membership: {
        enabled: boolean;
        paymentMethods: string[];
        serviceNotice: string;
    };
    storage: {
        mode: string;
        allowUserProvider: boolean;
    };
};

export type AdminStorageProvider = {
    id: string;
    name: string;
    type: "s3";
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    pathPrefix: string;
    weight: number;
    enabled: boolean;
    ownerUserId: string;
    capacityBytes: number;
    capacityCheckedAt: string;
    capacityExceeded: boolean;
};

export type AdminPrivateSettings = {
    channels: AdminModelChannel[];
    promptSync: {
        enabled: boolean;
        cron: string;
    };
    aiLog: {
        localDirectReportEnabled: boolean;
        cleanup: {
            enabled: boolean;
            retentionDays: number;
            cron: string;
        };
    };
    auth: {
        linuxDo: {
            clientId: string;
            clientSecret: string;
        };
        oidc: {
            issuer: string;
            clientId: string;
            clientSecret: string;
            scopes: string;
            usernameClaim: string;
            displayNameClaim: string;
            avatarClaim: string;
        };
    };
    payment: {
        zpay: {
            enabled: boolean;
            pid: string;
            key: string;
            gatewayUrl: string;
            notifyUrl: string;
            returnUrl: string;
        };
        alipay: {
            enabled: boolean;
            appId: string;
            privateKey: string;
            publicKey: string;
            gatewayUrl: string;
            notifyUrl: string;
            returnUrl: string;
            sandbox: boolean;
        };
        wechat: {
            enabled: boolean;
            appId: string;
            mchId: string;
            apiKey: string;
            apiV3Key: string;
            notifyUrl: string;
            serialNo: string;
            mchPrivateKey: string;
        };
    };
    storage: {
        mode: string;
        allowUserProvider: boolean;
        providers: AdminStorageProvider[];
        roundRobinCursor: number;
        capacityCheck: {
            enabled: boolean;
            cron: string;
        };
        capacityLimitBytes: number;
    };
};

export type AdminSettings = {
    public: AdminPublicSettings;
    private: AdminPrivateSettings;
};

export async function fetchAdminSettings(token: string) {
    return apiGet<AdminSettings>("/api/admin/settings", undefined, token);
}

export async function saveAdminSettings(token: string, settings: AdminSettings) {
    return apiPost<AdminSettings>("/api/admin/settings", settings, token);
}

export type AdminChannelActionRequest = {
    index?: number;
    channel: AdminModelChannel;
    model?: string;
};

export async function fetchChannelModels(token: string, payload: AdminChannelActionRequest) {
    return apiPost<string[]>("/api/admin/settings/channel-models", payload, token);
}

export async function testChannelModel(token: string, payload: AdminChannelActionRequest) {
    return apiPost<string>("/api/admin/settings/channel-test", payload, token);
}

export type StorageCapacityResult = {
    bytes: number;
    limitBytes: number;
    overLimit: boolean;
    checkedAt: string;
    providerName: string;
};

export async function measureAdminStorageProvider(token: string, payload: { index: number; provider: AdminStorageProvider }) {
    return apiPost<StorageCapacityResult>("/api/admin/storage/measure", payload, token);
}
