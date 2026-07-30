"use client";

import {
    AlertCircle,
    BookOpen,
    CheckSquare,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    Copy,
    Download,
    FolderPlus,
    History,
    ImagePlus,
    LoaderCircle,
    PanelBottom,
    PanelLeft,
    PenLine,
    Plus,
    RotateCcw,
    Sparkles,
    SlidersHorizontal,
    Trash2,
    Upload,
    WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Pagination, Segmented, Skeleton, Tag, Typography } from "antd";
import { saveAs } from "file-saver";

import { ImageSettingsPanel, imageFormatLabel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import {
    CreativeWorkflowWorkspace,
    type WorkflowExternalTaskFailure,
    type WorkflowExternalTaskStart,
    type WorkflowExternalTaskSuccess,
} from "@/components/workflows/creative-workflow-workspace";
import { localChannelForActiveModel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { ImageRequestError, requestEdit, requestGeneration } from "@/services/api/image";
import { fetchUserConfig, syncUserImageHistory } from "@/services/api/user-config";
import {
    putImageHistoryCategories,
    putImageHistoryLog,
    putImageHistoryLogs,
    readAllImageHistoryLogs,
    readImageHistoryCategories,
    readImageHistoryIndex,
    readImageHistoryLogsByIds,
    removeImageHistoryLogs,
    replaceImageHistoryLogs,
    type ImageHistoryIndexEntry,
    type ImageHistoryIndexImage,
} from "@/services/image-history-storage";
import { deleteStoredImages, imageToBlob, imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { getImageThumbnail } from "@/services/image-thumbnail-cache";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
    actualSize?: string;
    actualQuality?: string;
    revisedPrompt?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    createdAt: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    image?: GeneratedImage;
    error?: string;
    errorDetail?: string;
    durationMs?: number;
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    workflowTaskId?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
    errors: string[];
    errorDetails?: string[];
    categoryIds: string[];
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count" | "apiMode" | "outputFormat" | "outputCompression" | "moderation" | "timeout" | "retryAttempts" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli" | "seed"> & { channelId?: string; channelName?: string };
type RequestSnapshot = { text: string; requestConfig: AiConfig; displayConfig: GenerationLogConfig; references: ReferenceImage[] };
type GenerationCategory = { id: string; name: string; createdAt: number };
type ResultViewMode = "all" | "category";

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type WorkbenchLayout = "side" | "bottom";
type CollapsibleSectionKey = "prompt" | "references" | "settings";
type CollapsedSections = Record<CollapsibleSectionKey, boolean>;

const WORKBENCH_LAYOUT_KEY = "infinite-canvas:image-workbench-layout";
const RESULT_VIEW_MODE_KEY = "infinite-canvas:image-result-view-mode";
const WORKFLOW_BUTTON_POSITION_KEY = "infinite-canvas:workflow-button-position";
const DEFAULT_HISTORY_PAGE_SIZE = 24;
const defaultCollapsedSections: CollapsedSections = { prompt: false, references: true, settings: true };

export default function ImagePage() {
    const { message, modal } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [uploadingCount, setUploadingCount] = useState(0);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [historyIndex, setHistoryIndex] = useState<ImageHistoryIndexEntry[]>([]);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [historyPage, setHistoryPage] = useState(1);
    const [historyPageSize, setHistoryPageSize] = useState(DEFAULT_HISTORY_PAGE_SIZE);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyRevision, setHistoryRevision] = useState(0);
    const [categories, setCategories] = useState<GenerationCategory[]>([]);
    const [resultViewMode, setResultViewModeState] = useState<ResultViewMode>("all");
    const [activeResultCategoryId, setActiveResultCategoryId] = useState<string | null>(null);
    const [workbenchLayout, setWorkbenchLayoutState] = useState<WorkbenchLayout>("side");
    const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>(defaultCollapsedSections);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [workflowButtonPosition, setWorkflowButtonPosition] = useState({ x: 0, y: 0 });
    const workflowButtonRef = useRef<HTMLButtonElement>(null);
    const workflowButtonDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const accountHistorySyncEnabledRef = useRef(false);
    const accountHistoryLoadTokenRef = useRef("");
    const accountHistorySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const historyQueryKeyRef = useRef("");
    const saveLogChainRef = useRef<Promise<void>>(Promise.resolve());

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const pendingCount = results.filter((item) => item.status === "pending").length;

    useEffect(() => {
        void refreshCategories();
        try {
            const storedLayout = window.localStorage?.getItem(WORKBENCH_LAYOUT_KEY);
            if (storedLayout === "side" || storedLayout === "bottom") setWorkbenchLayoutState(storedLayout);
            const storedViewMode = window.localStorage?.getItem(RESULT_VIEW_MODE_KEY);
            if (storedViewMode === "all" || storedViewMode === "category") setResultViewModeState(storedViewMode);
            const storedButtonPosition = JSON.parse(window.localStorage?.getItem(WORKFLOW_BUTTON_POSITION_KEY) || "null") as { x?: number; y?: number } | null;
            if (typeof storedButtonPosition?.x === "number" && typeof storedButtonPosition?.y === "number") setWorkflowButtonPosition(clampWorkflowButtonPosition(storedButtonPosition));
            else setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        } catch {
            // Local storage can be unavailable in restricted browser contexts.
            setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        }

        // 监听窗口大小变化，拉窄窗口时自动将工作流按钮实时 clamp 限制在可视区域内，杜绝越界
        const handleResize = () => {
            setWorkflowButtonPosition((current) => clampWorkflowButtonPosition(current));
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => {
        let active = true;
        void (async () => {
            const queryKey = `${resultViewMode}:${activeResultCategoryId || "uncategorized"}:${historyPage}:${historyPageSize}`;
            const queryChanged = historyQueryKeyRef.current !== queryKey;
            historyQueryKeyRef.current = queryKey;
            setHistoryLoading(true);
            if (queryChanged) setLogs([]);
            const index = await readImageHistoryIndex();
            const filtered = filterImageHistoryIndex(index, resultViewMode, activeResultCategoryId);
            const maxPage = Math.max(1, Math.ceil(filtered.length / historyPageSize));
            if (historyPage > maxPage) {
                setHistoryPage(maxPage);
                return;
            }
            const pageEntries = filtered.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize);
            const rawLogs = await readImageHistoryLogsByIds<GenerationLog>(pageEntries.map((entry) => entry.id));
            const rawById = new Map(rawLogs.map((log) => [log.id, log]));
            const pageLogs: GenerationLog[] = [];
            pageEntries.forEach((entry) => {
                const log = rawById.get(entry.id);
                if (log) pageLogs.push(log);
            });
            const normalized = await Promise.all(pageLogs.map((log) => normalizeLog(log)));
            if (!active) return;
            setHistoryIndex(index);
            setHistoryTotal(filtered.length);
            setLogs(normalized);
        })()
            .catch(() => {
                if (active) setLogs([]);
            })
            .finally(() => {
                if (active) setHistoryLoading(false);
            });
        return () => {
            active = false;
        };
    }, [activeResultCategoryId, historyPage, historyPageSize, historyRevision, resultViewMode]);

    useEffect(() => {
        setHistoryPage(1);
    }, [activeResultCategoryId, resultViewMode]);

    useEffect(() => {
        if (!isUserReady) return;
        if (!token) {
            accountHistoryLoadTokenRef.current = "";
            return;
        }
        if (accountHistoryLoadTokenRef.current === token) return;
        accountHistoryLoadTokenRef.current = token;
        void loadAccountImageHistory(token);
    }, [isUserReady, token]);

    useEffect(
        () => () => {
            if (accountHistorySyncTimerRef.current) clearTimeout(accountHistorySyncTimerRef.current);
        },
        [token],
    );

    useEffect(() => {
        if (!pendingCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [pendingCount]);

    const setWorkbenchLayout = (layout: WorkbenchLayout) => {
        setWorkbenchLayoutState(layout);
        try {
            window.localStorage?.setItem(WORKBENCH_LAYOUT_KEY, layout);
        } catch {
            // Keep the in-memory layout even when persistence is unavailable.
        }
    };

    const setResultViewMode = (mode: ResultViewMode) => {
        setResultViewModeState(mode);
        try {
            window.localStorage?.setItem(RESULT_VIEW_MODE_KEY, mode);
        } catch {
            // Keep current view in memory if persistence is blocked.
        }
    };

    const persistWorkflowButtonPosition = (position: { x: number; y: number }) => {
        const nextPosition = clampWorkflowButtonPosition(position);
        setWorkflowButtonPosition(nextPosition);
        try {
            window.localStorage?.setItem(WORKFLOW_BUTTON_POSITION_KEY, JSON.stringify(nextPosition));
        } catch {
            // Keep the drag position in memory when localStorage is unavailable.
        }
    };

    const handleWorkflowButtonPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition();
        workflowButtonDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y, moved: false };
    };

    const handleWorkflowButtonPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        
        // 直接更新 DOM 样式，免去顶层 React State 的庞大整页重绘 Layout 卡顿！
        const nextPos = clampWorkflowButtonPosition({ x: drag.originX + dx, y: drag.originY + dy });
        if (workflowButtonRef.current) {
            workflowButtonRef.current.style.left = `${nextPos.x}px`;
            workflowButtonRef.current.style.top = `${nextPos.y}px`;
        }
    };

    const handleWorkflowButtonPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const finalPos = clampWorkflowButtonPosition({ x: drag.originX + dx, y: drag.originY + dy });
        persistWorkflowButtonPosition(finalPos);
    };

    const toggleCollapsedSection = (section: CollapsibleSectionKey) => {
        setCollapsedSections((value) => ({ ...value, [section]: !value[section] }));
    };

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        setUploadingCount(imageFiles.length);
        const hideLoading = message.loading("正在上传参考图...", 0);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success("参考图上传成功");
        } catch (error) {
            message.error(error instanceof Error ? `上传参考图失败：${error.message}` : "上传参考图失败");
        } finally {
            hideLoading();
            setUploadingCount(0);
        }
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            setUploadingCount(blobs.length);
            const hideLoading = message.loading("正在上传并读取参考图...", 0);
            try {
                const nextReferences = await Promise.all(
                    blobs.map(async (blob, index) => {
                        const image = await uploadImage(blob);
                        return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "clipboard" as const, temporary: true };
                    }),
                );
                setReferences((value) => [...value, ...nextReferences]);
                message.success(`已成功上传并读取 ${nextReferences.length} 张参考图`);
            } finally {
                hideLoading();
                setUploadingCount(0);
            }
        } catch {
            message.error("剪切板里没有可读取的图片");
            setUploadingCount(0);
        }
    };

    const removeReference = async (id: string) => {
        const reference = references.find((item) => item.id === id);
        setReferences((value) => value.filter((ref) => ref.id !== id));
        const storedLogs = await readAllImageHistoryLogs<GenerationLog>();
        if (!reference || !shouldDeleteReferenceFile(reference, storedLogs, results)) {
            message.success("已从工作台移除参考图");
            return;
        }
        if (reference?.storageKey) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const pastePromptFromClipboard = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            setPrompt(text);
            setCollapsedSections((value) => ({ ...value, prompt: false }));
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    const clearPrompt = () => {
        setPrompt("");
        setCollapsedSections((value) => ({ ...value, prompt: false }));
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPrompt("");
        setCollapsedSections((value) => ({ ...value, prompt: false }));
        await submitGenerationBatch(snapshot);
    };

    const retryLog = async (log: GenerationLog) => {
        const taskCount = Math.max(1, Number(log.config.count) || log.imageCount || 1);
        const requestConfig = configFromLogConfig(effectiveConfig, log.config, String(taskCount));
        const snapshot = buildRequestSnapshot({
            promptText: log.prompt,
            referenceItems: log.references,
            taskCount,
            configOverride: requestConfig,
            displayConfigOverride: displayConfigFromLogConfig(requestConfig, log.config, String(taskCount)),
        });
        if (!snapshot) return;
        await submitGenerationBatch(snapshot);
    };

    const submitGenerationBatch = async (snapshot: RequestSnapshot) => {
        setPreviewLog(null);
        const taskCount = Math.max(1, Number(snapshot.displayConfig.count) || 1);
        const taskIds = Array.from({ length: taskCount }, () => nanoid());
        const pendingTasks = taskIds.map((id) => createPendingResult(id, snapshot));
        setResults((value) => [...pendingTasks, ...value]);
        setNow(Date.now());

        const tasks = taskIds.map(async (id, index) => {
            const taskStartedAt = performance.now();
            try {
                const image = await runGenerationTask(id, {
                    ...snapshot,
                    requestConfig: {
                        ...snapshot.requestConfig,
                        seedIndex: index,
                        seedCount: taskCount,
                    } as any,
                });

                if (!image) {
                    throw new Error("接口没有返回图片");
                }

                // 立即存储图片
                const stored = await uploadImage(image.dataUrl);
                const durableImage = { 
                    ...image, 
                    storageKey: stored.storageKey, 
                    width: stored.width, 
                    height: stored.height, 
                    bytes: stored.bytes, 
                    mimeType: stored.mimeType 
                };
                
                // 更新结果状态
                setResults((value) => updateResult(value, id, { image: durableImage }));
                
                // 立即保存单张成功日志
                await saveLog(
                    buildLog({
                        prompt: snapshot.text,
                        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
                        config: { ...snapshot.displayConfig, count: "1" },
                        references: snapshot.references,
                        durationMs: performance.now() - taskStartedAt,
                        successCount: 1,
                        failCount: 0,
                        status: "成功",
                        images: [durableImage],
                        errors: [],
                        errorDetails: [],
                        categoryIds: activeResultCategoryId ? [activeResultCategoryId] : [],
                    }),
                );
                message.success("图片已生成");
            } catch (err) {
                const errMsg = errorMessage(err);
                const errDetail = errorDetail(err);
                
                // 立即保存单张失败日志
                await saveLog(
                    buildLog({
                        prompt: snapshot.text,
                        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
                        config: { ...snapshot.displayConfig, count: "1" },
                        references: snapshot.references,
                        durationMs: performance.now() - taskStartedAt,
                        successCount: 0,
                        failCount: 1,
                        status: "失败",
                        images: [],
                        errors: [errMsg],
                        errorDetails: [errDetail],
                        categoryIds: activeResultCategoryId ? [activeResultCategoryId] : [],
                    }),
                );
                message.error(errMsg || "生成失败");
            } finally {
                // 任务完成，从进行中状态移除
                setResults((value) => value.filter((item) => item.id !== id));
            }
        });

        await Promise.allSettled(tasks);
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        try {
            const blob = await imageToBlob(image);
            saveAs(blob, `image-${index + 1}.${imageExtension(blob.type || image.mimeType || image.dataUrl)}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        }
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        try {
            if (image.storageKey) {
                const url = await resolveImageUrl(image.storageKey, image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: image.mimeType || "image/png", dataUrl: url || image.dataUrl, storageKey: image.storageKey, source: "result", temporary: false }]);
            } else {
                const source = await imageToDataUrl(image);
                const stored = await uploadImage(source || image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: "result", temporary: false }]);
            }
            message.success("已加入参考图");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入参考图失败");
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = image.storageKey
            ? {
                  url: await resolveImageUrl(image.storageKey, image.dataUrl),
                  storageKey: image.storageKey,
                  width: image.width,
                  height: image.height,
                  bytes: image.bytes,
                  mimeType: image.mimeType || "image/png",
              }
            : await uploadImage(await imageToDataUrl(image));
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const resolvedUrl = await resolveImageUrl(payload.storageKey, payload.dataUrl);
            const safeUrl = resolvedUrl || "";
            const reference =
                payload.storageKey || payload.source === "asset"
                    ? {
                          id: nanoid(),
                          name: payload.title,
                          type: payload.mimeType || "image/png",
                          dataUrl: safeUrl,
                          storageKey: payload.storageKey,
                          source: "asset" as const,
                          assetId: payload.assetId,
                          temporary: false,
                      }
                    : (() => null)();
            if (reference) {
                if (!reference.dataUrl) {
                    message.error("引入素材失败：图片数据为空");
                    return;
                }
                setReferences((value) => [...value, reference]);
            } else {
                const stored = await uploadImage(payload.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: payload.source === "library" ? "library" : "upload", temporary: payload.source !== "library" }]);
            }
        } else {
            message.warning("该素材不能作为生图参考图");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults((value) => value.filter((item) => item.status === "pending"));
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        void (async () => {
            const storedLogs = await readAllImageHistoryLogs<GenerationLog>();
            const deletedLogs = storedLogs.filter((log) => selectedLogIds.includes(log.id));
            const nextLogs = storedLogs.filter((log) => !selectedLogIds.includes(log.id));
            const imageKeys = disposableLogStorageKeys(deletedLogs, nextLogs);
            await Promise.all([deleteStoredImages(imageKeys), removeImageHistoryLogs(selectedLogIds)]);
            setLogs((value) => value.filter((log) => !selectedLogIds.includes(log.id)));
            setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
            schedulePersistImageHistory(categories);
            await refreshLogs();
        })();
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults((value) => value.filter((item) => item.status === "pending"));
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const deleteLog = (log: GenerationLog) => {
        modal.confirm({
            title: "删除生成结果",
            content: "确定删除这条生成结果吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const storedLogs = await readAllImageHistoryLogs<GenerationLog>();
                const nextLogs = storedLogs.filter((item) => item.id !== log.id);
                const imageKeys = disposableLogStorageKeys([log], nextLogs);
                await Promise.all([deleteStoredImages(imageKeys), removeImageHistoryLogs([log.id])]);
                setLogs((value) => value.filter((item) => item.id !== log.id));
                setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
                schedulePersistImageHistory(categories);
                setSelectedLogIds((value) => value.filter((id) => id !== log.id));
                if (previewLog?.id === log.id) setPreviewLog(null);
                await refreshLogs();
            },
        });
    };

    const saveLog = async (log: GenerationLog) => {
        const prevChain = saveLogChainRef.current;
        const nextChain = (async () => {
            try {
                await prevChain;
            } catch {
                // Ignore previous errors so the chain doesn't break permanently
            }
            await putImageHistoryLog(serializeLog(log));
            setHistoryPage(1);
            await refreshLogs();
            schedulePersistImageHistory(categories);
        })();
        saveLogChainRef.current = nextChain;
        await nextChain;
    };

    const refreshLogs = async () => setHistoryRevision((value) => value + 1);
    const refreshCategories = async () => setCategories(await readStoredCategories());

    const loadAccountImageHistory = async (currentToken: string) => {
        try {
            const config = await fetchUserConfig(currentToken);
            accountHistorySyncEnabledRef.current = config.syncCapabilities?.userData === true;
            const remote = config.imageHistory as { logs?: GenerationLog[]; categories?: GenerationCategory[] } | undefined;
            const remoteLogs = Array.isArray(remote?.logs) ? remote.logs : [];
            const remoteCategories = Array.isArray(remote?.categories) ? remote.categories : [];
            
            const localIndex = await readImageHistoryIndex();
            const localCategories = await readStoredCategories();
            const localHasData = localIndex.length > 0 || localCategories.length > 0;
            const remoteHasData = remoteLogs.length > 0 || remoteCategories.length > 0;

            if (accountHistorySyncEnabledRef.current) {
                await replaceStoredImageHistory(remoteLogs, remoteCategories);
                setCategories(remoteCategories);
                setHistoryPage(1);
                await refreshLogs();
                return;
            } else if (remoteHasData && !localHasData) {
                await replaceStoredImageHistory(remoteLogs, remoteCategories);
                setCategories(remoteCategories);
                setHistoryPage(1);
                await refreshLogs();
            }
        } catch {
            // Keep local history available when account sync fails.
        }
    };

    const persistImageHistory = async (nextCategories: GenerationCategory[]) => {
        if (!token || !accountHistorySyncEnabledRef.current) return;
        const storedLogs = await readAllImageHistoryLogs<GenerationLog>();
        await syncUserImageHistory(token, imageHistorySnapshot(storedLogs, nextCategories)).catch(() => {
            accountHistorySyncEnabledRef.current = false;
        });
    };

    const schedulePersistImageHistory = (nextCategories: GenerationCategory[]) => {
        if (!token || !accountHistorySyncEnabledRef.current) return;
        if (accountHistorySyncTimerRef.current) clearTimeout(accountHistorySyncTimerRef.current);
        accountHistorySyncTimerRef.current = setTimeout(() => {
            accountHistorySyncTimerRef.current = null;
            void persistImageHistory(nextCategories);
        }, 800);
    };

    const createCategory = async (name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return null;
        }
        const existing = categories.find((item) => item.name === trimmedName);
        if (existing) return existing;
        const nextCategory = { id: nanoid(), name: trimmedName, createdAt: Date.now() };
        const nextCategories = [...categories, nextCategory];
        setCategories(nextCategories);
        await putImageHistoryCategories(nextCategories);
        schedulePersistImageHistory(nextCategories);
        return nextCategory;
    };

    const renameCategory = async (category: GenerationCategory, name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return;
        }
        const nextCategories = categories.map((item) => (item.id === category.id ? { ...item, name: trimmedName } : item));
        setCategories(nextCategories);
        await putImageHistoryCategories(nextCategories);
        schedulePersistImageHistory(nextCategories);
        message.success("已重命名分类");
    };

    const deleteCategory = (category: GenerationCategory) => {
        modal.confirm({
            title: "删除分类",
            content: `确定删除分类「${category.name}」吗？分类内的生成结果会移至未分类。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextCategories = categories.filter((item) => item.id !== category.id);
                const storedLogs = await readAllImageHistoryLogs<GenerationLog>();
                const nextLogs = storedLogs.map((log) => ({ ...log, categoryIds: (log.categoryIds || []).filter((id) => id !== category.id) }));
                setCategories(nextCategories);
                await putImageHistoryCategories(nextCategories);
                await putImageHistoryLogs(nextLogs.map(serializeLog));
                await refreshLogs();
                schedulePersistImageHistory(nextCategories);
                message.success("已删除分类");
            },
        });
    };

    const updateLogCategories = async (log: GenerationLog, categoryIds: string[]) => {
        const nextLog = { ...log, categoryIds };
        const nextLogs = logs.map((item) => (item.id === log.id ? nextLog : item));
        setLogs(nextLogs);
        await putImageHistoryLog(serializeLog(nextLog));
        schedulePersistImageHistory(categories);
        await refreshLogs();
        message.success(categoryIds.length ? "已更新分类" : "已移至未分类");
    };

    const toggleLogCategory = async (log: GenerationLog, categoryId: string) => {
        const nextCategoryIds = log.categoryIds.includes(categoryId) ? log.categoryIds.filter((id) => id !== categoryId) : [...log.categoryIds, categoryId];
        await updateLogCategories(log, nextCategoryIds);
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        const hydratedLog = await normalizeLog(log, true);
        setPreviewLog(hydratedLog);
        setPrompt(hydratedLog.prompt);
        setReferences(hydratedLog.references || []);
        setCollapsedSections((value) => ({ ...value, prompt: false, references: !hydratedLog.references?.length }));
        if (hydratedLog.config.imageModel || hydratedLog.model) updateConfig("imageModel", hydratedLog.config.imageModel || hydratedLog.model);
        if (hydratedLog.config.channelId) {
            updateConfig("imageChannelId", hydratedLog.config.channelId);
            updateConfig("activeChannelId", hydratedLog.config.channelId);
        }
        if (hydratedLog.config.quality) updateConfig("quality", hydratedLog.config.quality);
        if (hydratedLog.config.size) updateConfig("size", hydratedLog.config.size);
        if (hydratedLog.config.count) updateConfig("count", hydratedLog.config.count);
        if (hydratedLog.config.apiMode) updateConfig("apiMode", hydratedLog.config.apiMode);
        if (hydratedLog.config.outputFormat) updateConfig("outputFormat", hydratedLog.config.outputFormat);
        if (hydratedLog.config.outputCompression) updateConfig("outputCompression", hydratedLog.config.outputCompression);
        if (hydratedLog.config.moderation) updateConfig("moderation", hydratedLog.config.moderation);
        if (hydratedLog.config.timeout) updateConfig("timeout", hydratedLog.config.timeout);
        if (typeof hydratedLog.config.streamImages === "boolean") updateConfig("streamImages", hydratedLog.config.streamImages);
        if (hydratedLog.config.streamPartialImages) updateConfig("streamPartialImages", hydratedLog.config.streamPartialImages);
        if (typeof hydratedLog.config.responseFormatB64Json === "boolean") updateConfig("responseFormatB64Json", hydratedLog.config.responseFormatB64Json);
        if (typeof hydratedLog.config.codexCli === "boolean") updateConfig("codexCli", hydratedLog.config.codexCli);
        if (hydratedLog.config.seed !== undefined) updateConfig("seed", hydratedLog.config.seed);
    };

    const copyPrompt = async (text: string) => {
        await navigator.clipboard.writeText(text);
        message.success("提示词已复制");
    };

    const buildRequestSnapshot = ({
        promptText = prompt,
        referenceItems = references,
        taskCount = generationCount,
        configOverride,
        displayConfigOverride,
    }: {
        promptText?: string;
        referenceItems?: ReferenceImage[];
        taskCount?: number;
        configOverride?: AiConfig;
        displayConfigOverride?: GenerationLogConfig;
    } = {}) => {
        const text = promptText.trim();
        const activeConfig = configOverride || effectiveConfig;
        const activeModel = activeConfig.imageModel || activeConfig.model;
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(activeConfig, activeModel)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return {
            text,
            requestConfig: { ...activeConfig, model: activeModel, activeChannelId: activeConfig.imageChannelId, count: "1" },
            displayConfig: displayConfigOverride || buildGenerationLogConfig({ ...activeConfig, model: activeModel, count: String(taskCount) }),
            references: [...referenceItems],
        };
    };

    const runGenerationTask = async (resultId: string, snapshot: RequestSnapshot) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.requestConfig, snapshot.text, snapshot.references) : await requestGeneration(snapshot.requestConfig, snapshot.text);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: image.dataUrl,
                durationMs: performance.now() - itemStartedAt,
                width: meta.width,
                height: meta.height,
                bytes: getDataUrlByteSize(image.dataUrl),
                mimeType: meta.mimeType,
                actualSize: image.actualSize || `${meta.width}x${meta.height}`,
                actualQuality: image.actualQuality,
                revisedPrompt: image.revisedPrompt,
            };
            setResults((value) => updateResult(value, resultId, { status: "success", image: nextImage, durationMs: nextImage.durationMs }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResult(value, resultId, { status: "failed", error: errorMessage(error), errorDetail: errorDetail(error), durationMs: performance.now() - itemStartedAt }));
            throw error;
        }
    };

    const retryResult = (result: GenerationResult) => {
        const requestConfig = configFromLogConfig(effectiveConfig, result.config, "1");
        const snapshot = buildRequestSnapshot({
            promptText: result.prompt,
            referenceItems: result.references,
            taskCount: 1,
            configOverride: requestConfig,
            displayConfigOverride: displayConfigFromLogConfig(requestConfig, result.config, "1"),
        });
        if (!snapshot) return;
        setResults((value) => value.filter((item) => item.id !== result.id));
        void submitGenerationBatch(snapshot);
    };

    const handleWorkflowTaskStarted = (task: WorkflowExternalTaskStart) => {
        const configSnapshot = buildGenerationLogConfig({
            ...effectiveConfig,
            ...task.config,
            model: task.model,
            imageModel: task.model,
            apiMode: task.apiMode,
            count: String(task.count),
        });
        const pendingItems: GenerationResult[] = Array.from({ length: task.count }, (_, index) => ({
            id: createWorkflowResultId(task.taskId, index),
            status: "pending",
            createdAt: task.startedAt,
            prompt: task.prompt,
            model: task.model,
            config: configSnapshot,
            references: task.references || [],
            workflowId: task.workflowId,
            workflowName: task.workflowName,
            workflowInputs: task.inputs,
            workflowTaskId: task.taskId,
        }));
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        setResults((value) => [...pendingItems, ...value]);
        setNow(Date.now());
    };

    const handleWorkflowTaskSuccess = (task: WorkflowExternalTaskSuccess) => {
        setResults((value) => {
            const next = [...value];
            task.images.forEach((image, index) => {
                const resultId = createWorkflowResultId(task.taskId, index);
                const existingIndex = next.findIndex((item) => item.id === resultId);
                const nextImage: GeneratedImage = {
                    id: image.id,
                    dataUrl: image.imageUrl,
                    storageKey: image.storageKey,
                    durationMs: image.durationMs || task.durationMs,
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                };
                if (existingIndex >= 0) {
                    next[existingIndex] = { ...next[existingIndex], status: "success", image: nextImage, durationMs: task.durationMs };
                } else {
                    next.unshift({
                        id: resultId,
                        status: "success",
                        createdAt: task.endedAt,
                        prompt: image.prompt,
                        model: effectiveConfig.imageModel || effectiveConfig.model,
                        config: buildGenerationLogConfig(effectiveConfig),
                        references: [],
                        image: nextImage,
                        durationMs: task.durationMs,
                        workflowId: image.workflowId,
                        workflowName: image.workflowName,
                        workflowTaskId: task.taskId,
                    });
                }
            });
            return next;
        });
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        void refreshLogs().then(() => {
            setResults((value) => value.filter((item) => item.workflowTaskId !== task.taskId));
        });
    };

    const handleWorkflowTaskFailure = (task: WorkflowExternalTaskFailure) => {
        setResults((value) =>
            value.map((item) =>
                item.workflowTaskId === task.taskId
                    ? {
                          ...item,
                          status: "failed",
                          error: task.error,
                          durationMs: task.durationMs,
                      }
                    : item,
            ),
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className={`${workbenchLayout === "side" ? "grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]" : "relative flex flex-col"} min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:overflow-hidden`}>
                {workbenchLayout === "side" ? (
                    <>
                        <WorkbenchPanel
                            layout="side"
                            currentLayout={workbenchLayout}
                            collapsedSections={collapsedSections}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onToggleSection={toggleCollapsedSection}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={clearPrompt}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            uploadingCount={uploadingCount}
                        />
                        <ResultsPanel
                            results={results}
                            logs={logs}
                            historyIndex={historyIndex}
                            historyTotal={historyTotal}
                            historyPage={historyPage}
                            historyPageSize={historyPageSize}
                            historyLoading={historyLoading}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onHistoryPageChange={(page, pageSize) => {
                                setHistoryPage(page);
                                setHistoryPageSize(pageSize);
                            }}
                            onCreateSession={createSession}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onSaveAsset={saveResultToAssets}
                            onRetry={retryResult}
                        />
                    </>
                ) : (
                    <>
                        <ResultsPanel
                            className="min-h-[360px] flex-1 pb-40 lg:pb-44"
                            results={results}
                            logs={logs}
                            historyIndex={historyIndex}
                            historyTotal={historyTotal}
                            historyPage={historyPage}
                            historyPageSize={historyPageSize}
                            historyLoading={historyLoading}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onHistoryPageChange={(page, pageSize) => {
                                setHistoryPage(page);
                                setHistoryPageSize(pageSize);
                            }}
                            onCreateSession={createSession}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onSaveAsset={saveResultToAssets}
                            onRetry={retryResult}
                        />
                        <WorkbenchPanel
                            layout="bottom"
                            currentLayout={workbenchLayout}
                            collapsedSections={collapsedSections}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onToggleSection={toggleCollapsedSection}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={clearPrompt}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            uploadingCount={uploadingCount}
                        />
                    </>
                )}
            </main>
            <button
                ref={workflowButtonRef}
                type="button"
                className="fixed z-50 inline-flex touch-none select-none items-center gap-2 rounded-full border border-sky-300/70 bg-white/90 px-4 py-3 text-sm font-semibold text-stone-950 shadow-[0_18px_50px_rgba(14,165,233,0.28),0_8px_18px_rgba(0,0,0,0.14)] ring-1 ring-white/70 backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-sky-300 hover:bg-white hover:shadow-[0_22px_64px_rgba(14,165,233,0.36),0_10px_22px_rgba(0,0,0,0.18)] dark:border-sky-400/40 dark:bg-stone-900/88 dark:text-stone-100 dark:ring-white/10 dark:hover:bg-stone-900"
                style={{
                    left: (typeof window === "undefined" ? defaultWorkflowButtonPosition() : clampWorkflowButtonPosition(workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition())).x,
                    top: (typeof window === "undefined" ? defaultWorkflowButtonPosition() : clampWorkflowButtonPosition(workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition())).y
                }}
                onPointerDown={handleWorkflowButtonPointerDown}
                onPointerMove={handleWorkflowButtonPointerMove}
                onPointerUp={handleWorkflowButtonPointerUp}
                onClick={() => {
                    if (workflowButtonDragRef.current?.moved) {
                        workflowButtonDragRef.current = null;
                        return;
                    }
                    workflowButtonDragRef.current = null;
                    setWorkflowDrawerOpen(true);
                }}
            >
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.9)]" />
                <WandSparkles className="size-4 text-sky-500 dark:text-sky-300" />
                工作流
            </button>
            <Drawer title="创作工作流" placement="right" size="min(1120px, 92vw)" open={workflowDrawerOpen}  onClose={() => setWorkflowDrawerOpen(false)} styles={{ body: { padding: 0 } }} destroyOnHidden={false}>
                <CreativeWorkflowWorkspace
                    embedded
                    hideTaskList
                    onWorkflowTaskStarted={handleWorkflowTaskStarted}
                    onWorkflowTaskSuccess={handleWorkflowTaskSuccess}
                    onWorkflowTaskFailure={handleWorkflowTaskFailure}
                    onGenerationLogSaved={() => {
                        void (async () => {
                            const nextCategories = await readStoredCategories();
                            setCategories(nextCategories);
                            setHistoryPage(1);
                            await refreshLogs();
                            schedulePersistImageHistory(nextCategories);
                        })();
                    }}
                />
            </Drawer>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

