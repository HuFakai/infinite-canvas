"use client";

import { App, Button, Checkbox, Empty, Image, Input, Modal, Select, Space, Switch, Tag, Typography } from "antd";
import { AlertCircle, Bot, CheckCircle2, Copy, Download, Edit3, FilePlus2, Globe2, LoaderCircle, LockKeyhole, Play, Plus, Sparkles, Trash2, WandSparkles } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useEffect, useMemo, useRef, useState } from "react";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteUserWorkflow, draftUserWorkflow, fetchUserConfig, fetchUserWorkflows, saveUserWorkflow, type CreativeWorkflowRecord } from "@/services/api/user-config";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { defaultConfig, localChannelForActiveModel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type WorkflowVariableType = "text" | "textarea" | "number" | "select" | "boolean";

type WorkflowVariable = {
    id: string;
    key: string;
    label: string;
    type: WorkflowVariableType;
    required: boolean;
    defaultValue: string;
    options: string[];
    placeholder?: string;
};

export type WorkflowGenerationConfig = Pick<
    AiConfig,
    "model" | "imageModel" | "imageChannelId" | "quality" | "size" | "count" | "apiMode" | "outputFormat" | "outputCompression" | "moderation" | "timeout" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli"
> & {
    systemPrompt: string;
    promptTemplate: string;
    negativePrompt: string;
};

type CreativeWorkflow = {
    id: string;
    ownerUserId?: string;
    scope: "private" | "public";
    editable?: boolean;
    name: string;
    category: string;
    description: string;
    variables: WorkflowVariable[];
    config: WorkflowGenerationConfig;
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
};

export type WorkflowRunResult = {
    id: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    imageUrl: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    durationMs: number;
    createdAt: number;
};

export type WorkflowExternalTaskStart = {
    taskId: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
};

export type WorkflowExternalTaskSuccess = {
    taskId: string;
    images: WorkflowRunResult[];
    durationMs: number;
    endedAt: number;
};

export type WorkflowExternalTaskFailure = {
    taskId: string;
    error: string;
    durationMs: number;
    endedAt: number;
};

type WorkflowTask = {
    id: string;
    status: "running" | "success" | "failed";
    workflowId: string;
    workflowName: string;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    images: WorkflowRunResult[];
    error?: string;
};

type ImageHistoryLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: WorkflowGenerationConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: Array<{
        id: string;
        dataUrl: string;
        storageKey: string;
        durationMs: number;
        width: number;
        height: number;
        bytes: number;
        mimeType: string;
    }>;
    thumbnails: string[];
    errors: string[];
    categoryIds: string[];
    workflowId: string;
    workflowName: string;
    workflowInputs: Record<string, unknown>;
};

type GenerationCategory = { id: string; name: string; createdAt: number };

const WORKFLOW_STORE_KEY = "infinite-canvas:creative-workflows";
const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const workflowStore = localforage.createInstance({ name: "infinite-canvas", storeName: "creative_workflows" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });

const variableTypeOptions: Array<{ value: WorkflowVariableType; label: string }> = [
    { value: "text", label: "短文本" },
    { value: "textarea", label: "长文本" },
    { value: "number", label: "数字" },
    { value: "select", label: "选项" },
    { value: "boolean", label: "开关" },
];

