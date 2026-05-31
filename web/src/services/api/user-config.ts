import { apiDelete, apiGet, apiPost } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";
import type { UserStorageProvider } from "@/services/image-storage";

export type UserConfigPayload = {
    modelConfig?: Partial<AiConfig>;
    storageProvider?: Partial<UserStorageProvider>;
    canvasData?: unknown;
    imageHistory?: unknown;
    syncCapabilities?: {
        userData?: boolean;
        workflows?: boolean;
        assets?: boolean;
    };
};

export type StorageCapacityResult = {
    bytes: number;
    limitBytes: number;
    overLimit: boolean;
    checkedAt: string;
    providerName: string;
};

export async function fetchUserConfig(token: string) {
    return apiGet<UserConfigPayload>("/api/v1/user-config", undefined, token);
}

export async function syncUserModelConfig(token: string, config: AiConfig) {
    return apiPost<UserConfigPayload>("/api/v1/user-config/model", { config }, token);
}

export async function syncUserStorageProvider(token: string, provider: UserStorageProvider) {
    return apiPost<UserConfigPayload>("/api/v1/user-config/storage", { provider: toStorageProviderPayload(provider) }, token);
}

export async function measureUserStorageProvider(token: string, provider: UserStorageProvider) {
    return apiPost<StorageCapacityResult>("/api/v1/storage/measure", { provider: toStorageProviderPayload(provider) }, token);
}

export async function fetchUserCanvasData<T>(token: string) {
    return apiGet<T>("/api/v1/user-data/canvas", undefined, token);
}

export async function syncUserCanvasData<T>(token: string, data: T) {
    return apiPost<T>("/api/v1/user-data/canvas", { data }, token);
}

export async function fetchUserImageHistory<T>(token: string) {
    return apiGet<T>("/api/v1/user-data/image-history", undefined, token);
}

export async function syncUserImageHistory<T>(token: string, data: T) {
    return apiPost<T>("/api/v1/user-data/image-history", { data }, token);
}

export async function fetchUserAssetData<T>(token: string) {
    return apiGet<T>("/api/v1/user-data/assets", undefined, token);
}

export async function syncUserAssetData<T>(token: string, data: T) {
    return apiPost<T>("/api/v1/user-data/assets", { data }, token);
}

export type CreativeWorkflowRecord<T = unknown> = {
    id: string;
    ownerUserId?: string;
    scope: "private" | "public";
    name: string;
    category: string;
    description: string;
    data: T;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    editable: boolean;
};

export async function fetchUserWorkflows<T>(token: string) {
    return apiGet<Array<CreativeWorkflowRecord<T>>>("/api/v1/workflows", undefined, token);
}

export async function saveUserWorkflow<T>(token: string, workflow: CreativeWorkflowRecord<T>) {
    return apiPost<CreativeWorkflowRecord<T>>("/api/v1/workflows", workflow, token);
}

export async function deleteUserWorkflow(token: string, id: string) {
    return apiDelete<boolean>(`/api/v1/workflows/${encodeURIComponent(id)}`, token);
}

export type WorkflowAgentDraftResponse<T = unknown> = {
    draft: T;
    warnings: string[];
    model: string;
};

export async function draftUserWorkflow<T>(
    token: string,
    payload: {
        prompt: string;
        scope: "private" | "public";
        model?: string;
        channelId?: string;
        channelMode?: "remote" | "local";
        baseUrl?: string;
        apiKey?: string;
        references?: string[];
    },
) {
    return apiPost<WorkflowAgentDraftResponse<T>>("/api/v1/workflows/agent-draft", payload, token);
}

function toStorageProviderPayload(provider: UserStorageProvider) {
    return {
        name: provider.name,
        type: provider.type || "s3",
        endpoint: provider.endpoint,
        region: provider.region || "auto",
        bucket: provider.bucket,
        accessKeyId: provider.accessKeyId,
        secretAccessKey: provider.secretAccessKey,
        publicBaseUrl: provider.publicBaseUrl,
        pathPrefix: provider.pathPrefix,
    };
}