const quickSizeOptions = [
    { value: "auto", label: "auto" },
    { value: "1:1", label: "1:1" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "9:16", label: "9:16" },
    { value: "2048x2048", label: "1:1 2k" },
    { value: "2048x1152", label: "16:9 2k" },
    { value: "1152x2048", label: "9:16 2k" },
    { value: "4096x4096", label: "1:1 4k" },
    { value: "3840x2160", label: "16:9 4k" },
    { value: "2160x3840", label: "9:16 4k" },
];

const quickQualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];

const quickFormatOptions = [
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
];

const quickModerationOptions = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
];

function WorkbenchPanel({
    layout,
    currentLayout,
    collapsedSections,
    prompt,
    references,
    config,
    model,
    canGenerate,
    pendingCount,
    updateConfig,
    openConfigDialog,
    onLayoutChange,
    onToggleSection,
    onPromptChange,
    onOpenPromptLibrary,
    onOpenAssetPicker,
    onPastePrompt,
    onClearPrompt,
    onPasteReferences,
    onUploadReferences,
    onRemoveReference,
    onGenerate,
    uploadingCount,
}: {
    layout: WorkbenchLayout;
    currentLayout: WorkbenchLayout;
    collapsedSections: CollapsedSections;
    prompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    canGenerate: boolean;
    pendingCount: number;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onToggleSection: (section: CollapsibleSectionKey) => void;
    onPromptChange: (value: string) => void;
    onOpenPromptLibrary: () => void;
    onOpenAssetPicker: () => void;
    onPastePrompt: () => void;
    onClearPrompt: () => void;
    onPasteReferences: () => void;
    onUploadReferences: () => void;
    onRemoveReference: (id: string) => void;
    onGenerate: () => void;
    uploadingCount: number;
}) {
    const [bottomSettingsCollapsed, setBottomSettingsCollapsed] = useState(true);

    if (layout === "bottom") {
        return (
            <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 sm:bottom-7 sm:px-8 lg:px-10">
                <div className="pointer-events-auto w-full max-w-[1040px] rounded-[20px] bg-white/65 p-3 shadow-[0_32px_100px_rgba(15,23,42,.22),0_10px_34px_rgba(15,23,42,.10)] ring-1 ring-white/50 backdrop-blur-2xl dark:bg-stone-950/60 dark:ring-white/10 dark:shadow-[0_34px_110px_rgba(0,0,0,.58)]">
                    <div className="flex flex-col gap-2.5">
                        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                            <Input.TextArea
                                value={prompt}
                                onChange={(event) => onPromptChange(event.target.value)}
                                placeholder="描述你想生成的图片，可输入 @ 来指定参考图..."
                                autoSize={{ minRows: 1, maxRows: 3 }}
                                className="rounded-2xl"
                                onPressEnter={(event) => {
                                    if (!event.shiftKey && canGenerate) onGenerate();
                                }}
                            />
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                <Button title="清空输入" icon={<Trash2 className="size-4" />} onClick={onClearPrompt} />
                                <Button title="提示词库" icon={<BookOpen className="size-4" />} onClick={onOpenPromptLibrary} />
                                <Button title="我的素材" icon={<FolderPlus className="size-4" />} onClick={onOpenAssetPicker} />
                                <Button
                                    title="参数配置"
                                    className={`lg:hidden ${!bottomSettingsCollapsed ? "!bg-sky-500/10 !text-sky-500 !border-sky-500/30" : ""}`}
                                    icon={<SlidersHorizontal className="size-4" />}
                                    onClick={() => setBottomSettingsCollapsed(!bottomSettingsCollapsed)}
                                />
                                <Button title="切换到侧边工作台" icon={<PanelLeft className="size-4" />} onClick={() => onLayoutChange("side")} />
                                <Button type="primary" className="h-9 rounded-xl lg:!hidden font-medium px-4" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                    {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                                </Button>
                            </div>
                        </div>
                        <div className={`gap-2 lg:grid-cols-[minmax(0,1fr)_132px] lg:items-end ${bottomSettingsCollapsed ? "hidden lg:grid" : "grid"}`}>
                            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[minmax(122px,1.25fr)_74px_minmax(80px,.8fr)_minmax(72px,.7fr)_minmax(72px,.7fr)_64px_minmax(70px,.7fr)_60px_60px]">
                                <label className="grid gap-1 text-[11px] leading-none text-stone-500 dark:text-stone-400">
                                    模型
                                    <ModelPicker
                                        config={config}
                                        value={model}
                                        channelId={config.imageChannelId}
                                        onChange={(value, channelId) => {
                                            updateConfig("imageModel", value);
                                            if (channelId) updateConfig("imageChannelId", channelId);
                                        }}
                                        className="canvas-compact-control !h-10 !rounded-xl"
                                        onMissingConfig={() => openConfigDialog(false)}
                                        fullWidth
                                    />
                                </label>
                                <label className="grid min-w-0 gap-1 text-[11px] leading-none text-stone-500 dark:text-stone-400">
                                    接口模式
                                    <div className="flex h-10 min-w-0 items-center overflow-hidden rounded-xl border border-stone-200 bg-background p-1 dark:border-stone-800">
                                        <Segmented
                                            size="small"
                                            className="canvas-config-mode !w-full !min-w-0 !rounded-md !p-0 !text-xs [&_.ant-segmented-item]:!min-w-0 [&_.ant-segmented-item-label]:!min-w-0 [&_.ant-segmented-item-label]:!px-1"
                                            value={config.apiMode}
                                            onChange={(value) => updateConfig("apiMode", value as "images" | "responses")}
                                            options={[
                                                { value: "images", label: "img" },
                                                { value: "responses", label: "resp" },
                                            ]}
                                        />
                                    </div>
                                </label>
                                <QuickSelect label="尺寸" value={config.size || "auto"} options={quickSizeOptions} onChange={(value) => updateConfig("size", value)} />
                                <QuickSelect label="质量" value={config.quality || "auto"} options={quickQualityOptions} onChange={(value) => updateConfig("quality", value)} />
                                <QuickSelect label="格式" value={config.outputFormat || "png"} options={quickFormatOptions} onChange={(value) => updateConfig("outputFormat", value as AiConfig["outputFormat"])} />
                                <QuickNumber label="压缩" value={config.outputCompression || "100"} min={0} max={100} disabled={(config.outputFormat || "png") === "png"} onChange={(value) => updateConfig("outputCompression", value)} />
                                <QuickSelect label="审核" value={config.moderation || "auto"} options={quickModerationOptions} onChange={(value) => updateConfig("moderation", value as AiConfig["moderation"])} />
                                <QuickNumber label="数量" value={config.count || "1"} min={1} max={10} onChange={(value) => updateConfig("count", value)} />
                                <QuickNumber label="重试" value={config.retryAttempts || "0"} min={0} max={5} onChange={(value) => updateConfig("retryAttempts", value)} />
                            </div>
                            <div className="grid gap-2 sm:grid-cols-[auto_minmax(140px,1fr)] lg:grid-cols-1">
                                <ReferenceQuickActions references={references} onUploadReferences={onUploadReferences} />
                                <Button type="primary" className="hidden h-10 rounded-xl font-medium lg:inline-flex lg:w-full lg:justify-center" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                    {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                                </Button>
                            </div>
                        </div>
                        {references.length || uploadingCount > 0 ? <ReferenceStrip className="mt-3" references={references} compact onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} /> : null}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 p-4 pb-3">
                <WorkbenchHeader currentLayout={currentLayout} onLayoutChange={onLayoutChange} />
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
                <CollapsibleWorkbenchSection title="提示词" collapsed={collapsedSections.prompt} summary={prompt.trim() || "未填写提示词"} onToggle={() => onToggleSection("prompt")}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPastePrompt}>
                                读取剪贴板
                            </Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={onClearPrompt}>
                                清空
                            </Button>
                            <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={onOpenPromptLibrary}>
                                查看提示词库
                            </Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>
                                查看我的素材
                            </Button>
                        </div>
                        <Input.TextArea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={6} placeholder="描述画面主体、风格、构图、光线和用途" />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection
                    title="参考图"
                    count={references.length}
                    collapsed={collapsedSections.references}
                    summary={references.length ? `已选择 ${references.length} 张参考图` : "暂无参考图"}
                    onToggle={() => onToggleSection("references")}
                >
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences}>
                                剪切板
                            </Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={onUploadReferences}>
                                上传
                            </Button>
                        </div>
                        <ReferenceStrip references={references} onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection title="参数" collapsed={collapsedSections.settings} summary={settingsSummary(config, model)} onToggle={() => onToggleSection("settings")}>
                    <div className="space-y-3">
                        <GenerationSettings config={config} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                    </div>
                </CollapsibleWorkbenchSection>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                    {pendingCount ? `继续提交（${pendingCount} 个生成中）` : "开始生成"}
                </Button>
            </div>
        </div>
    );
}