export function CreativeWorkflowWorkspace({
    embedded = false,
    hideTaskList = false,
    onGenerationLogSaved,
    onWorkflowTaskStarted,
    onWorkflowTaskSuccess,
    onWorkflowTaskFailure,
}: {
    embedded?: boolean;
    hideTaskList?: boolean;
    onGenerationLogSaved?: () => void;
    onWorkflowTaskStarted?: (task: WorkflowExternalTaskStart) => void;
    onWorkflowTaskSuccess?: (task: WorkflowExternalTaskSuccess) => void;
    onWorkflowTaskFailure?: (task: WorkflowExternalTaskFailure) => void;
} = {}) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [workflows, setWorkflows] = useState<CreativeWorkflow[]>([]);
    const [editingWorkflow, setEditingWorkflow] = useState<CreativeWorkflow | null>(null);
    const [runningWorkflow, setRunningWorkflow] = useState<CreativeWorkflow | null>(null);
    const [inputValues, setInputValues] = useState<Record<string, string>>({});
    const [workflowReferences, setWorkflowReferences] = useState<ReferenceImage[]>([]);
    const workflowReferenceInputRef = useRef<HTMLInputElement>(null);
    const [workflowAssetPickerOpen, setWorkflowAssetPickerOpen] = useState(false);
    const [runResults, setRunResults] = useState<WorkflowRunResult[]>([]);
    const [workflowTasks, setWorkflowTasks] = useState<WorkflowTask[]>([]);
    const [now, setNow] = useState(Date.now());
    const [query, setQuery] = useState("");
    const [agentOpen, setAgentOpen] = useState(false);
    const [agentPrompt, setAgentPrompt] = useState("");
    const [agentScope, setAgentScope] = useState<"private" | "public">("private");
    const [agentTextModel, setAgentTextModel] = useState("");
    const [agentTextChannelId, setAgentTextChannelId] = useState("");
    const [agentLoading, setAgentLoading] = useState(false);
    const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
    const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
    const [agentReferences, setAgentReferences] = useState<ReferenceImage[]>([]);
    const agentReferenceInputRef = useRef<HTMLInputElement>(null);
    const [agentAssetPickerOpen, setAgentAssetPickerOpen] = useState(false);
    const workflowSyncEnabledRef = useRef(false);

    const filteredWorkflows = useMemo(() => {
        const text = query.trim().toLowerCase();
        if (!text) return workflows;
        return workflows.filter((workflow) => [workflow.name, workflow.category, workflow.description].some((value) => value.toLowerCase().includes(text)));
    }, [query, workflows]);

    const renderedPrompt = useMemo(() => (runningWorkflow ? renderWorkflowPrompt(runningWorkflow, inputValues) : ""), [inputValues, runningWorkflow]);
    const runningTaskCount = workflowTasks.filter((task) => task.status === "running").length;
    const agentModel = agentTextModel || effectiveConfig.textModel || effectiveConfig.model;
    const agentChannelId = agentTextChannelId || effectiveConfig.textChannelId;
    const agentModelInfo = useMemo(() => describeModelSelection(effectiveConfig, agentModel, agentChannelId), [agentChannelId, agentModel, effectiveConfig]);

    useEffect(() => {
        if (!isUserReady) return;
        void refreshWorkflows();
    }, [isUserReady, token]);

    useEffect(() => {
        if (!agentTextModel && (effectiveConfig.textModel || effectiveConfig.model)) setAgentTextModel(effectiveConfig.textModel || effectiveConfig.model);
        if (!agentTextChannelId && effectiveConfig.textChannelId) setAgentTextChannelId(effectiveConfig.textChannelId);
    }, [agentTextChannelId, agentTextModel, effectiveConfig.model, effectiveConfig.textChannelId, effectiveConfig.textModel]);

    useEffect(() => {
        if (!runningTaskCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [runningTaskCount]);

    const refreshWorkflows = async () => {
        if (token) {
            try {
                const config = await fetchUserConfig(token);
                workflowSyncEnabledRef.current = config.syncCapabilities?.workflows === true;
                if (!workflowSyncEnabledRef.current) throw new Error("workflow sync unavailable");
                const remote = await fetchUserWorkflows<CreativeWorkflow>(token);
                const workflows = remote.map(recordToWorkflow).sort((a, b) => b.updatedAt - a.updatedAt);
                if (workflows.length) {
                    setWorkflows(workflows);
                    await workflowStore.setItem(WORKFLOW_STORE_KEY, workflows);
                    return;
                }
                const local = await workflowStore.getItem<CreativeWorkflow[]>(WORKFLOW_STORE_KEY);
                const seed = local?.length ? local.map(normalizeWorkflow) : [createStarterWorkflow(effectiveConfig)];
                const saved = await Promise.all(seed.map((workflow) => saveUserWorkflow(token, workflowToRecord(normalizeWorkflow(workflow)))));
                setWorkflows(saved.map(recordToWorkflow).sort((a, b) => b.updatedAt - a.updatedAt));
                return;
            } catch {
                // Use local workflows when account sync is unavailable.
            }
        }
        const stored = await workflowStore.getItem<CreativeWorkflow[]>(WORKFLOW_STORE_KEY);
        if (stored?.length) {
            setWorkflows(stored.map(normalizeWorkflow).sort((a, b) => b.updatedAt - a.updatedAt));
            return;
        }
        const seed = [createStarterWorkflow(effectiveConfig)];
        setWorkflows(seed);
        await workflowStore.setItem(WORKFLOW_STORE_KEY, seed);
    };

    const saveWorkflows = async (items: CreativeWorkflow[]) => {
        const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
        setWorkflows(sorted);
        await workflowStore.setItem(WORKFLOW_STORE_KEY, sorted);
    };

    const openRunner = (workflow: CreativeWorkflow) => {
        setRunningWorkflow(workflow);
        setInputValues(createDefaultInputValues(workflow));
        setWorkflowReferences([]);
    };

    const closeRunner = () => {
        setRunningWorkflow(null);
    };

    const addWorkflowReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setWorkflowReferences((value) => [...value, ...next]);
    };

    const removeWorkflowReference = async (id: string) => {
        const reference = workflowReferences.find((item) => item.id === id);
        setWorkflowReferences((value) => value.filter((item) => item.id !== id));
        if (reference?.storageKey && isDisposableReferenceFile(reference) && !referenceUsedByWorkflowTask(reference, workflowTasks)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const addAgentReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setAgentReferences((value) => [...value, ...next]);
    };

    const removeAgentReference = async (id: string) => {
        const reference = agentReferences.find((item) => item.id === id);
        setAgentReferences((value) => value.filter((item) => item.id !== id));
        if (reference?.storageKey && isDisposableReferenceFile(reference)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const cleanupAgentReferences = async () => {
        const keys = agentReferences.filter(isDisposableReferenceFile).map((item) => item.storageKey).filter((key): key is string => Boolean(key));
        setAgentReferences([]);
        if (keys.length) await deleteStoredImages(keys).catch((error) => message.error(error instanceof Error ? error.message : "参考图文件删除失败"));
    };

    const insertWorkflowAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setInputValues((value) => ({ ...value, [runningWorkflow?.variables[0]?.key || "asset_text"]: text }));
            setWorkflowAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流参考图");
            return;
        }
        setWorkflowReferences((value) => [
            ...value,
            {
                id: nanoid(),
                name: payload.title,
                type: payload.mimeType || "image/png",
                dataUrl: payload.dataUrl,
                storageKey: payload.storageKey,
                source: payload.source === "asset" ? "asset" : "library",
                assetId: payload.assetId,
                temporary: false,
            },
        ]);
        setWorkflowAssetPickerOpen(false);
    };

    const insertAgentAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setAgentPrompt((value) => (value.trim() ? `${value.trim()}\n\n${text}` : text));
            setAgentAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流 Agent 参考图");
            return;
        }
        setAgentReferences((value) => [
            ...value,
            {
                id: nanoid(),
                name: payload.title,
                type: payload.mimeType || "image/png",
                dataUrl: payload.dataUrl,
                storageKey: payload.storageKey,
                source: payload.source === "asset" ? "asset" : "library",
                assetId: payload.assetId,
                temporary: false,
            },
        ]);
        setAgentAssetPickerOpen(false);
    };

    const saveWorkflow = async (workflow: CreativeWorkflow) => {
        if (!workflow.name.trim()) {
            message.error("请输入工作流名称");
            return;
        }
        if (!workflow.config.promptTemplate.trim()) {
            message.error("请输入提示词模板");
            return;
        }
        const now = Date.now();
        let normalized = normalizeWorkflow({ ...workflow, name: workflow.name.trim(), category: workflow.category.trim(), updatedAt: now, createdAt: workflow.createdAt || now });
        try {
            if (token && workflowSyncEnabledRef.current) {
                normalized = recordToWorkflow(await saveUserWorkflow(token, workflowToRecord(normalized)));
                await refreshWorkflows();
            } else {
                await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            }
        } catch (error) {
            await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，已先保存到本地。请重启后端后再同步到账号。" : "远端保存失败，已先保存到本地");
        }
        if (agentDraft?.id === workflow.id) {
            await cleanupAgentReferences();
            setAgentDraft(null);
        }
        setEditingWorkflow(null);
        message.success("工作流已保存");
    };

    const duplicateWorkflow = async (workflow: CreativeWorkflow) => {
        const now = Date.now();
        const copy = normalizeWorkflow({ ...workflow, id: nanoid(), ownerUserId: undefined, editable: true, scope: "private", name: `${workflow.name} 副本`, createdAt: now, updatedAt: now, lastRunAt: undefined });
        try {
            if (token && workflowSyncEnabledRef.current) {
                await saveUserWorkflow(token, workflowToRecord(copy));
                await refreshWorkflows();
            } else {
                await saveWorkflows([copy, ...workflows]);
            }
        } catch (error) {
            await saveWorkflows([copy, ...workflows]);
            message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，副本已先保存到本地。请重启后端。" : "远端复制失败，副本已先保存到本地");
        }
    };

    const deleteWorkflow = (workflow: CreativeWorkflow) => {
        modal.confirm({
            title: "删除工作流",
            content: `确定删除「${workflow.name}」吗？本地模板会被移除，已生成的图片历史不受影响。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    if (token && workflowSyncEnabledRef.current) {
                        await deleteUserWorkflow(token, workflow.id);
                        await refreshWorkflows();
                    } else {
                        await saveWorkflows(workflows.filter((item) => item.id !== workflow.id));
                    }
                } catch (error) {
                    await saveWorkflows(workflows.filter((item) => item.id !== workflow.id));
                    message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，已先从本地移除。请重启后端。" : "远端删除失败，已先从本地移除");
                }
                if (runningWorkflow?.id === workflow.id) setRunningWorkflow(null);
            },
        });
    };

    const runWorkflowAgent = async () => {
        const text = agentPrompt.trim();
        if (!text) {
            message.error("请输入工作流需求");
            return;
        }
        if (!token) {
            message.warning("请先登录后使用工作流创建 Agent");
            return;
        }
        setAgentLoading(true);
        try {
            const textModel = agentTextModel || effectiveConfig.textModel || effectiveConfig.model;
            const textChannelId = agentTextChannelId || effectiveConfig.textChannelId;
            const textConfig = { ...effectiveConfig, model: textModel, textModel, textChannelId, activeChannelId: textChannelId };
            if (!isAiConfigReady(textConfig, textModel)) {
                openConfigDialog(true);
                return;
            }
            const localChannel = effectiveConfig.channelMode === "local" ? localChannelForActiveModel(textConfig) : null;
            const referenceDataUrls = await Promise.all(agentReferences.map((image) => imageToDataUrl(image)));
            const result = await draftUserWorkflow<Partial<CreativeWorkflow>>(token, {
                prompt: text,
                scope: agentScope,
                model: textModel,
                channelId: textChannelId,
                channelMode: effectiveConfig.channelMode,
                baseUrl: localChannel?.baseUrl,
                apiKey: localChannel?.apiKey,
                references: referenceDataUrls.filter(Boolean),
            });
            setAgentDraft(normalizeAgentDraft(result.draft, effectiveConfig, agentScope));
            setAgentWarnings(result.warnings || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作流 Agent 生成失败");
        } finally {
            setAgentLoading(false);
        }
    };

    const applyAgentDraft = () => {
        if (!agentDraft) return;
        setEditingWorkflow(agentDraft);
        setAgentOpen(false);
    };

    const runWorkflow = async () => {
        if (!runningWorkflow) return;
        const missing = runningWorkflow.variables.find((item) => item.required && !String(inputValues[item.key] || "").trim());
        if (missing) {
            message.error(`请填写 ${missing.label}`);
            return;
        }
        const runtime = resolveWorkflowRuntime(runningWorkflow, effectiveConfig);
        const model = runtime.model;
        const runConfig = buildRunConfig(effectiveConfig, runningWorkflow.config, runtime);
        if (!isAiConfigReady(runConfig, model)) {
            message.warning("请先完成 API 配置");
            openConfigDialog(true);
            return;
        }

        const startedAt = Date.now();
        const performanceStartedAt = performance.now();
        const count = Math.max(1, Math.min(10, Number(runConfig.count) || 1));
        const taskId = nanoid();
        const taskConfig = { ...runningWorkflow.config, model, imageModel: model, imageChannelId: runtime.channelId, apiMode: runtime.apiMode };
        const promptSnapshot = renderedPrompt;
        const inputSnapshot = { ...inputValues };
        onWorkflowTaskStarted?.({
            taskId,
            workflowId: runningWorkflow.id,
            workflowName: runningWorkflow.name,
            prompt: promptSnapshot,
            inputs: inputSnapshot,
            references: workflowReferences,
            model,
            apiMode: runtime.apiMode,
            config: taskConfig,
            count,
            startedAt,
        });
        setWorkflowTasks((value) => [
            {
                id: taskId,
                status: "running",
                workflowId: runningWorkflow.id,
                workflowName: runningWorkflow.name,
                prompt: promptSnapshot,
                inputs: inputSnapshot,
                references: workflowReferences,
                model,
                apiMode: runtime.apiMode,
                config: taskConfig,
                count,
                startedAt,
                images: [],
            },
            ...value,
        ]);
        void executeWorkflowTask({ taskId, workflow: runningWorkflow, prompt: promptSnapshot, inputSnapshot, references: workflowReferences, runConfig, taskConfig, model, count, startedAt, performanceStartedAt });
        message.success("工作流任务已开始");
    };

    const executeWorkflowTask = async ({
        taskId,
        workflow,
        prompt,
        inputSnapshot,
        references,
        runConfig,
        taskConfig,
        model,
        count,
        startedAt,
        performanceStartedAt,
    }: {
        taskId: string;
        workflow: CreativeWorkflow;
        prompt: string;
        inputSnapshot: Record<string, string>;
        references: ReferenceImage[];
        runConfig: AiConfig;
        taskConfig: WorkflowGenerationConfig;
        model: string;
        count: number;
        startedAt: number;
        performanceStartedAt: number;
    }) => {
        try {
            const images = await Promise.all(Array.from({ length: count }, () => (references.length ? requestEdit({ ...runConfig, count: "1" }, prompt, references) : requestGeneration({ ...runConfig, count: "1" }, prompt))));
            const flattened = images.flat();
            if (!flattened.length) throw new Error("接口没有返回图片");
            const durationMs = performance.now() - performanceStartedAt;
            const storedImages = await Promise.all(
                flattened.map(async (image) => {
                    const meta = await readImageMeta(image.dataUrl);
                    const stored = await uploadImage(image.dataUrl);
                    const persistedUrl = stored.url || image.dataUrl;
                    return {
                        id: image.id,
                        dataUrl: persistedUrl,
                        displayUrl: stored.url,
                        storageKey: stored.storageKey,
                        durationMs,
                        width: stored.width || meta.width,
                        height: stored.height || meta.height,
                        bytes: stored.bytes || getDataUrlByteSize(image.dataUrl),
                        mimeType: stored.mimeType || meta.mimeType,
                    };
                }),
            );
            const category = await ensureWorkflowCategory(workflow.name);
            const log = buildImageHistoryLog({
                workflow,
                prompt,
                config: taskConfig,
                model,
                images: storedImages,
                durationMs,
                inputs: inputSnapshot,
                references,
                categoryIds: category ? [category.id] : [],
            });
            await imageLogStore.setItem(log.id, serializeHistoryLog(log));
            onGenerationLogSaved?.();
            const finishedAt = Date.now();
            setWorkflows((value) => {
                const next = value.map((item) => (item.id === workflow.id ? { ...item, lastRunAt: finishedAt, updatedAt: finishedAt } : item)).sort((a, b) => b.updatedAt - a.updatedAt);
                void workflowStore.setItem(WORKFLOW_STORE_KEY, next);
                return next;
            });
            if (token && workflowSyncEnabledRef.current && workflow.editable !== false) void saveUserWorkflow(token, workflowToRecord({ ...workflow, lastRunAt: finishedAt, updatedAt: finishedAt })).catch(() => {});
            setRunningWorkflow((value) => (value?.id === workflow.id ? { ...value, lastRunAt: finishedAt, updatedAt: finishedAt } : value));
            const nextResults = storedImages.map((image) => ({
                id: image.id,
                workflowId: workflow.id,
                workflowName: workflow.name,
                prompt,
                imageUrl: image.displayUrl,
                storageKey: image.storageKey,
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                mimeType: image.mimeType,
                durationMs,
                createdAt: finishedAt,
            }));
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "success",
                              endedAt: finishedAt,
                              durationMs,
                              images: nextResults,
                          }
                        : task,
                ),
            );
            setRunResults((value) => [...nextResults, ...value]);
            onWorkflowTaskSuccess?.({ taskId, images: nextResults, durationMs, endedAt: finishedAt });
            message.success("工作流运行完成，结果已写入生图历史");
        } catch (error) {
            const finishedAt = Date.now();
            const messageText = error instanceof Error ? error.message : "工作流运行失败";
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "failed",
                              endedAt: finishedAt,
                              durationMs: finishedAt - startedAt,
                              error: messageText,
                          }
                        : task,
                ),
            );
            onWorkflowTaskFailure?.({ taskId, error: messageText, durationMs: finishedAt - startedAt, endedAt: finishedAt });
            message.error(messageText);
        }
    };

    return (
        <main className={`${embedded ? "h-full" : "h-full overflow-y-auto bg-stone-50 p-4 dark:bg-stone-950"} text-stone-950 dark:text-stone-50`}>
            <div className={`${embedded ? "h-full overflow-y-auto p-4" : "mx-auto max-w-7xl"} flex flex-col gap-4`}>
                <section
                    className={`${embedded ? "border-b border-stone-200 pb-4 dark:border-stone-800" : "rounded-lg border border-stone-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-stone-800 dark:bg-stone-900/70"} flex flex-wrap items-center justify-between gap-3`}
                >
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <WandSparkles className="size-5" />
                            创作工作流
                        </div>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{embedded ? "选择模板并启动任务，结果会写入生图历史。" : "把固定提示词和参数沉淀成模板，每次只填写变量即可批量复用。"}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input.Search allowClear placeholder="搜索名称、分类、描述" className="w-72 max-w-full" value={query} onChange={(event) => setQuery(event.target.value)} />
                        <Button icon={<Bot className="size-4" />} onClick={() => setAgentOpen(true)}>
                            AI 创建
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditingWorkflow(createBlankWorkflow(effectiveConfig))}>
                            新建工作流
                        </Button>
                    </div>
                </section>

                <section className={`${embedded ? "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"} grid gap-3`}>
                    {filteredWorkflows.map((workflow) => (
                        <WorkflowCard key={workflow.id} workflow={workflow} onRun={() => openRunner(workflow)} onEdit={() => setEditingWorkflow(workflow)} onCopy={() => void duplicateWorkflow(workflow)} onDelete={() => deleteWorkflow(workflow)} />
                    ))}
                    {!filteredWorkflows.length ? (
                        <div className="col-span-full rounded-lg border border-dashed border-stone-300 bg-white/70 py-14 dark:border-stone-800 dark:bg-stone-900/60">
                            <Empty description="暂无工作流" />
                        </div>
                    ) : null}
                </section>

                {!hideTaskList && workflowTasks.length ? (
                    <section className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-base font-semibold">
                                <LoaderCircle className={`size-4 ${runningTaskCount ? "animate-spin" : ""}`} />
                                工作流任务
                                <Tag className="m-0">{workflowTasks.length} 个</Tag>
                                {runningTaskCount ? (
                                    <Tag className="m-0" color="processing">
                                        {runningTaskCount} 运行中
                                    </Tag>
                                ) : null}
                            </div>
                            <Button size="small" onClick={() => setWorkflowTasks((value) => value.filter((task) => task.status === "running"))}>
                                清理已完成
                            </Button>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                            {workflowTasks.map((task) => (
                                <WorkflowTaskCard key={task.id} task={task} now={now} onCopyPrompt={() => void navigator.clipboard.writeText(task.prompt)} onDownload={(image, index) => saveAs(image.imageUrl, `workflow-task-${index + 1}.png`)} />
                            ))}
                        </div>
                    </section>
                ) : null}

                {!hideTaskList && runResults.length ? (
                    <section className="space-y-3">
                        <div className="flex items-center gap-2 text-base font-semibold">
                            <Sparkles className="size-4" />
                            最近运行结果
                            <Tag className="m-0">{runResults.length} 张</Tag>
                        </div>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                            {runResults.map((result, index) => (
                                <div key={result.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                                    <Image src={result.imageUrl} alt={result.workflowName} className="aspect-[4/3] object-cover" />
                                    <div className="space-y-1 p-2 text-xs">
                                        <div className="line-clamp-1 font-medium">{result.workflowName}</div>
                                        <div className="flex flex-wrap gap-1 text-stone-500">
                                            <Tag className="m-0 text-[10px]">
                                                {result.width}x{result.height}
                                            </Tag>
                                            <Tag className="m-0 text-[10px]">{formatBytes(result.bytes)}</Tag>
                                            <Tag className="m-0 text-[10px]">{formatDuration(result.durationMs)}</Tag>
                                        </div>
                                        <div className="flex justify-end gap-1">
                                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(result.prompt)} />
                                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => saveAs(result.imageUrl, `workflow-${index + 1}.png`)} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>

            <WorkflowEditorModal
                open={Boolean(editingWorkflow)}
                workflow={editingWorkflow}
                modelConfig={effectiveConfig}
                theme={theme}
                onChange={setEditingWorkflow}
                onCancel={() => setEditingWorkflow(null)}
                onSave={(workflow) => void saveWorkflow(workflow)}
            />
            <Modal title="AI 创建工作流" open={agentOpen} width={980} onCancel={() => setAgentOpen(false)} footer={null} destroyOnHidden>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">描述你要沉淀的创作流程</div>
                            <div className="flex min-w-0 items-center gap-2">
                                <div className="hidden min-w-[220px] max-w-[360px] sm:block">
                                    <ModelPicker
                                        config={effectiveConfig}
                                        fullWidth
                                        value={agentModel}
                                        channelId={agentChannelId}
                                        placeholder="选择 Agent 文本模型"
                                        onChange={(model, channelId) => {
                                            setAgentTextModel(model);
                                            setAgentTextChannelId(channelId || "");
                                        }}
                                        onMissingConfig={() => openConfigDialog(true)}
                                    />
                                </div>
                                <div className="hidden min-w-0 max-w-[220px] truncate rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-300 lg:block" title={`${agentModelInfo.channelName} · ${agentModelInfo.modelName}`}>
                                    {agentModelInfo.channelName}
                                </div>
                                <div className="inline-flex rounded-md border border-stone-300 p-0.5 dark:border-stone-700">
                                    <button type="button" title="个人工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "private" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("private")}>
                                        <LockKeyhole className="size-4" />
                                    </button>
                                    <button type="button" title="公开工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("public")}>
                                        <Globe2 className="size-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="sm:hidden">
                            <ModelPicker
                                config={effectiveConfig}
                                fullWidth
                                value={agentModel}
                                channelId={agentChannelId}
                                placeholder="选择 Agent 文本模型"
                                onChange={(model, channelId) => {
                                    setAgentTextModel(model);
                                    setAgentTextChannelId(channelId || "");
                                }}
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                        </div>
                        <Input.TextArea value={agentPrompt} autoSize={{ minRows: 14, maxRows: 22 }} placeholder="例如：创建一个电商海报工作流，只需要输入产品名称、核心卖点、活动信息，固定商业摄影质感和营销文案结构。" onChange={(event) => setAgentPrompt(event.target.value)} />
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium">参考图</div>
                                    <div className="mt-1 text-xs text-stone-500">可上传样例图，作为创建工作流的视觉参考。</div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="small" onClick={() => setAgentAssetPickerOpen(true)}>
                                        我的素材
                                    </Button>
                                    <Button size="small" onClick={() => agentReferenceInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                            </div>
                            <input
                                ref={agentReferenceInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(event) => {
                                    const input = event.currentTarget;
                                    void addAgentReferences(input.files).finally(() => {
                                        input.value = "";
                                    });
                                }}
                            />
                            {agentReferences.length ? (
                                <div className="mt-3 grid grid-cols-5 gap-2">
                                    {agentReferences.map((image) => (
                                        <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                onClick={() => void removeAgentReference(image.id)}
                                                aria-label="删除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                        <Button block type="primary" loading={agentLoading} icon={<Sparkles className="size-4" />} onClick={() => void runWorkflowAgent()}>
                            生成工作流草稿
                        </Button>
                    </div>
                    <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-sm font-medium">草稿预览</div>
                        {agentDraft ? (
                            <>
                                <div>
                                    <div className="text-base font-semibold">{agentDraft.name}</div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        <Tag className="m-0">{agentDraft.category || "未分类"}</Tag>
                                        <Tag className="m-0">{agentDraft.variables.length} 个变量</Tag>
                                        <Tag className="m-0">{agentDraft.scope === "public" ? "公开" : "个人"}</Tag>
                                    </div>
                                </div>
                                <p className="text-sm text-stone-500 dark:text-stone-400">{agentDraft.description || "暂无描述"}</p>
                                <div className="max-h-60 overflow-y-auto rounded-md bg-stone-100 p-3 text-xs dark:bg-stone-950">
                                    <div className="whitespace-pre-wrap">{agentDraft.config.promptTemplate}</div>
                                </div>
                                {agentWarnings.length ? (
                                    <div className="space-y-1 text-xs text-amber-600 dark:text-amber-300">
                                        {agentWarnings.map((item) => (
                                            <div key={item}>{item}</div>
                                        ))}
                                    </div>
                                ) : null}
                                <Button block type="primary" onClick={applyAgentDraft}>
                                    应用到编辑器
                                </Button>
                            </>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成后在这里预览草稿" />
                        )}
                    </aside>
                </div>
            </Modal>
            <Modal title={runningWorkflow?.name || "运行工作流"} open={Boolean(runningWorkflow)} width={980} onCancel={closeRunner} footer={null} destroyOnHidden>
                {runningWorkflow ? (
                    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="text-sm font-medium">变量输入</div>
                                <div className="mt-3 space-y-3">
                                    {runningWorkflow.variables.map((variable) => (
                                        <WorkflowVariableInput key={variable.id} variable={variable} value={inputValues[variable.key] || ""} onChange={(value) => setInputValues((current) => ({ ...current, [variable.key]: value }))} />
                                    ))}
                                    {!runningWorkflow.variables.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此工作流没有变量" /> : null}
                                </div>
                            </div>
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-sm font-medium">参考图</div>
                                    <div className="flex gap-2">
                                        <Button size="small" onClick={() => setWorkflowAssetPickerOpen(true)}>
                                            我的素材
                                        </Button>
                                        <Button size="small" onClick={() => workflowReferenceInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <input
                                    ref={workflowReferenceInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        const input = event.currentTarget;
                                        void addWorkflowReferences(input.files).finally(() => {
                                            input.value = "";
                                        });
                                    }}
                                />
                                {workflowReferences.length ? (
                                    <div className="mt-3 grid grid-cols-4 gap-2">
                                        {workflowReferences.map((image) => (
                                            <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                                <button
                                                    type="button"
                                                    className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                    onClick={() => void removeWorkflowReference(image.id)}
                                                    aria-label="删除参考图"
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-md border border-dashed border-stone-300 py-5 text-center text-xs text-stone-500 dark:border-stone-800">未添加参考图</div>
                                )}
                            </div>
                            <Button block type="primary" size="large" icon={<Play className="size-4" />} onClick={() => void runWorkflow()}>
                                启动任务
                            </Button>
                        </div>
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="text-sm font-medium">生成提示词预览</span>
                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(renderedPrompt)}>
                                        复制
                                    </Button>
                                </div>
                                <Typography.Paragraph className="!mb-0 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">{renderedPrompt || "填写变量后会在这里预览最终提示词"}</Typography.Paragraph>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <InfoPill label="模型" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).model} />
                                <InfoPill label="接口" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).apiMode === "responses" ? "Responses" : "Images"} />
                                <InfoPill label="尺寸" value={runningWorkflow.config.size || effectiveConfig.size} />
                                <InfoPill label="数量" value={`${runningWorkflow.config.count || "1"} 张`} />
                            </div>
                        </div>
                    </div>
                ) : null}
            </Modal>
            <AssetPickerModal open={agentAssetPickerOpen} defaultTab="my-assets" onInsert={insertAgentAsset} onClose={() => setAgentAssetPickerOpen(false)} />
            <AssetPickerModal open={workflowAssetPickerOpen} defaultTab="my-assets" onInsert={insertWorkflowAsset} onClose={() => setWorkflowAssetPickerOpen(false)} />
        </main>
    );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
    const editable = workflow.editable !== false;
    return (
        <article className="group flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-xl dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700">
            <div className="h-1 bg-gradient-to-r from-stone-900 via-stone-500 to-stone-300 opacity-80 dark:from-stone-100 dark:via-stone-500 dark:to-stone-800" />
            <div className="flex flex-1 flex-col p-3.5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="line-clamp-1 text-base font-semibold">{workflow.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0">{workflow.category || "未分类"}</Tag>
                        <Tag className="m-0">{workflow.variables.length} 个变量</Tag>
                        <Tag className="m-0" color={workflow.scope === "public" ? "blue" : undefined}>
                            {workflow.scope === "public" ? "公开" : "个人"}
                        </Tag>
                    </div>
                </div>
                <Button type="primary" size="small" icon={<Play className="size-3.5" />} onClick={onRun}>
                    运行
                </Button>
            </div>
            <p className="mt-3 line-clamp-2 min-h-10 text-sm text-stone-500 dark:text-stone-400">{workflow.description || "暂无描述"}</p>
            <div className="mt-3 rounded-md bg-stone-100/80 p-3 text-xs text-stone-600 dark:bg-stone-950/80 dark:text-stone-300">
                <div className="line-clamp-5 whitespace-pre-wrap">{workflow.config.promptTemplate}</div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-stone-500">
                <span>{workflow.lastRunAt ? `最近运行 ${formatDate(workflow.lastRunAt)}` : `创建于 ${formatDate(workflow.createdAt)}`}</span>
                <div className="flex gap-1">
                    <Button size="small" disabled={!editable} icon={<Edit3 className="size-3.5" />} onClick={onEdit} />
                    <Button size="small" icon={<FilePlus2 className="size-3.5" />} onClick={onCopy} />
                    <Button size="small" disabled={!editable} danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                </div>
            </div>
            </div>
        </article>
    );
}

function WorkflowTaskCard({ task, now, onCopyPrompt, onDownload }: { task: WorkflowTask; now: number; onCopyPrompt: () => void; onDownload: (image: WorkflowRunResult, index: number) => void }) {
    const elapsedMs = task.status === "running" ? now - task.startedAt : task.durationMs || (task.endedAt || task.startedAt) - task.startedAt;
    const statusView = {
        running: { label: "运行中", color: "processing", icon: <LoaderCircle className="size-4 animate-spin" /> },
        success: { label: "成功", color: "success", icon: <CheckCircle2 className="size-4" /> },
        failed: { label: "失败", color: "error", icon: <AlertCircle className="size-4" /> },
    }[task.status];

    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-start justify-between gap-3 border-b border-stone-200 p-3 dark:border-stone-800">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-stone-500 dark:text-stone-400">{statusView.icon}</span>
                        <div className="truncate font-medium">{task.workflowName}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0" color={statusView.color}>
                            {statusView.label}
                        </Tag>
                        <Tag className="m-0">{formatDuration(elapsedMs)}</Tag>
                        <Tag className="m-0">{formatDate(task.startedAt)}</Tag>
                    </div>
                </div>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopyPrompt}>
                    复制提示词
                </Button>
            </div>
            <div className="space-y-3 p-3">
                <div className="line-clamp-2 whitespace-pre-wrap text-sm text-stone-600 dark:text-stone-300">{task.prompt}</div>
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[10px]">{task.model}</Tag>
                    <Tag className="m-0 text-[10px]">{task.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.size || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.quality || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.outputFormat || "png"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.count} 张</Tag>
                    {task.config.streamImages ? <Tag className="m-0 text-[10px]">流式 {task.config.streamPartialImages || "1"}</Tag> : null}
                    <Tag className="m-0 text-[10px]">超时 {task.config.timeout || "600"}s</Tag>
                </div>
                {Object.keys(task.inputs).length ? (
                    <div className="flex flex-wrap gap-1">
                        {Object.entries(task.inputs)
                            .filter(([, value]) => String(value).trim())
                            .slice(0, 6)
                            .map(([key, value]) => (
                                <Tag key={key} className="m-0 max-w-full text-[10px]">
                                    <span className="font-medium">{key}</span>: <span className="inline-block max-w-48 truncate align-bottom">{String(value)}</span>
                                </Tag>
                            ))}
                    </div>
                ) : null}
                {task.error ? <div className="rounded-md bg-red-100 px-2.5 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{task.error}</div> : null}
                {task.images.length ? (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        {task.images.map((image, index) => (
                            <div key={image.id} className="overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-950">
                                <Image src={image.imageUrl} alt={`${task.workflowName} ${index + 1}`} className="aspect-[4/3] object-cover" />
                                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] text-stone-500">
                                    <span className="truncate">
                                        {image.width}x{image.height} · {formatBytes(image.bytes)}
                                    </span>
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : task.status === "running" ? (
                    <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-800">生成中 {formatDuration(elapsedMs)}</div>
                ) : null}
            </div>
        </article>
    );
}

function WorkflowEditorModal({
    open,
    workflow,
    modelConfig,
    theme,
    onChange,
    onCancel,
    onSave,
}: {
    open: boolean;
    workflow: CreativeWorkflow | null;
    modelConfig: AiConfig;
    theme: CanvasTheme;
    onChange: (workflow: CreativeWorkflow | null) => void;
    onCancel: () => void;
    onSave: (workflow: CreativeWorkflow) => void;
}) {
    if (!workflow) return null;
    const patch = (next: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...next });
    const patchConfig = (next: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...next } });
    const patchVariable = (id: string, next: Partial<WorkflowVariable>) => patch({ variables: workflow.variables.map((item) => (item.id === id ? normalizeVariable({ ...item, ...next }) : item)) });
    const removeVariable = (id: string) => patch({ variables: workflow.variables.filter((item) => item.id !== id) });

    return (
        <Modal title={workflow.createdAt ? "编辑工作流" : "新建工作流"} open={open} width={1080} onCancel={onCancel} onOk={() => onSave(workflow)} okText="保存" cancelText="取消" destroyOnHidden>
            <div className="grid max-h-[72vh] gap-4 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">基础信息</div>
                            <div className="inline-flex rounded-md border border-stone-300 bg-transparent p-0.5 dark:border-stone-700">
                                <button type="button" title="个人工作流" className={`inline-flex size-8 items-center justify-center rounded transition ${workflow.scope !== "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`} onClick={() => patch({ scope: "private" })}>
                                    <LockKeyhole className="size-4" />
                                </button>
                                <button type="button" title="公开工作流" className={`inline-flex size-8 items-center justify-center rounded transition ${workflow.scope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`} onClick={() => patch({ scope: "public" })}>
                                    <Globe2 className="size-4" />
                                </button>
                            </div>
                        </div>
                        <Input value={workflow.name} placeholder="工作流名称" onChange={(event) => patch({ name: event.target.value })} />
                        <Input value={workflow.category} placeholder="分类，例如 电商海报" onChange={(event) => patch({ category: event.target.value })} />
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.description} placeholder="适用场景说明" onChange={(event) => patch({ description: event.target.value })} />
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">输入变量</span>
                            <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => patch({ variables: [...workflow.variables, createVariable()] })}>
                                添加变量
                            </Button>
                        </div>
                        <div className="space-y-2">
                            {workflow.variables.map((variable) => (
                                <div key={variable.id} className="grid gap-2 rounded-md bg-stone-100 p-2 dark:bg-stone-950 lg:grid-cols-[1fr_1fr_120px_auto]">
                                    <Input value={variable.key} placeholder="变量名 product_name" onChange={(event) => patchVariable(variable.id, { key: event.target.value })} />
                                    <Input value={variable.label} placeholder="显示名称" onChange={(event) => patchVariable(variable.id, { label: event.target.value })} />
                                    <Select
                                        value={variable.type}
                                        options={variableTypeOptions}
                                        onChange={(value) => {
                                            const inferredOptions = inferVariableOptions(variable);
                                            patchVariable(variable.id, { type: value, options: value === "select" && !variable.options.length ? inferredOptions : variable.options });
                                        }}
                                    />
                                    <div className="flex items-center gap-2">
                                        <Checkbox checked={variable.required} onChange={(event) => patchVariable(variable.id, { required: event.target.checked })}>
                                            必填
                                        </Checkbox>
                                        <Button danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => removeVariable(variable.id)} />
                                    </div>
                                    <div className="lg:col-span-4">
                                        <VariableEditorValueControls variable={variable} onChange={(next) => patchVariable(variable.id, next)} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-sm font-medium">提示词模板</div>
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={workflow.config.systemPrompt} placeholder="系统提示词，可选" onChange={(event) => patchConfig({ systemPrompt: event.target.value })} />
                        <Input.TextArea autoSize={{ minRows: 7, maxRows: 14 }} value={workflow.config.promptTemplate} placeholder="用户提示词模板，使用 {{变量名}} 插入变量" onChange={(event) => patchConfig({ promptTemplate: event.target.value })} />
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.config.negativePrompt} placeholder="负面约束，可选" onChange={(event) => patchConfig({ negativePrompt: event.target.value })} />
                    </section>
                </div>
                <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="text-sm font-medium">生成配置</div>
                    <ModelPicker config={modelConfig} fullWidth value={workflow.config.imageModel || workflow.config.model} channelId={workflow.config.imageChannelId || modelConfig.imageChannelId} onChange={(value, channelId) => patchConfig({ imageModel: value, model: value, ...(channelId ? { imageChannelId: channelId } : {}) })} />
                    <Select
                        className="w-full"
                        value={workflow.config.apiMode}
                        options={[
                            { value: "images", label: "Images API" },
                            { value: "responses", label: "Responses API" },
                        ]}
                        onChange={(value) => patchConfig({ apiMode: value })}
                    />
                    <ImageSettingsPanel
                        config={{ ...defaultConfig, ...workflow.config, model: workflow.config.model || defaultConfig.model, imageModel: workflow.config.imageModel || workflow.config.model || defaultConfig.imageModel }}
                        onConfigChange={(key, value) => patchConfig({ [key]: value } as Partial<WorkflowGenerationConfig>)}
                        theme={theme}
                        showTitle={false}
                        className="space-y-4"
                        maxCount={10}
                        quickCount={6}
                        collapsible
                    />
                    <div className="space-y-2 rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                        <ToggleRow label="流式传输" checked={workflow.config.streamImages} onChange={(checked) => patchConfig({ streamImages: checked })} />
                        <ToggleRow label="返回 Base64" checked={workflow.config.responseFormatB64Json} onChange={(checked) => patchConfig({ responseFormatB64Json: checked })} />
                        <ToggleRow label="Codex CLI 兼容" checked={workflow.config.codexCli} onChange={(checked) => patchConfig({ codexCli: checked })} />
                        <Space.Compact className="w-full">
                            <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-3 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">超时(秒)</span>
                            <Input value={workflow.config.timeout} onChange={(event) => patchConfig({ timeout: event.target.value })} />
                        </Space.Compact>
                    </div>
                </aside>
            </div>
        </Modal>
    );
}

function WorkflowVariableInput({ variable, value, onChange }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void }) {
    return (
        <label className="block space-y-1.5 text-sm">
            <span className="flex items-center gap-1 font-medium">
                {variable.label || variable.key}
                {variable.required ? <span className="text-red-500">*</span> : null}
            </span>
            {variable.type === "textarea" ? (
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            ) : variable.type === "select" ? (
                <Select className="w-full" value={value || undefined} placeholder={variable.placeholder || "请选择"} options={variable.options.map((item) => ({ value: item, label: item }))} onChange={onChange} />
            ) : variable.type === "boolean" ? (
                <Switch checked={value === "true"} onChange={(checked) => onChange(String(checked))} />
            ) : (
                <Input type={variable.type === "number" ? "number" : "text"} value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            )}
        </label>
    );
}

