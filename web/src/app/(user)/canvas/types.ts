export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeMetadata = {
    content?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    startedAt?: number;
    durationMs?: number;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    imageChannelId?: string;
    videoChannelId?: string;
    textChannelId?: string;
    size?: string;
    quality?: string;
    outputFormat?: "png" | "jpeg" | "webp";
    outputCompression?: string;
    moderation?: "auto" | "low";
    count?: number;
    seconds?: string;
    vquality?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    inputOrder?: string[];
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
    source?: "node" | "asset" | "library";
    assetId?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant";
    mode: "ask" | "image";
    text: string;
    isLoading?: boolean;
    references?: CanvasAssistantReference[];
    images?: CanvasAssistantImage[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState = {
    type: "node";
    x: number;
    y: number;
    nodeId: string;
};