function WorkbenchHeader({ currentLayout, onLayoutChange, compact = false }: { currentLayout: WorkbenchLayout; onLayoutChange: (layout: WorkbenchLayout) => void; compact?: boolean }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
                <h1 className={`${compact ? "text-base" : "text-2xl"} font-semibold text-stone-950 dark:text-stone-100`}>生图工作台</h1>
            </div>
            <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                <Button size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>
                    侧边
                </Button>
                <Button size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>
                    底部
                </Button>
            </div>
        </div>
    );
}

function CollapsibleWorkbenchSection({ title, count, collapsed, summary, children, onToggle }: { title: string; count?: number; collapsed: boolean; summary: string; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={onToggle}>
                <span className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold">{title}</span>
                    {typeof count === "number" ? <Tag className="m-0 text-xs">{count}</Tag> : null}
                    {collapsed ? <span className="truncate text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ReferenceStrip({ references, compact = false, className = "", onRemoveReference, uploadingCount = 0 }: { references: ReferenceImage[]; compact?: boolean; className?: string; onRemoveReference: (id: string) => void; uploadingCount?: number }) {
    return (
        <div
            className={`hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 overscroll-x-contain dark:border-stone-700 ${compact ? "min-h-14" : "min-h-24 pb-3"} ${className}`}
            onWheel={(event) => {
                if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                event.preventDefault();
                event.currentTarget.scrollLeft += event.deltaY;
            }}
        >
            {references.map((item) => (
                <div key={item.id} className={`${compact ? "size-12" : "size-20"} group relative shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800`}>
                    <Image
                        src={item.dataUrl || undefined}
                        alt={item.name}
                        className="size-full object-cover cursor-pointer"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        preview={{
                            mask: "点击预览",
                        }}
                    />
                    <button type="button" className="absolute right-1 top-1 hidden z-10 size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label="移除参考图">
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ))}
            {Array.from({ length: uploadingCount }).map((_, i) => (
                <div key={`loading-${i}`} className={`${compact ? "size-12" : "size-20"} shrink-0 flex items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-stone-100/50 dark:bg-stone-900/50`}>
                    <LoaderCircle className="size-5 animate-spin text-stone-400" />
                </div>
            ))}
            {!references.length && !uploadingCount ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
        </div>
    );
}

function ReferenceQuickActions({ references, onUploadReferences }: { references: ReferenceImage[]; onUploadReferences: () => void }) {
    return (
        <div className="flex h-10 items-center gap-1 rounded-xl border border-stone-200 bg-background px-2 dark:border-stone-800">
            {references[0] ? <img src={references[0].dataUrl || undefined} alt={references[0].name} className="size-6 rounded object-cover" /> : null}
            {references.length ? <span className="min-w-6 text-xs text-stone-500">{references.length} 张</span> : null}
            <Button size="small" type="text" icon={<Upload className="size-3.5" />} onClick={onUploadReferences} />
        </div>
    );
}

function QuickSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-[11px] leading-none text-stone-500 dark:text-stone-400">
            {label}
            <select className="h-10 min-w-0 rounded-xl border border-stone-200 bg-background px-2 text-xs text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((item) => (
                    <option key={item.value} value={item.value}>
                        {item.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function QuickNumber({ label, value, min, max, disabled, onChange }: { label: string; value: string; min: number; max: number; disabled?: boolean; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-[11px] leading-none text-stone-500 dark:text-stone-400">
            {label}
            <input
                className="h-10 min-w-0 rounded-xl border border-stone-200 bg-background px-2 text-xs text-stone-900 outline-none disabled:opacity-50 dark:border-stone-800 dark:text-stone-100"
                type="number"
                min={min}
                max={max}
                disabled={disabled}
                value={value}
                onChange={(event) => onChange(String(Math.max(min, Math.min(max, Number(event.target.value) || min))))}
            />
        </label>
    );
}

function settingsSummary(config: AiConfig, model: string) {
    return [
        model,
        imageSizeLabel(config.size || "auto"),
        imageQualityLabel(config.quality || "auto"),
        imageFormatLabel(config.outputFormat || "png"),
        `压缩 ${config.outputCompression || "100"}`,
        `审核 ${config.moderation || "auto"}`,
        `${config.count || "1"} 张`,
        `${config.timeout || "600"}s`,
        config.streamImages ? `流式 ${config.streamPartialImages || "1"}` : "非流式",
    ].join(" · ");
}

function ResultsPanel({
    className = "",
    results,
    logs,
    historyIndex,
    historyTotal,
    historyPage,
    historyPageSize,
    historyLoading,
    categories,
    resultViewMode,
    activeCategoryId,
    pendingCount,
    now,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onHistoryPageChange,
    onCreateSession,
    onResultViewModeChange,
    onActiveCategoryChange,
    onCreateCategory,
    onRenameCategory,
    onDeleteCategory,
    onToggleLogCategory,
    onClearLogCategories,
    onDeleteSelected,
    onDeleteLog,
    onPreviewLog,
    onRetryLog,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
    onRetry,
}: {
    className?: string;
    results: GenerationResult[];
    logs: GenerationLog[];
    historyIndex: ImageHistoryIndexEntry[];
    historyTotal: number;
    historyPage: number;
    historyPageSize: number;
    historyLoading: boolean;
    categories: GenerationCategory[];
    resultViewMode: ResultViewMode;
    activeCategoryId: string | null;
    pendingCount: number;
    now: number;
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onHistoryPageChange: (page: number, pageSize: number) => void;
    onCreateSession: () => void;
    onResultViewModeChange: (mode: ResultViewMode) => void;
    onActiveCategoryChange: (id: string | null) => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onRenameCategory: (category: GenerationCategory, name: string) => void;
    onDeleteCategory: (category: GenerationCategory) => void;
    onToggleLogCategory: (log: GenerationLog, categoryId: string) => void;
    onClearLogCategories: (log: GenerationLog) => void;
    onDeleteSelected: () => void;
    onDeleteLog: (log: GenerationLog) => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onRetry: (result: GenerationResult) => void;
}) {
    const { message } = App.useApp();
    const [creatingCategory, setCreatingCategory] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const liveImageIds = new Set(results.map((result) => result.image?.id).filter((id): id is string => Boolean(id)));
    const baseVisibleLogs = logs.filter((log) => !log.images.some((image) => liveImageIds.has(image.id)));
    const categoryGroups = categories.map((category) => {
        const entries = historyIndex.filter((entry) => entry.categoryIds.includes(category.id));
        return { category, count: entries.length, images: entries.flatMap((entry) => entry.coverImages).slice(0, 6) };
    });
    const activeCategory = activeCategoryId ? categories.find((category) => category.id === activeCategoryId) : null;
    const visibleLogs = baseVisibleLogs;
    const totalCount = results.length + historyTotal + (resultViewMode === "category" && !activeCategoryId ? categories.length : 0);
    const shouldShowGrid = totalCount > 0 || historyLoading;
    const allVisibleLogsSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleVisibleLogs = () => onSelectedLogIdsChange(allVisibleLogsSelected ? selectedLogIds.filter((id) => !visibleLogs.some((log) => log.id === id)) : Array.from(new Set([...selectedLogIds, ...visibleLogs.map((log) => log.id)])));
    const createCategory = async () => {
        const name = categoryName.trim();
        if (!name) {
            message.error("请输入分类名称");
            return;
        }
        const category = await onCreateCategory(name);
        if (!category) return;
        setCategoryName("");
        setCreatingCategory(false);
    };

    useEffect(() => {
        if (activeCategoryId && !categories.some((category) => category.id === activeCategoryId)) onActiveCategoryChange(null);
    }, [activeCategoryId, categories, onActiveCategoryChange]);

    return (
        <div className={`thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5 ${className}`}>
            <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <History className="size-4 text-stone-400" />
                    <h2 className="truncate text-xl font-semibold">{activeCategory ? activeCategory.name : "全部结果"}</h2>
                    <Tag className="m-0">{totalCount}</Tag>
                    {pendingCount ? <Tag className="m-0 px-2 py-1">{pendingCount} 个生成中</Tag> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {activeCategory ? (
                        <Button size="small" onClick={() => onActiveCategoryChange(null)}>
                            返回分类
                        </Button>
                    ) : null}
                    <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                        <Button
                            size="small"
                            type={resultViewMode === "all" ? "primary" : "text"}
                            onClick={() => {
                                onActiveCategoryChange(null);
                                onResultViewModeChange("all");
                            }}
                        >
                            全部展示
                        </Button>
                        <Button size="small" type={resultViewMode === "category" ? "primary" : "text"} onClick={() => onResultViewModeChange("category")}>
                            分类展示
                        </Button>
                    </div>
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={resultViewMode === "category" ? () => setCreatingCategory(true) : onCreateSession}>
                        {resultViewMode === "category" ? "新建分类" : "新建"}
                    </Button>
                    <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!visibleLogs.length} onClick={toggleVisibleLogs}>
                        {allVisibleLogsSelected ? "取消本页" : "全选本页"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                        删除
                    </Button>
                </div>
            </div>
            {shouldShowGrid ? (
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {results.map((result, index) =>
                        result.status === "success" && result.image ? (
                            <ResultImageCard key={result.id} result={result} image={result.image} index={index} onCopyPrompt={onCopyPrompt} onEdit={onEdit} onDownload={onDownload} onSaveAsset={onSaveAsset} />
                        ) : result.status === "failed" ? (
                            <FailedImageCard key={result.id} result={result} error={result.error || "生成失败"} onCopyPrompt={onCopyPrompt} onRetry={() => onRetry(result)} />
                        ) : (
                            <PendingImageCard key={result.id} result={result} now={now} onCopyPrompt={onCopyPrompt} />
                        ),
                    )}
                    {resultViewMode === "category" ? (
                        <>
                            {!activeCategoryId
                                ? categoryGroups.map(({ category, count, images }) => (
                                      <CategoryCard key={category.id} category={category} count={count} images={images} onRename={onRenameCategory} onDelete={onDeleteCategory} onOpen={() => onActiveCategoryChange(category.id)} />
                                  ))
                                : null}
                        </>
                    ) : null}
                    {historyLoading && !visibleLogs.length
                        ? Array.from({ length: Math.min(6, historyPageSize) }, (_, index) => (
                              <div key={`history-skeleton-${index}`} className="min-h-[360px] overflow-hidden rounded-lg border border-stone-200 bg-background p-3 dark:border-stone-800 dark:bg-stone-950 sm:min-h-[420px]">
                                  <Skeleton.Image active className="!h-52 !w-full" />
                                  <Skeleton active paragraph={{ rows: 5 }} title={false} className="mt-4" />
                              </div>
                          ))
                        : null}
                    {visibleLogs.map((log, index) => (
                        <HistoryLogCard
                            key={log.id}
                            log={log}
                            categories={categories}
                            index={index}
                            selected={selectedLogIds.includes(log.id)}
                            active={activeLogId === log.id}
                            onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                            onDelete={() => onDeleteLog(log)}
                            onToggleCategory={(categoryId) => onToggleLogCategory(log, categoryId)}
                            onClearCategories={() => onClearLogCategories(log)}
                            onCreateCategory={onCreateCategory}
                            onPreview={() => onPreviewLog(log)}
                            onRetry={() => onRetryLog(log)}
                            onCopyPrompt={onCopyPrompt}
                            onEdit={onEdit}
                            onDownload={onDownload}
                            onSaveAsset={onSaveAsset}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                    <ImagePlus className="mb-4 size-11 text-stone-400" />
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                </div>
            )}
            {historyTotal ? (
                <div className="mt-5 flex justify-center border-t border-stone-200 pt-4 dark:border-stone-800">
                    <Pagination
                        current={historyPage}
                        pageSize={historyPageSize}
                        total={historyTotal}
                        pageSizeOptions={[24, 48, 96]}
                        showSizeChanger
                        showTotal={(total) => `共 ${total} 条`}
                        onChange={onHistoryPageChange}
                    />
                </div>
            ) : null}
            <Modal title="新建分类" open={creatingCategory} onCancel={() => setCreatingCategory(false)} onOk={() => void createCategory()} okText="创建" cancelText="取消" destroyOnHidden>
                <Input value={categoryName} autoFocus placeholder="输入分类名称" onChange={(event) => setCategoryName(event.target.value)} onPressEnter={() => void createCategory()} />
            </Modal>
        </div>
    );
}

function CategoryCard({
    category,
    count,
    images,
    onRename,
    onDelete,
    onOpen,
}: {
    category: GenerationCategory;
    count: number;
    images: ImageHistoryIndexImage[];
    onRename: (category: GenerationCategory, name: string) => void;
    onDelete: (category: GenerationCategory) => void;
    onOpen: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(category.name);

    useEffect(() => {
        setName(category.name);
    }, [category.name]);

    const saveName = () => {
        const value = name.trim();
        if (!value) return;
        onRename(category, value);
        setEditing(false);
    };

    return (
        <div className="group relative min-h-[360px] overflow-hidden rounded-lg border border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60 sm:min-h-[420px]">
            <button type="button" className="absolute inset-0 z-0 text-left" onClick={onOpen} aria-label={`打开分类 ${category.name}`} />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {images.length ? (
                    <>
                        {images.map((image, index) => (
                            <LazyHistoryImage
                                key={`${image.id}-${index}`}
                                image={image}
                                alt=""
                                className={`${images.length === 1 ? "inset-0 size-full rounded-none border-0" : "h-[92%] w-[86%] rounded-lg border border-white/80 dark:border-stone-900"} absolute object-cover shadow-xl transition-transform duration-200 group-hover:scale-[1.02]`}
                                style={{
                                    left: images.length === 1 ? 0 : `${3 + index * 4}%`,
                                    top: images.length === 1 ? 0 : `${4 + index * 3}%`,
                                    transform: images.length === 1 ? "none" : `rotate(${(index - 2) * 4}deg)`,
                                    zIndex: index + 1,
                                }}
                            />
                        ))}
                    </>
                ) : (
                    <div className="flex size-full items-center justify-center text-sm text-stone-500">暂无图片</div>
                )}
            </div>
            <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3 pt-10 text-white">
                {editing ? <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onPressEnter={saveName} onBlur={saveName} /> : <div className="truncate text-sm font-semibold">{category.name}</div>}
            </div>
            <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                <Tag className="m-0 text-[10px]">{count} 条</Tag>
                <Tag className="m-0 text-[10px]">{images.length} 图</Tag>
            </div>
            <div className="absolute bottom-2 right-2 z-20 flex gap-1">
                <Button title="改名" size="small" icon={<PenLine className="size-3.5" />} onClick={() => setEditing(true)} />
                <Button title="删除" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(category)} />
            </div>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [modelCollapsed, setModelCollapsed] = useState(false);

    return (
        <div className="space-y-3">
            <SettingSubsection title="模型" summary={model || "未选择模型"} collapsed={modelCollapsed} onToggle={() => setModelCollapsed((value) => !value)}>
                <div className="space-y-2">
                    <ModelPicker config={config} value={model} channelId={config.imageChannelId} onChange={(value, channelId) => { updateConfig("imageModel", value); if (channelId) updateConfig("imageChannelId", channelId); }} fullWidth onMissingConfig={() => openConfigDialog(false)} />
                    <div className="flex items-center justify-between gap-3 pt-1">
                        <div className="text-xs opacity-75">接口模式</div>
                        <Segmented
                            size="small"
                            className="canvas-config-mode !rounded-md !p-0.5"
                            value={config.apiMode}
                            onChange={(value) => updateConfig("apiMode", value as "images" | "responses")}
                            options={[
                                { value: "images", label: "images" },
                                { value: "responses", label: "responses" },
                            ]}
                        />
                    </div>
                </div>
            </SettingSubsection>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-3" maxCount={10} collapsible />
        </div>
    );
}

function SettingSubsection({ title, summary, collapsed, children, onToggle }: { title: string; summary: string; collapsed: boolean; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left" onClick={onToggle}>
                <span className="min-w-0">
                    <span className="font-medium">{title}</span>
                    {collapsed ? <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ResultImageCard({
    result,
    image,
    index,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    result: GenerationResult;
    image: GeneratedImage;
    index: number;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="relative aspect-[4/3] bg-stone-100 dark:bg-stone-900">
                <Tag className="absolute right-1.5 top-1.5 z-10 m-0 text-[10px]" color="blue">
                    新生成
                </Tag>
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-[4/3] object-cover" />
            </div>
            <TaskInfo result={result} onCopyPrompt={onCopyPrompt} />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 text-[10px] text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)} />
                    <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)} />
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ result, now, onCopyPrompt }: { result: GenerationResult; now: number; onCopyPrompt: (text: string) => void | Promise<void> }) {
    return (
        <div className="overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="relative aspect-[4/3]">
                <div
                    className="absolute inset-0 opacity-60"
                    style={{
                        backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                        backgroundSize: "16px 16px",
                    }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                    <LoaderCircle className="size-6 animate-spin" />
                    <span>生成中</span>
                    <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">{formatDuration(Math.max(0, now - result.createdAt))}</span>
                </div>
            </div>
            <TaskInfo result={{ ...result, durationMs: Math.max(0, now - result.createdAt) }} onCopyPrompt={onCopyPrompt} />
        </div>
    );
}

function FailedImageCard({ result, error, onCopyPrompt, onRetry }: { result: GenerationResult; error: string; onCopyPrompt: (text: string) => void | Promise<void>; onRetry: () => void }) {
    const [detailOpen, setDetailOpen] = useState(false);
    const detail = result.errorDetail || error;
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-3 p-5 text-center">
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <AlertCircle className="size-7 text-red-500" />
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <TaskInfo result={result} error={error} onCopyPrompt={onCopyPrompt} />
            <div className="flex justify-end gap-2 border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" onClick={() => setDetailOpen(true)}>
                    详情
                </Button>
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{detail}</pre>
            </Modal>
        </div>
    );
}

function TaskInfo({ result, error, onCopyPrompt }: { result: GenerationResult; error?: string; onCopyPrompt: (text: string) => void | Promise<void> }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <div className="rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{result.prompt}</div>
                <div className="mt-2 flex justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(result.prompt)}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
            </div>
            {result.image?.revisedPrompt && result.image.revisedPrompt !== result.prompt ? (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-2 dark:border-stone-800 dark:bg-stone-900">
                    <div className="mb-1 font-medium text-stone-500">接口改写提示词</div>
                    <div className="line-clamp-3 whitespace-pre-wrap text-stone-700 dark:text-stone-200">{result.image.revisedPrompt}</div>
                </div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
                {result.workflowName ? (
                    <Tag className="m-0" color="cyan">
                        工作流 {result.workflowName}
                    </Tag>
                ) : null}
                <Tag className="m-0">{formatLogTime(result.createdAt)}</Tag>
                {result.config.channelName ? <Tag className="m-0">渠道 {result.config.channelName}</Tag> : null}
                <Tag className="m-0">{result.model}</Tag>
                <Tag className="m-0">{result.config.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                <Tag className="m-0">请求 {result.config.size || "auto"}</Tag>
                <Tag className="m-0">请求质量 {result.config.quality || "auto"}</Tag>
                <Tag className="m-0">{result.config.outputFormat || "png"}</Tag>
                {result.image?.width && result.image?.height ? <Tag className="m-0">实际 {result.image.actualSize || `${result.image.width}x${result.image.height}`}</Tag> : null}
                {result.image?.actualQuality ? <Tag className="m-0">实际质量 {result.image.actualQuality}</Tag> : null}
                {result.image?.bytes ? <Tag className="m-0">{formatBytes(result.image.bytes)}</Tag> : null}
                {(result.config.outputFormat || "png") !== "png" ? <Tag className="m-0">压缩 {result.config.outputCompression || "100"}</Tag> : null}
                <Tag className="m-0">审核 {result.config.moderation || "auto"}</Tag>
                {result.config.streamImages ? <Tag className="m-0">流式 {result.config.streamPartialImages || "1"}</Tag> : null}
                <Tag className="m-0">超时 {result.config.timeout || "600"}s</Tag>
                {result.durationMs ? <Tag className="m-0">{formatDuration(result.durationMs)}</Tag> : null}
            </div>
            {error ? <div className="rounded-md bg-red-100 px-2 py-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
    );
}

function HistoryLogCard({
    log,
    categories,
    index,
    selected,
    active,
    onSelectedChange,
    onDelete,
    onToggleCategory,
    onClearCategories,
    onCreateCategory,
    onPreview,
    onRetry,
    onCopyPrompt,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    log: GenerationLog;
    categories: GenerationCategory[];
    index: number;
    selected: boolean;
    active: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onToggleCategory: (categoryId: string) => void;
    onClearCategories: () => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onPreview: () => void;
    onRetry: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const displayImages = log.images.filter((image) => Boolean(image.dataUrl || image.storageKey));
    const firstImage = displayImages[0];
    const totalImageBytes = displayImages.reduce((total, image) => total + (Number(image.bytes) || 0), 0);
    const [expanded, setExpanded] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const [detailOpen, setDetailOpen] = useState(false);
    const categoryMenuRef = useRef<HTMLDivElement>(null);
    const logCategories = categories.filter((category) => log.categoryIds.includes(category.id));
    const createCategory = async () => {
        const category = await onCreateCategory(categoryName);
        if (!category) return;
        setCategoryName("");
        onToggleCategory(category.id);
        setCategoryOpen(false);
    };
    const closeThen = (action: () => void) => {
        setCategoryOpen(false);
        action();
    };

    useEffect(() => {
        if (!categoryOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!categoryMenuRef.current?.contains(event.target as Node)) setCategoryOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
    }, [categoryOpen]);

    return (
        <div className={`overflow-hidden rounded-lg border bg-background dark:bg-stone-950 ${active ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
            <div className="relative aspect-[4/3] bg-stone-100 dark:bg-stone-900">
                <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
                    <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                    {selected ? <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /> : null}
                </div>
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    <Tag className="m-0 text-[10px]" color={log.failCount ? "red" : "blue"}>
                        {log.failCount ? `失败 ${log.failCount}` : "成功"}
                    </Tag>
                    <Tag className="m-0 text-[10px]">{log.imageCount} 张</Tag>
                </div>
                {firstImage ? (
                    <HistoryThumbnail image={firstImage} alt={`历史结果 ${index + 1}`} preview />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-red-500">
                        <AlertCircle className="size-7" />
                        <span>{log.errors[0] || "没有可显示的图片"}</span>
                    </div>
                )}
                {displayImages.length > 1 ? (
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-1 overflow-hidden">
                        {displayImages.slice(0, 4).map((image) => (
                            <HistoryThumbnail key={image.id} image={image} alt="" />
                        ))}
                    </div>
                ) : null}
                <ReferenceThumbnailOverlay references={log.references} className="bottom-1.5 right-1.5" />
            </div>
            <div className="space-y-2 border-t border-stone-200 p-2.5 text-xs dark:border-stone-800">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{log.prompt}</div>
                {firstImage?.revisedPrompt && firstImage.revisedPrompt !== log.prompt ? (
                    <div className="rounded-md border border-stone-200 bg-stone-50 p-2 dark:border-stone-800 dark:bg-stone-900">
                        <div className="mb-1 font-medium text-stone-500">接口改写提示词</div>
                        <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{firstImage.revisedPrompt}</div>
                    </div>
                ) : null}
                <div className="flex items-center justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => closeThen(() => void onCopyPrompt(log.prompt))}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => closeThen(() => setExpanded((value) => !value))}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                    {logCategories.length ? (
                        logCategories.map((category) => (
                            <Tag key={category.id} className="m-0 text-[10px]" color="purple">
                                {category.name}
                            </Tag>
                        ))
                    ) : (
                        <Tag className="m-0 text-[10px]">未分类</Tag>
                    )}
                    {log.workflowName ? (
                        <Tag className="m-0 text-[10px]" color="cyan">
                            工作流 {log.workflowName}
                        </Tag>
                    ) : null}
                    <Tag className="m-0 text-[10px]">{formatLogTime(log.createdAt)}</Tag>
                    {log.config.channelName ? <Tag className="m-0 text-[10px]">渠道 {log.config.channelName}</Tag> : null}
                    <Tag className="m-0 text-[10px]">{log.model}</Tag>
                    <Tag className="m-0 text-[10px]">{log.config.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                    <Tag className="m-0 text-[10px]">请求 {log.config.size || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">请求质量 {log.config.quality || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{log.config.outputFormat || "png"}</Tag>
                    {firstImage?.width && firstImage.height ? <Tag className="m-0 text-[10px]">实际 {firstImage.actualSize || `${firstImage.width}x${firstImage.height}`}</Tag> : null}
                    {firstImage?.actualQuality ? <Tag className="m-0 text-[10px]">实际质量 {firstImage.actualQuality}</Tag> : null}
                    {firstImage?.bytes ? <Tag className="m-0 text-[10px]">{formatBytes(firstImage.bytes)}</Tag> : null}
                    {displayImages.length > 1 && totalImageBytes ? <Tag className="m-0 text-[10px]">总计 {formatBytes(totalImageBytes)}</Tag> : null}
                    {(log.config.outputFormat || "png") !== "png" ? <Tag className="m-0 text-[10px]">压缩 {log.config.outputCompression || "100"}</Tag> : null}
                    <Tag className="m-0 text-[10px]">审核 {log.config.moderation || "auto"}</Tag>
                    {log.config.streamImages ? <Tag className="m-0 text-[10px]">流式 {log.config.streamPartialImages || "1"}</Tag> : null}
                    <Tag className="m-0 text-[10px]">超时 {log.config.timeout || "600"}s</Tag>
                    <Tag className="m-0 text-[10px]">{formatDuration(log.durationMs)}</Tag>
                </div>
                {log.errors[0] ? (
                    <div className="flex items-start justify-between gap-2 rounded-md bg-red-100 px-2 py-1 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                        <span className="line-clamp-2 min-w-0">{log.errors[0]}</span>
                        <Button size="small" type="text" className="!h-auto !p-0 text-xs" onClick={() => setDetailOpen(true)}>
                            详情
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div ref={categoryMenuRef} className="relative flex flex-wrap gap-1">
                    <Button size="small" onClick={() => closeThen(onPreview)}>
                        载入
                    </Button>
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => closeThen(onRetry)}>
                        重试
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setCategoryOpen((value) => !value)}>
                        分类
                    </Button>
                    {categoryOpen ? (
                        <div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-lg border border-stone-200 bg-background p-2 shadow-xl dark:border-stone-800 dark:bg-stone-950">
                            <div className="max-h-44 space-y-1 overflow-y-auto">
                                {categories.map((category) => (
                                    <label key={category.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-900">
                                        <Checkbox checked={log.categoryIds.includes(category.id)} onChange={() => closeThen(() => onToggleCategory(category.id))} />
                                        <span className="truncate">{category.name}</span>
                                    </label>
                                ))}
                                {!categories.length ? <div className="px-2 py-3 text-center text-xs text-stone-500">暂无分类</div> : null}
                            </div>
                            <div className="mt-2 flex gap-1 border-t border-stone-200 pt-2 dark:border-stone-800">
                                <Input size="small" value={categoryName} placeholder="新分类" onChange={(event) => setCategoryName(event.target.value)} onPressEnter={() => void createCategory()} />
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => void createCategory()} />
                            </div>
                            <Button size="small" type="link" className="!mt-1 !h-auto !p-0 text-xs" onClick={() => closeThen(onClearCategories)}>
                                移至未分类
                            </Button>
                        </div>
                    ) : null}
                </div>
                {firstImage ? (
                    <div className="flex shrink-0 gap-1">
                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => closeThen(() => void onSaveAsset(firstImage, index))} />
                        <Button size="small" icon={<PenLine className="size-3.5" />} onClick={() => closeThen(() => void onEdit(firstImage, index))} />
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => closeThen(() => onDownload(firstImage, index))} />
                    </div>
                ) : null}
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{log.errorDetails?.[0] || log.errors[0] || "没有详情"}</pre>
            </Modal>
        </div>
    );
}

function ReferenceThumbnailOverlay({ references, className = "" }: { references?: ReferenceImage[]; className?: string }) {
    const visibleReferences = (references || []).filter((item) => Boolean(item.dataUrl || item.storageKey)).slice(0, 3);
    if (!visibleReferences.length) return null;
    return (
        <div className={`absolute z-10 flex items-center gap-1 rounded-md bg-black/55 p-1 shadow-sm backdrop-blur ${className}`}>
            {visibleReferences.map((item) => (
                <LazyHistoryImage key={item.id} image={item} alt={item.name} className="size-7 rounded border border-white/60" />
            ))}
            {(references || []).length > visibleReferences.length ? <span className="px-1 text-[10px] text-white">+{(references || []).length - visibleReferences.length}</span> : null}
        </div>
    );
}

function createPendingResult(id: string, snapshot: RequestSnapshot): GenerationResult {
    return {
        id,
        status: "pending",
        createdAt: Date.now(),
        prompt: snapshot.text,
        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
        config: snapshot.displayConfig,
        references: snapshot.references,
    };
}

function generationLogStorageKeys(log: GenerationLog) {
    return [...log.images.map((image) => image.storageKey), ...log.references.filter(isDisposableReferenceFile).map((image) => image.storageKey)].filter((key): key is string => Boolean(key));
}

function referenceUsedByGeneration(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    return logs.some((log) => log.references.some((item) => item.storageKey === reference.storageKey)) || results.some((result) => result.references.some((item) => item.storageKey === reference.storageKey));
}

function shouldDeleteReferenceFile(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    if (!isDisposableReferenceFile(reference)) return false;
    return !referenceUsedByGeneration(reference, logs, results);
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

function disposableLogStorageKeys(deletedLogs: GenerationLog[], remainingLogs: GenerationLog[]) {
    const deletedKeys = new Set(deletedLogs.flatMap(generationLogStorageKeys));
    const retainedKeys = new Set(remainingLogs.flatMap(generationLogStorageKeys));
    return [...deletedKeys].filter((key) => !retainedKeys.has(key));
}

function createWorkflowResultId(taskId: string, index: number) {
    return `${taskId}:${index}`;
}

function updateResult(results: GenerationResult[], id: string, next: Partial<GenerationResult>) {
    return results.map((item) => (item.id === id ? { ...item, ...next } : item));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "生成失败";
}

function errorDetail(error: unknown) {
    if (error instanceof ImageRequestError && error.detail) return error.detail;
    if (error instanceof Error) return error.stack || error.message;
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error || "生成失败");
    }
}

async function readStoredCategories() {
    if (typeof window === "undefined") return [];
    try {
        const value = await readImageHistoryCategories<GenerationCategory>();
        return value.filter((item) => item.id && item.name).sort((a, b) => a.createdAt - b.createdAt);
    } catch {
        return [];
    }
}

async function replaceStoredImageHistory(logs: GenerationLog[], categories: GenerationCategory[]) {
    if (typeof window === "undefined") return;
    const normalized = await Promise.all(logs.map((log) => normalizeLog(log)));
    await Promise.all([replaceImageHistoryLogs(normalized.map(serializeLog)), putImageHistoryCategories(categories)]);
}

function imageHistorySnapshot(logs: GenerationLog[], categories: GenerationCategory[]) {
    return {
        logs: logs.map(serializeLog),
        categories,
    };
}

async function normalizeLog(log: Partial<GenerationLog>, hydrateSources = false): Promise<GenerationLog> {
    const references = hydrateSources
        ? await Promise.all(
              (log.references || []).map(async (item) => ({
                  ...item,
                  dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
              })),
          )
        : log.references || [];
    const images = hydrateSources
        ? await Promise.all(
              (log.images || []).map(async (item) => ({
                  ...item,
                  dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
              })),
          )
        : log.images || [];
    const visibleImages = images.filter((image) => Boolean(image.dataUrl || image.storageKey));
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images: visibleImages,
        thumbnails: visibleImages.map((image) => image.dataUrl),
        errors: log.errors || [],
        errorDetails: log.errorDetails || [],
        categoryIds: Array.isArray(log.categoryIds) ? log.categoryIds : [],
        workflowId: log.workflowId,
        workflowName: log.workflowName,
        workflowInputs: log.workflowInputs,
    };
}

function filterImageHistoryIndex(index: ImageHistoryIndexEntry[], mode: ResultViewMode, activeCategoryId: string | null) {
    if (mode === "all") return index;
    if (activeCategoryId) return index.filter((entry) => entry.categoryIds.includes(activeCategoryId));
    return index.filter((entry) => !entry.categoryIds.length);
}

function HistoryThumbnail({ image, alt, preview = false }: { image: GeneratedImage; alt: string; preview?: boolean }) {
    return <LazyHistoryImage image={image} alt={alt} preview={preview} className={preview ? "block size-full" : "size-8 shrink-0 rounded border border-white/80 shadow-sm dark:border-stone-900/80"} />;
}

function LazyHistoryImage({
    image,
    alt,
    preview = false,
    className = "",
    style,
}: {
    image: ImageHistoryIndexImage;
    alt: string;
    preview?: boolean;
    className?: string;
    style?: CSSProperties;
}) {
    const rootRef = useRef<HTMLSpanElement>(null);
    const [visible, setVisible] = useState(false);
    const [src, setSrc] = useState("");
    const [originalSrc, setOriginalSrc] = useState("");

    useEffect(() => {
        const element = rootRef.current;
        if (!element) return;
        if (typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                setVisible(true);
                observer.disconnect();
            },
            { rootMargin: "400px" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        let active = true;
        void resolveImageUrl(image.storageKey, image.dataUrl)
            .then(async (source) => {
                if (!source || !active) return;
                setOriginalSrc(source);
                setSrc(source);
                if (!canCreateClientThumbnail(source)) return;
                const thumbnail = await getImageThumbnail(image.storageKey || image.id, source).catch(() => "");
                if (active && thumbnail) setSrc(thumbnail);
            })
            .catch(() => {
                if (active && image.dataUrl) {
                    setOriginalSrc(image.dataUrl);
                    setSrc(image.dataUrl);
                }
            });
        return () => {
            active = false;
        };
    }, [image.dataUrl, image.id, image.storageKey, visible]);

    return (
        <span ref={rootRef} className={`block overflow-hidden bg-stone-100 dark:bg-stone-900 ${className}`} style={style}>
            {src ? (
                preview ? (
                    <Image rootClassName="!block !size-full" src={src} preview={originalSrc ? { src: originalSrc } : false} alt={alt} className="!size-full object-cover" />
                ) : (
                    <img src={src} alt={alt} loading="lazy" decoding="async" className="size-full object-cover" />
                )
            ) : (
                <span className="block size-full animate-pulse bg-stone-200/80 dark:bg-stone-800/80" />
            )}
        </span>
    );
}

function canCreateClientThumbnail(source: string) {
    if (source.startsWith("blob:") || source.startsWith("data:")) return true;
    try {
        return new URL(source, window.location.href).origin === window.location.origin;
    } catch {
        return false;
    }
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: persistableImageUrl(item.dataUrl, item.storageKey) })),
        images: log.images.map((image) => ({ ...image, dataUrl: persistableImageUrl(image.dataUrl, image.storageKey) })),
        thumbnails: log.images.map((image) => persistableImageUrl(image.dataUrl, image.storageKey)),
    };
}

function persistableImageUrl(dataUrl?: string, storageKey?: string) {
    if (storageKey) return "";
    if (!dataUrl?.startsWith("data:image/")) return dataUrl || "";
    return "";
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
        apiMode: log.config?.apiMode || "images",
        outputFormat: log.config?.outputFormat || "png",
        outputCompression: log.config?.outputCompression || "100",
        moderation: log.config?.moderation || "auto",
        timeout: log.config?.timeout || "600",
        retryAttempts: log.config?.retryAttempts || "0",
        seed: log.config?.seed || "",
        channelId: log.config?.channelId || "",
        channelName: log.config?.channelName || "",
        streamImages: log.config?.streamImages || false,
        streamPartialImages: log.config?.streamPartialImages || "1",
        responseFormatB64Json: log.config?.responseFormatB64Json !== false,
        codexCli: log.config?.codexCli || false,
    };
}

function buildGenerationLogConfig(config: AiConfig): GenerationLogConfig {
    return {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
        apiMode: config.apiMode,
        outputFormat: config.outputFormat,
        outputCompression: config.outputCompression,
        moderation: config.moderation,
        timeout: config.timeout,
        retryAttempts: config.retryAttempts,
        seed: config.seed,
        channelId: config.imageChannelId || config.activeChannelId,
        channelName: resolveChannelName(config, config.imageChannelId || config.activeChannelId),
        streamImages: config.streamImages,
        streamPartialImages: config.streamPartialImages,
        responseFormatB64Json: config.responseFormatB64Json,
        codexCli: config.codexCli,
    };
}

function configFromLogConfig(base: AiConfig, saved: GenerationLogConfig, count: string): AiConfig {
    const channelId = saved.channelId || base.imageChannelId || base.activeChannelId;
    const imageModel = saved.imageModel || saved.model || base.imageModel || base.model;
    return {
        ...base,
        model: imageModel,
        imageModel,
        quality: saved.quality || base.quality,
        size: saved.size || base.size,
        count,
        apiMode: saved.apiMode || base.apiMode,
        outputFormat: saved.outputFormat || base.outputFormat,
        outputCompression: saved.outputCompression || base.outputCompression,
        moderation: saved.moderation || base.moderation,
        timeout: saved.timeout || base.timeout,
        retryAttempts: saved.retryAttempts || base.retryAttempts,
        streamImages: typeof saved.streamImages === "boolean" ? saved.streamImages : base.streamImages,
        streamPartialImages: saved.streamPartialImages || base.streamPartialImages,
        responseFormatB64Json: typeof saved.responseFormatB64Json === "boolean" ? saved.responseFormatB64Json : base.responseFormatB64Json,
        codexCli: typeof saved.codexCli === "boolean" ? saved.codexCli : base.codexCli,
        seed: saved.seed ?? base.seed,
        imageChannelId: channelId || base.imageChannelId,
        activeChannelId: channelId || base.activeChannelId,
    };
}

function displayConfigFromLogConfig(config: AiConfig, saved: GenerationLogConfig, count: string): GenerationLogConfig {
    const channelId = config.imageChannelId || saved.channelId;
    return {
        ...buildGenerationLogConfig(config),
        ...saved,
        model: config.model,
        imageModel: config.imageModel,
        count,
        channelId,
        channelName: saved.channelName || resolveChannelName(config, channelId),
    };
}

function resolveChannelName(config: AiConfig, channelId?: string) {
    if (config.channelMode === "local") {
        return localChannelForActiveModel({
            ...config,
            model: config.imageModel || config.model,
            activeChannelId: channelId || config.imageChannelId,
        })?.name || "本地直连";
    }
    if (!channelId) return "";
    return config.publicChannels.find((channel) => channel.id === channelId)?.name || channelId;
}

function imageExtension(value: string) {
    const lower = value.toLowerCase();
    if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
    if (lower.includes("webp")) return "webp";
    return "png";
}

function defaultWorkflowButtonPosition() {
    if (typeof window === "undefined") return { x: 24, y: 320 };
    return { x: Math.max(16, window.innerWidth - 132), y: Math.max(96, Math.round(window.innerHeight / 2)) };
}

function clampWorkflowButtonPosition(position: { x?: number; y?: number }) {
    if (typeof window === "undefined") return { x: Number(position.x) || 24, y: Number(position.y) || 320 };
    return {
        x: Math.min(Math.max(12, Number(position.x) || 12), Math.max(12, window.innerWidth - 120)),
        y: Math.min(Math.max(72, Number(position.y) || 72), Math.max(72, window.innerHeight - 64)),
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
    errors,
    errorDetails,
    categoryIds,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
    errors: string[];
    errorDetails?: string[];
    categoryIds?: string[];
}): GenerationLog {
    const logConfig = config;
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors,
        errorDetails,
        categoryIds: categoryIds || [],
    };
}

function formatLogTime(value: number) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