function VariableEditorValueControls({ variable, onChange }: { variable: WorkflowVariable; onChange: (next: Partial<WorkflowVariable>) => void }) {
    const [optionDraft, setOptionDraft] = useState(variable.options.join(" / "));
    useEffect(() => {
        if (variable.type === "select") setOptionDraft(variable.options.join(" / "));
    }, [variable.id, variable.type]);

    if (variable.type === "boolean") {
        return (
            <div className="flex items-center gap-3 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                <span className="text-xs text-stone-500">默认开关</span>
                <Switch size="small" checked={variable.defaultValue === "true"} onChange={(checked) => onChange({ defaultValue: String(checked) })} />
            </div>
        );
    }
    if (variable.type === "select") {
        return (
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Input
                    value={optionDraft}
                    placeholder="选项，例如 自动 / 清冷私房 / 极简韩系"
                    onChange={(event) => {
                        const text = event.target.value;
                        setOptionDraft(text);
                        const options = parseVariableOptions(text);
                        onChange({ options, defaultValue: options.includes(variable.defaultValue) ? variable.defaultValue : options[0] || "" });
                    }}
                />
                <Select className="w-full" value={variable.defaultValue || undefined} placeholder="默认选项" options={variable.options.map((item) => ({ value: item, label: item }))} onChange={(value) => onChange({ defaultValue: value })} />
            </div>
        );
    }
    if (variable.type === "textarea") {
        return <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={variable.defaultValue} placeholder="默认长文本" onChange={(event) => onChange({ defaultValue: event.target.value })} />;
    }
    return <Input type={variable.type === "number" ? "number" : "text"} value={variable.defaultValue} placeholder={variable.type === "number" ? "默认数字" : "默认值"} onChange={(event) => onChange({ defaultValue: event.target.value })} />;
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span>{label}</span>
            <Switch size="small" checked={checked} onChange={onChange} />
        </div>
    );
}

function InfoPill({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
            <div>{label}</div>
            <div className="mt-1 truncate text-stone-900 dark:text-stone-100">{value}</div>
        </div>
    );
}

function createBlankWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: "",
        category: "",
        description: "",
        variables: [createVariable("product_name", "产品名称"), createVariable("selling_points", "产品卖点", "textarea")],
        config: createWorkflowConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "public",
        editable: true,
        name: "电商海报生成",
        category: "电商海报",
        description: "固定海报构图、商业摄影质感和营销文案结构，只替换产品与卖点。",
        variables: [createVariable("product_name", "产品名称"), createVariable("selling_points", "核心卖点", "textarea"), createVariable("campaign", "活动信息")],
        config: {
            ...createWorkflowConfig(config),
            promptTemplate: "为 {{product_name}} 生成一张高端电商海报。\n核心卖点：{{selling_points}}\n活动信息：{{campaign}}\n要求：主体清晰、构图高级、商品有强烈质感，画面适合社交媒体和电商首图。",
        },
        createdAt: now,
        updatedAt: now,
    });
}

function createWorkflowConfig(config: AiConfig): WorkflowGenerationConfig {
    return {
        model: config.model || defaultConfig.model,
        imageModel: config.imageModel || config.model || defaultConfig.imageModel,
        imageChannelId: config.imageChannelId || "",
        quality: config.quality || defaultConfig.quality,
        size: config.size || defaultConfig.size,
        count: config.count || "1",
        apiMode: config.apiMode || "images",
        outputFormat: config.outputFormat || "png",
        outputCompression: config.outputCompression || "100",
        moderation: config.moderation || "auto",
        timeout: config.timeout || "600",
        streamImages: Boolean(config.streamImages),
        streamPartialImages: config.streamPartialImages || "1",
        responseFormatB64Json: config.responseFormatB64Json !== false,
        codexCli: Boolean(config.codexCli),
        systemPrompt: config.systemPrompts.workflow || config.systemPrompt || "",
        promptTemplate: "",
        negativePrompt: "",
    };
}

function describeModelSelection(config: AiConfig, modelName: string, channelId: string) {
    const selectedModel = modelName || "未选择模型";
    if (config.channelMode === "local") {
        const channel = localChannelForActiveModel({ ...config, model: selectedModel, activeChannelId: channelId });
        return { channelName: channel?.name || "本地直连", modelName: selectedModel };
    }
    const channel =
        config.publicChannels.find((item) => item.id === channelId && item.models.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.models.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.id === channelId) ||
        config.publicChannels[0];
    return { channelName: channel?.name || "云端渠道", modelName: selectedModel };
}

function createVariable(key = "", label = "", type: WorkflowVariableType = "text"): WorkflowVariable {
    return normalizeVariable({ id: nanoid(), key, label, type, required: true, defaultValue: "", options: [] });
}

function normalizeAgentDraft(draft: Partial<CreativeWorkflow>, config: AiConfig, scope: "private" | "public"): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: draft.scope === "public" ? "public" : scope,
        editable: true,
        name: draft.name || "AI 创建工作流",
        category: draft.category || "",
        description: draft.description || "",
        variables: (draft.variables || []).map((variable) => ({ ...createVariable(), ...variable, id: variable.id || nanoid() })),
        config: { ...createWorkflowConfig(config), ...(draft.config || {}) },
        createdAt: now,
        updatedAt: now,
    });
}

function normalizeVariable(variable: WorkflowVariable): WorkflowVariable {
    const key = variable.key.replace(/[^\w.-]/g, "_");
    return { ...variable, key, label: variable.label || key, defaultValue: variable.defaultValue == null ? "" : String(variable.defaultValue), options: Array.isArray(variable.options) ? variable.options : parseVariableOptions(String(variable.options || "")) };
}

function normalizeWorkflow(workflow: CreativeWorkflow): CreativeWorkflow {
    return {
        ...workflow,
        scope: workflow.scope === "public" ? "public" : "private",
        editable: workflow.editable !== false,
        variables: (workflow.variables || []).map(normalizeVariable),
        config: { ...createWorkflowConfig(defaultConfig), ...(workflow.config || {}) },
        createdAt: workflow.createdAt || Date.now(),
        updatedAt: workflow.updatedAt || Date.now(),
    };
}

function createDefaultInputValues(workflow: CreativeWorkflow) {
    return Object.fromEntries(workflow.variables.map((variable) => [variable.key, variable.defaultValue || (variable.type === "boolean" ? "false" : "")]));
}

function renderPromptTemplate(template: string, values: Record<string, string>) {
    return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key: string) => values[key] || "");
}

function renderWorkflowPrompt(workflow: CreativeWorkflow, values: Record<string, string>) {
    const formattedValues = Object.fromEntries(workflow.variables.map((variable) => [variable.key, formatWorkflowVariableValue(variable, values[variable.key])]));
    const prompt = renderPromptTemplate(workflow.config.promptTemplate, formattedValues).trim();
    const negativePrompt = workflow.config.negativePrompt.trim();
    return negativePrompt ? `${prompt}\n\n避免：${negativePrompt}` : prompt;
}

function formatWorkflowVariableValue(variable: WorkflowVariable, value: string | undefined) {
    const raw = value ?? variable.defaultValue ?? "";
    if (variable.type !== "boolean") return raw;
    return raw === "true" ? "开启" : "关闭";
}

function parseVariableOptions(text: string) {
    return text
        .split(/[\/\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function inferVariableOptions(variable: WorkflowVariable) {
    return parseVariableOptions([variable.defaultValue, variable.placeholder, variable.options.join("/")].filter(Boolean).join("/"));
}

function workflowToRecord(workflow: CreativeWorkflow): CreativeWorkflowRecord<CreativeWorkflow> {
    return {
        id: workflow.id,
        ownerUserId: workflow.ownerUserId,
        scope: workflow.scope === "public" ? "public" : "private",
        name: workflow.name,
        category: workflow.category,
        description: workflow.description,
        data: workflow,
        createdAt: new Date(workflow.createdAt).toISOString(),
        updatedAt: new Date(workflow.updatedAt).toISOString(),
        lastRunAt: workflow.lastRunAt ? new Date(workflow.lastRunAt).toISOString() : undefined,
        editable: workflow.editable !== false,
    };
}

function recordToWorkflow(record: CreativeWorkflowRecord<CreativeWorkflow>): CreativeWorkflow {
    const data = record.data || ({} as CreativeWorkflow);
    return normalizeWorkflow({
        ...data,
        id: record.id || data.id,
        ownerUserId: record.ownerUserId,
        scope: record.scope === "public" ? "public" : "private",
        editable: record.editable,
        name: record.name || data.name || "",
        category: record.category || data.category || "",
        description: record.description || data.description || "",
        createdAt: record.createdAt ? Date.parse(record.createdAt) : data.createdAt,
        updatedAt: record.updatedAt ? Date.parse(record.updatedAt) : data.updatedAt,
        lastRunAt: record.lastRunAt ? Date.parse(record.lastRunAt) : data.lastRunAt,
    });
}

function resolveWorkflowRuntime(workflow: CreativeWorkflow, baseConfig: AiConfig) {
    const workflowModel = workflow.config.imageModel || workflow.config.model;
    const fallbackModel = baseConfig.imageModel || baseConfig.model;
    if (!workflowModel) return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: baseConfig.imageChannelId };
    if (baseConfig.channelMode === "remote" && workflowModel !== fallbackModel && (!baseConfig.models.length || !baseConfig.models.includes(workflowModel))) {
        return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: baseConfig.imageChannelId };
    }
    return { model: workflowModel, apiMode: workflow.config.apiMode || baseConfig.apiMode, channelId: workflow.config.imageChannelId || baseConfig.imageChannelId };
}

function buildRunConfig(baseConfig: AiConfig, workflowConfig: WorkflowGenerationConfig, runtime: { model: string; apiMode: AiConfig["apiMode"]; channelId: string }): AiConfig {
    return {
        ...baseConfig,
        ...workflowConfig,
        model: runtime.model,
        imageModel: runtime.model,
        imageChannelId: runtime.channelId,
        activeChannelId: runtime.channelId,
        apiMode: runtime.apiMode,
        systemPrompt: workflowConfig.systemPrompt || baseConfig.systemPrompts.workflow || baseConfig.systemPrompt,
        count: workflowConfig.count || "1",
    };
}

function buildImageHistoryLog({
    workflow,
    prompt,
    config,
    model,
    images,
    durationMs,
    inputs,
    references,
    categoryIds,
}: {
    workflow: CreativeWorkflow;
    prompt: string;
    config: WorkflowGenerationConfig;
    model: string;
    images: ImageHistoryLog["images"];
    durationMs: number;
    inputs: Record<string, unknown>;
    references: ReferenceImage[];
    categoryIds: string[];
}): ImageHistoryLog {
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: workflow.name,
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config,
        references,
        durationMs,
        successCount: images.length,
        failCount: 0,
        imageCount: images.length,
        size: config.size,
        quality: config.quality,
        status: "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors: [],
        categoryIds,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowInputs: inputs,
    };
}

async function ensureWorkflowCategory(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const categories = (await categoryStore.getItem<GenerationCategory[]>(CATEGORY_STORE_KEY)) || [];
    const existing = categories.find((item) => item.name === trimmed);
    if (existing) return existing;
    const nextCategory = { id: nanoid(), name: trimmed, createdAt: Date.now() };
    await categoryStore.setItem(CATEGORY_STORE_KEY, [...categories, nextCategory]);
    return nextCategory;
}

function serializeHistoryLog(log: ImageHistoryLog): ImageHistoryLog {
    return {
        ...log,
        images: log.images.map((image) => ({ ...image, dataUrl: image.dataUrl?.startsWith("http") ? image.dataUrl : "" })),
        thumbnails: log.images.map((image) => (image.dataUrl?.startsWith("http") ? image.dataUrl : "")),
    };
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

function referenceUsedByWorkflowTask(reference: ReferenceImage, tasks: WorkflowTask[]) {
    if (!reference.storageKey) return false;
    return tasks.some((task) => task.references.some((item) => item.storageKey === reference.storageKey));
}

function formatDate(value: number) {
    return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
