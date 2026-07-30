"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { Compass, FileText, Home, ImageIcon, ImagePlus, Images, List, Maximize2, Menu, MessageSquare, Plus, Redo2, Settings2, Trash2, Undo2, Upload, ChevronLeft, ChevronRight } from "lucide-react";
import { saveAs } from "file-saver";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { defaultConfig, type AiConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { collectImageStorageKeys, deleteStoredImages, resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { nanoid } from "nanoid";
import { formatBytes, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, resolveUpscaleSize, splitDataUrl, upscaleDataUrl } from "../utils/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "../utils/canvas-node-size";
import { App, Button, Dropdown, Image, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import { ActiveConnectionPath, ConnectionPath } from "../components/canvas-connections";
import { CanvasConfigNodePanel } from "../components/canvas-config-node-panel";
import { CanvasAssistantPanel } from "../components/canvas-assistant-panel";
import { CanvasNodeContextMenu } from "../components/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "../components/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "../components/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "../components/canvas-node-split-dialog";
import { CanvasNodeSuperResolveDialog, type CanvasImageSuperResolveParams } from "../components/canvas-node-super-resolve-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "../components/canvas-node-upscale-dialog";
import { buildNodeChatMessages, buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext, type NodeGenerationInput } from "../components/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "../components/canvas-node-hover-toolbar";
import { InfiniteCanvas } from "../components/infinite-canvas";
import { Minimap } from "../components/canvas-mini-map";
import { CanvasNode } from "../components/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "../components/canvas-node-prompt-panel";
import { CanvasToolbar } from "../components/canvas-toolbar";
import { CanvasSidePanel } from "../components/canvas-side-panel";
import { AssetPickerModal, type AssetPickerTab, type InsertAssetPayload } from "../components/asset-picker-modal";
import { CanvasZoomControls } from "../components/canvas-zoom-controls";
import { useCanvasStore } from "../stores/use-canvas-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import { exportCanvasNodes } from "../utils/canvas-export";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasImageGenerationType,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "../types";
import type { ReferenceImage } from "@/types/image";

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const NODE_STATUS_IDLE = "idle" as const;

type CanvasGenerationRequest = {
    controller: AbortController;
    targetNodeIds: string[];
};

function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function CanvasRefreshShell() {
    return (
        <main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                }}
            />

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

function ConnectionCreateMenu({ pending, onCreate, onClose }: { pending: PendingConnectionCreate; onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    引用该节点生成
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label="关闭">
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本生成" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="配置节点" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

function InfiniteCanvasPage() {
    const { message } = App.useApp();
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const projectId = params.id;
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [assetPickerTab, setAssetPickerTab] = useState<AssetPickerTab>("my-assets");
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [superResolveLoading, setSuperResolveLoading] = useState(false);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewZoom, setPreviewZoom] = useState<number>(1);
    const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [isImageDragging, setIsImageDragging] = useState<boolean>(false);
    const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const [activeTool, setActiveTool] = useState<"hand" | "select">("hand");
    const [assistantCollapsed, setAssistantCollapsed] = useState(true);
    const [assistantMounted, setAssistantMounted] = useState(false);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const getBatchGroupNodes = useCallback((activeNode: CanvasNodeData | null) => {
        if (!activeNode) return [];
        const rootId = activeNode.metadata?.batchRootId || (activeNode.metadata?.isBatchRoot ? activeNode.id : null);
        if (!rootId) return [activeNode];
        return nodes.filter(
            (n) =>
                n.metadata?.batchRootId === rootId &&
                n.type === CanvasNodeType.Image &&
                n.metadata?.content
        );
    }, [nodes]);

    useEffect(() => {
        if (!previewNodeId) return;

        const handlePreviewKeyDown = (event: KeyboardEvent) => {
            const previewNode = previewNodeId ? nodesRef.current.find((n) => n.id === previewNodeId) : null;
            if (!previewNode) return;

            const group = getBatchGroupNodes(previewNode);
            if (group.length <= 1) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    setPreviewNodeId(null);
                }
                return;
            }

            const currentIndex = group.findIndex((n) => n.id === previewNodeId);

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (currentIndex > 0) {
                    setPreviewNodeId(group[currentIndex - 1].id);
                }
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                if (currentIndex < group.length - 1) {
                    setPreviewNodeId(group[currentIndex + 1].id);
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                setPreviewNodeId(null);
            }
        };

        window.addEventListener("keydown", handlePreviewKeyDown);
        return () => window.removeEventListener("keydown", handlePreviewKeyDown);
    }, [previewNodeId, getBatchGroupNodes]);

    useEffect(() => {
        setPreviewZoom(1);
        setPanOffset({ x: 0, y: 0 });
        setIsImageDragging(false);
    }, [previewNodeId]);

    useEffect(() => {
        if (previewZoom <= 1) {
            setPanOffset({ x: 0, y: 0 });
            setIsImageDragging(false);
        }
    }, [previewZoom]);

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            router.replace("/canvas");
            return;
        }

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, openProject, projectId, router]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config, pending: PendingConnectionCreate) => {
            const metadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          outputFormat: effectiveConfig.outputFormat,
                          outputCompression: effectiveConfig.outputCompression,
                          moderation: effectiveConfig.moderation,
                          count: 3,
                      }
                    : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, message, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectableNodeAtPoint = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle) => {
            const world = screenToCanvas(clientX, clientY);
            return (
                [...nodesRef.current]
                    .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                    .reverse()
                    .find(
                        (node) =>
                            node.id !== current.nodeId &&
                            Boolean(normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) &&
                            world.x >= node.position.x &&
                            world.x <= node.position.x + node.width &&
                            world.y >= node.position.y &&
                            world.y <= node.position.y + node.height,
                    )?.id || null
            );
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const canvasAgentSnapshot = useMemo<CanvasAgentSnapshot>(
        () => ({
            projectId,
            title: currentProject?.title || "未命名画布",
            nodes,
            connections,
            selectedNodeIds: Array.from(selectedNodeIds),
            viewport,
        }),
        [connections, currentProject?.title, nodes, projectId, selectedNodeIds, viewport],
    );
    const toolbarNodeCandidate = toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null;
    const toolbarNode = toolbarNodeCandidate?.type === CanvasNodeType.Group ? null : toolbarNodeCandidate;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);

    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          outputFormat: effectiveConfig.outputFormat,
                          outputCompression: effectiveConfig.outputCompression,
                          moderation: effectiveConfig.moderation,
                          count: 3,
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            // 自动级联删除：如果一个组卡片（batch root）的所有子图片都被删除了，则该组卡片本身也应该被删除
            nodesRef.current.forEach((node) => {
                if (node.metadata?.isBatchRoot && node.metadata?.batchChildIds) {
                    const allChildrenDeleted = node.metadata.batchChildIds.every((childId) => allIds.has(childId));
                    if (allChildrenDeleted) {
                        allIds.add(node.id);
                    }
                }
            });
            const removedNodes = nodesRef.current.filter((node) => allIds.has(node.id));
            const remainingNodes = nodesRef.current.filter((node) => !allIds.has(node.id));
            const removedKeys = collectImageStorageKeys(removedNodes);
            const usedKeys = collectImageStorageKeys({ nodes: remainingNodes, chatSessions, assets: useAssetStore.getState().assets });
            const disposableKeys = [...removedKeys].filter((key) => !usedKeys.has(key));
            if (disposableKeys.length) void deleteStoredImages(disposableKeys).catch((error) => message.error(error instanceof Error ? error.message : "图片文件删除失败"));
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return layoutCanvasGroups(next.map((node) => {
                    if (node.metadata?.groupId && allIds.has(node.metadata.groupId)) {
                        return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    }
                    if (node.type === CanvasNodeType.Group && node.metadata?.groupChildIds) {
                        return { ...node, metadata: { ...node.metadata, groupChildIds: node.metadata.groupChildIds.filter((childId) => !allIds.has(childId)) } };
                    }
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            storageKey: primaryNode?.metadata?.storageKey || node.metadata.storageKey,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                }));
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setUpscaleNodeId((current) => (current && allIds.has(current) ? null : current));
            setSuperResolveNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, message, projectId],
    );

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setAngleNodeId(null);
        setMaskEditNodeId(null);
        setUpscaleNodeId(null);
        setSuperResolveNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source || source.type === CanvasNodeType.Group) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const groupSelectedNodes = useCallback(() => {
        const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id) && node.type !== CanvasNodeType.Group);
        if (selected.length < 2) return;
        const bounds = selected.reduce(
            (value, node) => ({
                left: Math.min(value.left, node.position.x),
                top: Math.min(value.top, node.position.y),
                right: Math.max(value.right, node.position.x + node.width),
                bottom: Math.max(value.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const groupNode: CanvasNodeData = {
            id: groupId,
            type: CanvasNodeType.Group,
            title: "节点组",
            position: { x: bounds.left - 36, y: bounds.top - 52 },
            width: bounds.right - bounds.left + 72,
            height: bounds.bottom - bounds.top + 88,
            metadata: { status: NODE_STATUS_IDLE, groupChildIds: selected.map((node) => node.id) },
        };
        const selectedIds = new Set(selected.map((node) => node.id));
        setNodes((prev) =>
            layoutCanvasGroups([
                groupNode,
                ...prev.map((node) => {
                    if (selectedIds.has(node.id)) return { ...node, metadata: { ...node.metadata, groupId } };
                    if (node.type === CanvasNodeType.Group && node.metadata?.groupChildIds) {
                        return { ...node, metadata: { ...node.metadata, groupChildIds: node.metadata.groupChildIds.filter((id) => !selectedIds.has(id)) } };
                    }
                    return node;
                }),
            ]),
        );
        setSelectedNodeIds(new Set([groupId]));
        setSelectedConnectionId(null);
    }, []);

    const ungroupSelectedNode = useCallback(() => {
        const group = nodesRef.current.find((node) => selectedNodeIdsRef.current.has(node.id) && node.type === CanvasNodeType.Group);
        if (!group) return;
        const childIds = new Set(group.metadata?.groupChildIds || []);
        setNodes((prev) =>
            prev
                .filter((node) => node.id !== group.id)
                .map((node) => (childIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: undefined } } : node)),
        );
        setSelectedNodeIds(childIds);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...nextNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(nextNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(`无限画布 ${useCanvasStore.getState().projects.length + 1}`);
        router.push(`/canvas/${id}`);
    }, [createProject, router]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        router.push("/canvas");
    }, [cleanupAssetImages, deleteProjects, projectId, router]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            if (activeTool !== "select" && !event.ctrlKey && !event.metaKey) {
                setSelectionBox(null);
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas, activeTool],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setSelectedConnectionId(null);

        const currentSelected = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const nextSelected = new Set(currentSelected);

        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) {
                nextSelected.delete(nodeId);
            } else {
                nextSelected.add(nodeId);
            }
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }

        setSelectedNodeIds(nextSelected);
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
            node.metadata?.groupChildIds?.forEach((childId) => dragIds.add(childId));
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            setNodes((prev) =>
                layoutCanvasGroups(prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    if (!initial) return node;
                    return { ...node, position: { x: initial.x + dx, y: initial.y + dy } };
                })),
            );
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const targetNodeId = getConnectableNodeAtPoint(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = targetNodeId;
                setConnectionTargetNodeId(targetNodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectableNodeAtPoint, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const targetNodeId = getConnectableNodeAtPoint(event.clientX, event.clientY, currentConnection) || connectionTargetNodeIdRef.current;
                if (targetNodeId) {
                    connectNodes(currentConnection, targetNodeId);
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectableNodeAtPoint, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNodes = useCallback(async (files: File[], position: Position) => {
        if (!files.length) return [];
        const hideLoading = message.loading(files.length > 1 ? `正在上传 ${files.length} 张图片...` : "正在上传图片...", 0);
        try {
            const settled = await Promise.allSettled(
                files.map(async (file, index) => {
                    const image = await uploadImage(file);
                    const nodeSize = fitNodeSize(image.width, image.height);
                    const offset = index * 40;
                    return {
                        id: `image-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                        type: CanvasNodeType.Image,
                        title: file.name,
                        position: { x: position.x - nodeSize.width / 2 + offset, y: position.y - nodeSize.height / 2 + offset },
                        width: nodeSize.width,
                        height: nodeSize.height,
                        metadata: imageMetadata(image),
                    } satisfies CanvasNodeData;
                }),
            );
            const newNodes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            const failedCount = settled.length - newNodes.length;
            if (failedCount) message.warning(`${newNodes.length} 张上传成功，${failedCount} 张失败`);
            if (!newNodes.length) return [];
            setNodes((prev) => [...prev, ...newNodes]);
            setSelectedNodeIds(new Set(newNodes.map((node) => node.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(newNodes.length === 1 ? newNodes[0].id : null);
            return newNodes;
        } catch (error) {
            console.error("Upload image node failed:", error);
            message.error("图片上传失败");
            return [];
        } finally {
            hideLoading();
        }
    }, [message]);

    const createImageFileNode = useCallback((file: File, position: Position) => createImageFileNodes([file], position), [createImageFileNodes]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success("已从剪切板添加图片");
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    setConnections((prev) => prev.filter((conn) => conn.id !== selectedConnectionId));
                    setSelectedConnectionId(null);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => {
            const next = prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node));
            return prev.find((node) => node.id === nodeId)?.type === CanvasNodeType.Group ? next : layoutCanvasGroups(next);
        });
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            layoutCanvasGroups(prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            })),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return;
        const url = node.metadata.content;
        const filename = `canvas-${node.type}-${node.id}.${imageExtension(url)}`;

        if (url.startsWith("data:") || url.startsWith("blob:")) {
            saveAs(url, filename);
        } else {
                const hideLoading = message.loading("正在下载图片...", 0);
            try {
                const response = await fetch(url.startsWith("http") ? `/api/proxy-image?url=${encodeURIComponent(url)}` : url);
                const blob = await response.blob();
                saveAs(blob, filename);
            } catch (error) {
                console.error("Canvas node download error, falling back to open:", error);
                saveAs(url, filename);
            } finally {
                hideLoading();
            }
        }
    }, [message]);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const resolvedUrl = node.metadata.storageKey
                ? await resolveImageUrl(node.metadata.storageKey, node.metadata.content)
                : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: resolvedUrl,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl: resolvedUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(resolvedUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message],
    );

    const exportSelectedNodes = useCallback(async () => {
        const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id));
        if (!selected.length) return;
        const hideLoading = message.loading("正在整理选中内容...", 0);
        try {
            const selectedIds = new Set(selected.map((node) => node.id));
            const selectedConnections = connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId));
            await exportCanvasNodes(selected, selectedConnections, `${currentProject?.title || "画布"}-选中内容`);
            message.success(`已导出 ${selected.length} 个节点`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出失败");
        } finally {
            hideLoading();
        }
    }, [currentProject?.title, message]);

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: node.title ? `裁剪 - ${node.title}` : "裁剪图片",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            const hideLoading = message.loading("正在切分图片...", 0);
            try {
                const pieces = await splitDataUrl(node.metadata.content, params);
                const uploaded = await Promise.all(pieces.map((piece) => uploadImage(piece.dataUrl).then((image) => ({ ...piece, image }))));
                const gap = 28;
                const maxPieceWidth = 180;
                const nodesToAdd = uploaded.map(({ row, column, image }) => {
                    const width = Math.min(maxPieceWidth, Math.max(96, image.width));
                    const height = width * (image.height / image.width);
                    return {
                        id: nanoid(),
                        type: CanvasNodeType.Image,
                        title: `${node.title || "图片"} - ${row + 1}.${column + 1}`,
                        position: {
                            x: node.position.x + node.width + 96 + column * (maxPieceWidth + gap),
                            y: node.position.y + row * (maxPieceWidth + gap),
                        },
                        width,
                        height,
                        metadata: { ...imageMetadata(image), prompt: node.metadata?.prompt },
                    } satisfies CanvasNodeData;
                });
                setNodes((prev) => [...prev, ...nodesToAdd]);
                setConnections((prev) => [...prev, ...nodesToAdd.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
                setSelectedNodeIds(new Set(nodesToAdd.map((child) => child.id)));
                setSplitNodeId(null);
                message.success(`已生成 ${nodesToAdd.length} 个子节点`);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "图片切分失败");
            } finally {
                hideLoading();
            }
        },
        [message],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        const hideLoading = message.loading("正在放大图片...", 0);
        try {
            const upscaled = await upscaleDataUrl(node.metadata.content, params);
            const image = await uploadImage(upscaled);
            const width = Math.min(520, Math.max(260, image.width));
            const childId = nanoid();
            const child: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Image,
                title: node.title ? `放大 - ${node.title}` : "放大图片",
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width,
                height: width * (image.height / image.width),
                metadata: {
                    ...imageMetadata(image),
                    prompt: node.metadata?.prompt,
                },
            };
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            setUpscaleNodeId(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片放大失败");
        } finally {
            hideLoading();
        }
    }, [message]);

    const superResolveImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSuperResolveParams) => {
            if (!node.metadata?.content || superResolveLoading) return;
            setSuperResolveLoading(true);
            const hideLoading = message.loading("AI 超分处理中...", 0);
            try {
                const sourceMeta = await readImageMeta(node.metadata.content);
                const target = resolveUpscaleSize(sourceMeta.width, sourceMeta.height, params.targetLongEdge);
                const config: AiConfig = {
                    ...effectiveConfig,
                    model: params.model,
                    imageModel: params.model,
                    imageChannelId: params.channelId,
                    activeChannelId: params.channelId,
                    size: `${target.width}x${target.height}`,
                    quality: "high",
                    outputFormat: "png",
                    count: "1",
                };
                const reference: ReferenceImage = {
                    id: node.id,
                    name: `${node.title || "source"}.${imageExtension(node.metadata.mimeType || node.metadata.content)}`,
                    type: node.metadata.mimeType || "image/png",
                    dataUrl: node.metadata.content,
                    storageKey: node.metadata.storageKey,
                };
                const startedAt = Date.now();
                const result = (await requestEdit(config, params.prompt, [reference]))[0];
                if (!result) throw new Error("AI 超分接口没有返回图片");
                const uploaded = await uploadImage(result.dataUrl);
                const nodeSize = fitNodeSize(uploaded.width, uploaded.height, 520, 520);
                const childId = nanoid();
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: node.title ? `AI 超分 - ${node.title}` : "AI 超分结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: nodeSize.width,
                    height: nodeSize.height,
                    metadata: {
                        ...imageMetadata(uploaded),
                        ...buildImageGenerationMetadata("edit", config, 1, [reference]),
                        prompt: params.prompt,
                        imageChannelId: params.channelId,
                        durationMs: Date.now() - startedAt,
                    },
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setDialogNodeId(childId);
                setSuperResolveNodeId(null);
                message.success(`AI 超分完成：${uploaded.width} x ${uploaded.height}`);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "AI 超分失败");
            } finally {
                hideLoading();
                setSuperResolveLoading(false);
            }
        },
        [effectiveConfig, message, superResolveLoading],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const prompt = payload.prompt.trim();
            if (!prompt) return;
            const maskSource = await uploadImage(payload.sourceDataUrl);
            const textId = nanoid();
            const configId = nanoid();
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const editConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            const textNode: CanvasNodeData = {
                id: textId,
                type: CanvasNodeType.Text,
                title: "局部重绘提示词",
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: textSpec.width,
                height: textSpec.height,
                metadata: { content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14 },
            };
            const configNode: CanvasNodeData = {
                id: configId,
                type: CanvasNodeType.Config,
                title: "局部重绘配置",
                position: { x: textNode.position.x + textNode.width + 96, y: node.position.y },
                width: configSpec.width,
                height: configSpec.height,
                metadata: {
                    content: "",
                    prompt: `@[node:${node.id}] @[node:${textId}]`,
                    status: NODE_STATUS_SUCCESS,
                    generationMode: "image",
                    generationType: "edit",
                    model: editConfig.model,
                    apiMode: editConfig.apiMode,
                    imageChannelId: editConfig.imageChannelId,
                    size: editConfig.size,
                    quality: editConfig.quality,
                    outputFormat: editConfig.outputFormat,
                    outputCompression: editConfig.outputCompression,
                    moderation: editConfig.moderation,
                    retryAttempts: editConfig.retryAttempts,
                    count: 1,
                    inputOrder: [node.id, textId],
                    maskDataUrl: payload.maskDataUrl,
                    maskSourceStorageKey: maskSource.storageKey,
                },
            };
            setMaskEditNodeId(null);
            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: node.id, toNodeId: configId },
                { id: nanoid(), fromNodeId: textId, toNodeId: configId },
            ]);
            setSelectedNodeIds(new Set([configId]));
            setSelectedConnectionId(null);
            setDialogNodeId(configId);
        },
        [effectiveConfig],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationStartedAt = Date.now();
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            try {
                const image = await requestEdit(generationConfig, prompt, [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }]).then(
                    (items) => items[0],
                );
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, durationMs: Date.now() - generationStartedAt, ...generationMetadata } } : item,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, durationMs: Date.now() - generationStartedAt } } : item)));
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, openConfigDialog],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
            const target = uploadTargetRef.current;
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            if (target?.nodeId) {
                const hideLoading = message.loading("正在上传图片...", 0);
                try {
                    const [first, ...rest] = files;
                    const image = await uploadImage(first);
                    const nextSize = fitNodeSize(image.width, image.height);
                    const targetNode = nodesRef.current.find((node) => node.id === target.nodeId);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          isBatchRoot: undefined,
                                          batchRootId: undefined,
                                          batchChildIds: undefined,
                                          batchUsesReferenceImages: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          outputFormat: undefined,
                                          outputCompression: undefined,
                                          moderation: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                          imageBatchExpanded: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(target.nodeId);
                    if (rest.length) {
                        const center = targetNode ? { x: targetNode.position.x + targetNode.width / 2 + 40, y: targetNode.position.y + targetNode.height / 2 + 40 } : target.position || getCanvasCenter();
                        await createImageFileNodes(rest, center);
                    }
                } catch (err) {
                    console.error("Canvas image upload error:", err);
                    message.error("图片上传失败");
                } finally {
                    hideLoading();
                    uploadTargetRef.current = null;
                    event.target.value = "";
                }
            } else {
                try {
                    const position = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    await createImageFileNodes(files, position);
                } finally {
                    uploadTargetRef.current = null;
                    event.target.value = "";
                }
            }
        },
        [createImageFileNodes, getCanvasCenter, message, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter((item) => item.type.startsWith("image/"));
            if (!files.length) return;

            const pos = screenToCanvas(event.clientX, event.clientY);
            void createImageFileNodes(files, pos);
        },
        [createImageFileNodes, screenToCanvas],
    );

    const pasteAssistantImage = useCallback(
        (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            void createImageFileNode(file, position);
            message.success("已从剪切板添加图片");
        },
        [createImageFileNode, message, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const startGenerationRequest = useCallback((runningId: string, targetNodeIds: string[] = [runningId]) => {
        const existing = generationRequestsRef.current.get(runningId);
        existing?.controller.abort();
        const controller = new AbortController();
        generationRequestsRef.current.set(runningId, { controller, targetNodeIds });
        setRunningNodeId(runningId);
        return controller;
    }, []);

    const updateGenerationRequestTargets = useCallback((runningId: string, targetNodeIds: string[]) => {
        const request = generationRequestsRef.current.get(runningId);
        if (request) generationRequestsRef.current.set(runningId, { ...request, targetNodeIds });
    }, []);

    const finishGenerationRequest = useCallback((runningId: string) => {
        generationRequestsRef.current.delete(runningId);
        setRunningNodeId((current) => (current === runningId ? null : current));
    }, []);

    const isGenerationCanceled = useCallback((error: unknown) => (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && (error.name === "AbortError" || error.message === "请求已取消")), []);

    const stopGenerationByRunningId = useCallback(
        (runningId: string) => {
            const request = generationRequestsRef.current.get(runningId);
            if (!request) return;
            request.controller.abort();
            generationRequestsRef.current.delete(runningId);
            setRunningNodeId((current) => (current === runningId ? null : current));
            const targetIds = new Set([runningId, ...request.targetNodeIds]);
            setNodes((prev) =>
                prev.map((node) =>
                    targetIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                        ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, durationMs: node.metadata?.startedAt ? Date.now() - node.metadata.startedAt : node.metadata?.durationMs, errorDetails: undefined } }
                        : node,
                ),
            );
            message.info("已停止生成");
        },
        [message],
    );

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const controller = startGenerationRequest(nodeId, [nodeId]);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && mode === "text") {
                finishGenerationRequest(nodeId);
                return;
            }
            let pendingChildIds: string[] = [];
            const generationStartedAt = Date.now();
            if (markSourceStatus)
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const maskDataUrl = sourceNode?.metadata?.maskDataUrl;
                    const maskSourceStorageKey = sourceNode?.metadata?.maskSourceStorageKey;
                    const maskSourceUrl = maskSourceStorageKey ? await resolveImageUrl(maskSourceStorageKey, "") : "";
                    if (maskSourceStorageKey && !maskSourceUrl) throw new Error("局部重绘工作图已丢失，请重新创建配置");
                    const maskSourceReference = maskSourceUrl
                        ? [{ id: `${sourceNode?.id || nodeId}-mask-source`, name: "mask-source.png", type: "image/png", dataUrl: maskSourceUrl, storageKey: maskSourceStorageKey }]
                        : [];
                    const referenceImages = maskSourceReference.length ? maskSourceReference : sourceReference.length ? sourceReference : generationContext.referenceImages;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages, maskDataUrl);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const gap = 96;
                    const rowGap = 36;
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    updateGenerationRequestTargets(nodeId, [nodeId, ...targetIds]);
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + gap,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            startedAt: generationStartedAt,
                            durationMs: undefined,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [...(isEmptyImageNode ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))];

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    let hasSuccess = false;
                    let hasFailure = false;
                    await Promise.all(
                        targetIds.map(async (targetId, index) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1", seedIndex: index, seedCount: targetIds.length }, effectivePrompt, referenceImages, { ...(maskDataUrl ? { maskDataUrl } : {}), signal: controller.signal }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1", seedIndex: index, seedCount: targetIds.length }, effectivePrompt, { signal: controller.signal }).then((items) => items[0]);
                                
                                // 1. 乐观渲染阶段
                                const meta = await readImageMeta(image.dataUrl).catch(() => ({ width: 1024, height: 1024, mimeType: "image/png" }));
                                const imageSize = fitNodeSize(meta.width, meta.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { 
                                                    ...node.metadata, 
                                                    status: NODE_STATUS_SUCCESS,
                                                    content: image.dataUrl,
                                                    width: meta.width,
                                                    height: meta.height,
                                                    mimeType: meta.mimeType,
                                                    primaryImageId: targetId, 
                                                    seed: image.seed,
                                                    durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt) 
                                                },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { 
                                                    ...node.metadata, 
                                                    status: NODE_STATUS_SUCCESS,
                                                    content: image.dataUrl,
                                                    width: meta.width,
                                                    height: meta.height,
                                                    mimeType: meta.mimeType,
                                                    seed: image.seed,
                                                    durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt) 
                                                },
                                            };
                                        return node;
                                    });
                                });

                                // 2. 后台静默异步持久化阶段
                                void uploadImage(image.dataUrl).then((uploaded) => {
                                    setNodes((prev) =>
                                        prev.map((node) => {
                                            if (node.id !== targetId && node.id !== rootId) return node;
                                            if (node.id === rootId && node.metadata?.primaryImageId === targetId) {
                                                return {
                                                    ...node,
                                                    metadata: {
                                                        ...node.metadata,
                                                        status: NODE_STATUS_SUCCESS,
                                                        content: uploaded.url,
                                                        storageKey: uploaded.storageKey,
                                                        mimeType: uploaded.mimeType || node.metadata?.mimeType || "image/png",
                                                    },
                                                };
                                            }
                                            if (node.id === targetId) {
                                                return {
                                                    ...node,
                                                    metadata: {
                                                        ...node.metadata,
                                                        status: NODE_STATUS_SUCCESS,
                                                        content: uploaded.url,
                                                        storageKey: uploaded.storageKey,
                                                        mimeType: uploaded.mimeType || node.metadata?.mimeType || "image/png",
                                                    },
                                                };
                                            }
                                            return node;
                                        })
                                    );
                                }).catch((err) => {
                                    console.warn("后台图片持久化失败，自动降级为原始外链:", err);
                                });
                                hasSuccess = true;
                                if (isConfigNode)
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: undefined } } : node,
                                        ),
                                    );
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) throw error;
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                hasFailure = true;
                                setNodes((prev) =>
                                    prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails } } : node)),
                                );
                                return false;
                            }
                        }),
                    );
                    if (controller.signal.aborted) return;
                    if (hasFailure) message.error(hasSuccess ? "部分图片生成失败" : "全部图片生成失败");
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                          durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt),
                                          errorDetails: hasSuccess ? undefined : "全部图片生成失败",
                                      },
                                  }
                                : node.id === nodeId && isEmptyImageNode
                                  ? {
                                        ...node,
                                        metadata: {
                                            ...node.metadata,
                                            status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                            durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt),
                                            errorDetails: hasSuccess ? undefined : "全部图片生成失败",
                                        },
                                    }
                                  : node.id === rootId && !hasSuccess
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: "全部图片生成失败" } }
                                    : node,
                        ),
                    );
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                updateGenerationRequestTargets(nodeId, [nodeId, ...(childIds.length ? childIds : [nodeId])]);
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: prompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, fontSize: 14 },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const answers = await Promise.all(
                    (childIds.length ? childIds : [nodeId]).map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(generationConfig, buildNodeChatMessages({ ...generationContext, prompt: effectivePrompt }), (text) => {
                            localStreamed = text;
                            streamed = text;
                            if (isConfigNode) return;
                            setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                        }, { signal: controller.signal }).then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }));
                    }),
                );
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: undefined } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: undefined } }
                              : node.id === nodeId && !editingTextNode
                                ? { ...node, type: CanvasNodeType.Text, title: prompt.slice(0, 32) || "Generated Text", metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: undefined } }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId);
            }
        },
        [effectiveConfig, finishGenerationRequest, isGenerationCanceled, openConfigDialog, startGenerationRequest, updateGenerationRequestTargets],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          outputFormat: savedImageMetadata.outputFormat || effectiveConfig.outputFormat,
                          outputCompression: savedImageMetadata.outputCompression || effectiveConfig.outputCompression,
                          moderation: savedImageMetadata.moderation || effectiveConfig.moderation,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error("参考图片已丢失，无法继续重试");
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
                return;
            }

            const retryStartedAt = Date.now();
            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, startedAt: retryStartedAt, durationMs: undefined, errorDetails: undefined } } : item)));

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(generationConfig, buildNodeChatMessages({ ...context, prompt }), (text) => {
                        streamed = text;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                    });
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (item.metadata?.startedAt || retryStartedAt), errorDetails: undefined } } : item)));
                    return;
                }
                const retryMaskDataUrl = savedImageMetadata?.maskDataUrl;
                const image = useReferenceImages ? await requestEdit(generationConfig, prompt, retryReferenceImages || [], retryMaskDataUrl ? { maskDataUrl: retryMaskDataUrl } : {}).then((items) => items[0]) : await requestGeneration(generationConfig, prompt).then((items) => items[0]);
                
                // 1. 乐观渲染阶段
                const meta = await readImageMeta(image.dataUrl).catch(() => ({ width: 1024, height: 1024, mimeType: "image/png" }));
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = fitNodeSize(meta.width, meta.height, imageConfig.width, imageConfig.height);
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          outputFormat: generationConfig.outputFormat,
                          outputCompression: generationConfig.outputCompression,
                          moderation: generationConfig.moderation,
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                          maskDataUrl: savedImageMetadata.maskDataUrl,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryReferenceImages || []);
                
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { 
                                      ...item.metadata, 
                                      content: image.dataUrl,
                                      width: meta.width,
                                      height: meta.height,
                                      mimeType: meta.mimeType,
                                      status: NODE_STATUS_SUCCESS,
                                      prompt, 
                                      durationMs: Date.now() - retryStartedAt, 
                                      ...generationMetadata 
                                  },
                              }
                            : item,
                    ),
                );

                // 2. 后台静默异步持久化阶段
                void uploadImage(image.dataUrl).then((uploaded) => {
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          content: uploaded.url,
                                          storageKey: uploaded.storageKey,
                                          mimeType: uploaded.mimeType || item.metadata?.mimeType || "image/png",
                                      },
                                  }
                                : item,
                        ),
                    );
                }).catch((err) => {
                    console.warn("后台图片持久化失败，自动降级为原始外链:", err);
                });
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - retryStartedAt, errorDetails } } : item)));
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, message, openConfigDialog],
    );

    const applyAgentOps = useCallback(
        (ops: CanvasAgentOp[]) => {
            const next = applyCanvasAgentOps(canvasAgentSnapshot, ops);
            const runGenerationOps = ops.filter((op) => op?.type === "run_generation");
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setViewport(next.viewport);
            if (runGenerationOps.length) {
                window.setTimeout(() => {
                    runGenerationOps.forEach((op) => {
                        if (op.type !== "run_generation") return;
                        const target = next.nodes.find((node) => node.id === op.nodeId);
                        if (!target) return;
                        const mode = op.mode || target.metadata?.generationMode || "image";
                        const prompt = op.prompt || target.metadata?.prompt || target.metadata?.content || "";
                        void handleGenerateNode(op.nodeId, mode, prompt);
                    });
                }, 0);
            }
            return next;
        },
        [canvasAgentSnapshot, handleGenerateNode],
    );

    const undoAgentOps = useCallback(() => {
        undoCanvas();
        return null;
    }, [undoCanvas]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    outputFormat: effectiveConfig.outputFormat,
                    outputCompression: effectiveConfig.outputCompression,
                    moderation: effectiveConfig.moderation,
                    count: 3,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, message],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return;
            const textId = nanoid();
            const configId = nanoid();
            const promptText = "请反推这张图片的详细生成提示词，包含主体、构图、镜头、光线、色彩、材质、风格和可复用的生成参数。";
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const textNode: CanvasNodeData = {
                id: textId,
                type: CanvasNodeType.Text,
                title: "反推提示词",
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: textSpec.width,
                height: textSpec.height,
                metadata: { content: promptText, prompt: promptText, status: NODE_STATUS_SUCCESS, fontSize: 14 },
            };
            const configNode: CanvasNodeData = {
                id: configId,
                type: CanvasNodeType.Config,
                title: "反推配置",
                position: { x: textNode.position.x + textNode.width + 96, y: node.position.y },
                width: configSpec.width,
                height: configSpec.height,
                metadata: {
                    content: "",
                    prompt: `@[node:${node.id}] @[node:${textId}]`,
                    status: NODE_STATUS_SUCCESS,
                    generationMode: "text",
                    model: effectiveConfig.textModel || effectiveConfig.model,
                    textChannelId: effectiveConfig.textChannelId,
                    inputOrder: [node.id, textId],
                },
            };
            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: node.id, toNodeId: configId },
                { id: nanoid(), fromNodeId: textId, toNodeId: configId },
            ]);
            setSelectedNodeIds(new Set([configId]));
            setSelectedConnectionId(null);
            setDialogNodeId(configId);
        },
        [effectiveConfig.model, effectiveConfig.textChannelId, effectiveConfig.textModel],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const createAssistantImagePromptFlow = useCallback(
        (prompt: string, autoRun = false) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const textNode = createCanvasNode(CanvasNodeType.Text, { x: center.x - 120, y: center.y }, { content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14 });
            textNode.title = prompt.slice(0, 32) || "Agent Prompt";
            const configNode = createCanvasNode(CanvasNodeType.Config, { x: center.x + textSpec.width + 72, y: center.y }, {
                prompt: `@[node:${textNode.id}]`,
                status: NODE_STATUS_SUCCESS,
                generationMode: "image",
                model: effectiveConfig.imageModel || effectiveConfig.model,
                imageChannelId: effectiveConfig.imageChannelId,
                apiMode: effectiveConfig.apiMode,
                size: effectiveConfig.size,
                quality: effectiveConfig.quality,
                outputFormat: effectiveConfig.outputFormat,
                outputCompression: effectiveConfig.outputCompression,
                moderation: effectiveConfig.moderation,
                retryAttempts: effectiveConfig.retryAttempts,
                count: 1,
                inputOrder: [textNode.id],
            });
            textNode.width = textSpec.width;
            textNode.height = textSpec.height;
            configNode.width = configSpec.width;
            configNode.height = configSpec.height;
            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            if (autoRun) window.setTimeout(() => void handleGenerateNode(configNode.id, "image", configNode.metadata?.prompt || prompt), 0);
        },
        [effectiveConfig, handleGenerateNode, screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content);
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    const focusSidePanelNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setViewport((current) => ({
                ...current,
                x: size.width / 2 - (node.position.x + node.width / 2) * current.k,
                y: size.height / 2 - (node.position.y + node.height / 2) * current.k,
            }));
        },
        [size.height, size.width],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => router.push("/")}
                    onProjects={() => router.push("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    assistantCollapsed={assistantCollapsed}
                    onExpandAssistant={() => {
                        setAssistantMounted(true);
                        setAssistantCollapsed(false);
                    }}
                />

                <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onSelectNode={focusSidePanelNode} onInsertAsset={handleAssetInsert} onInsertPrompt={insertAssistantText} />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    activeTool={activeTool}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .filter((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
                            })
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                    />
                                );
                            })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox}
                            batchCount={batchChildCountById.get(node.id) || 0}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            renderPanel={(panelNode) => (
                                <CanvasNodePromptPanel
                                    node={panelNode}
                                    isRunning={runningNodeId === panelNode.id}
                                    onPromptChange={handleNodePromptChange}
                                    onConfigChange={handleConfigNodeChange}
                                    onGenerate={handleGenerateNode}
                                    onStop={stopGenerationByRunningId}
                                    onImageSettingsOpenChange={(open) => {
                                        setNodeImageSettingsOpen(open);
                                        if (open) setToolbarNodeId(null);
                                    }}
                                    onOpenAssetLibrary={() => {
                                        setAssetPickerTab("my-assets");
                                        setAssetPickerOpen(true);
                                    }}
                                />
                            )}
                            renderNodeContent={(contentNode) => (
                                <CanvasConfigNodePanel
                                    node={contentNode}
                                    isRunning={runningNodeId === contentNode.id}
                                    inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                                    inputs={configInputsById.get(contentNode.id) || []}
                                    onConfigChange={handleConfigNodeChange}
                                    onTextInputChange={handleNodeContentChange}
                                    onGenerate={(nodeId) => {
                                        const target = nodesRef.current.find((item) => item.id === nodeId);
                                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.prompt || "");
                                    }}
                                    onStop={stopGenerationByRunningId}
                                />
                            )}
                            onMouseDown={handleNodeMouseDown}
                            onHoverStart={(nodeId) => {
                                if (nodeDraggingRef.current) return;
                                setHoveredNodeId(nodeId);
                                keepNodeToolbar(nodeId);
                            }}
                            onHoverEnd={(nodeId) => {
                                setHoveredNodeId((current) => (current === nodeId ? null : current));
                                hideNodeToolbar();
                            }}
                            onConnectStart={handleConnectStart}
                            onResize={handleNodeResize}
                            onContentChange={handleNodeContentChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={(node) => void handleRetryNode(node)}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onContextMenu={(event, id) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
                            }}
                        />
                    ))}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: theme.canvas.selectionStroke,
                                background: theme.canvas.selectionFill,
                            }}
                        />
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    activeTool={activeTool}
                    onActiveToolChange={setActiveTool}
                    selectedCount={selectedNodeIds.size}
                    canUngroup={selectedNodeIds.size === 1 && nodes.some((node) => selectedNodeIds.has(node.id) && node.type === CanvasNodeType.Group)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onExportSelected={() => void exportSelectedNodes()}
                    onGroupSelected={groupSelectedNodes}
                    onUngroupSelected={ungroupSelectedNode}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onDeselect={deselectCanvas}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                    onOpenAssetLibrary={() => {
                        setAssetPickerTab("library");
                        setAssetPickerOpen(true);
                    }}
                    onOpenMyAssets={() => {
                        setAssetPickerTab("my-assets");
                        setAssetPickerOpen(true);
                    }}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            deleteNodes(new Set([contextMenu.nodeId]));
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                {maskEditNode?.metadata?.content ? <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => maskEditImageNode(maskEditNode!, payload)} /> : null}

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={async (crop) => { await cropImageNode(cropNode!, crop); }} /> : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} /> : null}

                {superResolveNode?.metadata?.content ? (
                    <CanvasNodeSuperResolveDialog
                        dataUrl={superResolveNode.metadata.content}
                        config={effectiveConfig}
                        open={Boolean(superResolveNode)}
                        loading={superResolveLoading}
                        onClose={() => setSuperResolveNodeId(null)}
                        onConfirm={(params) => void superResolveImageNode(superResolveNode, params)}
                    />
                ) : null}

                {previewNode?.metadata?.content ? (() => {
                    const group = getBatchGroupNodes(previewNode);
                    const isRoot = previewNode.metadata?.isBatchRoot;
                    const activeItemNode = isRoot
                        ? (group.find((n) => n.id === previewNode.metadata?.primaryImageId) || group[0] || previewNode)
                        : previewNode;

                    const currentIndex = group.findIndex((n) => n.id === activeItemNode.id);
                    const hasPrev = currentIndex > 0;
                    const hasNext = currentIndex < group.length - 1;

                    const handlePrev = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        if (hasPrev) setPreviewNodeId(group[currentIndex - 1].id);
                    };

                    const handleNext = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        if (hasNext) setPreviewNodeId(group[currentIndex + 1].id);
                    };

                    const handleDelete = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        const nextId = hasNext
                            ? group[currentIndex + 1].id
                            : hasPrev
                              ? group[currentIndex - 1].id
                              : null;
                        
                        setPreviewNodeId(nextId);
                        deleteNodes(new Set([activeItemNode.id]));
                    };

                    const handleWheel = (e: React.WheelEvent) => {
                        e.preventDefault();
                        const factor = 1.6;
                        if (e.deltaY < 0) {
                            setPreviewZoom((z) => Math.min(5, z * factor));
                        } else {
                            setPreviewZoom((z) => Math.max(0.2, z / factor));
                        }
                    };

                    const handlePointerDown = (e: React.PointerEvent) => {
                        if (previewZoom <= 1) return;
                        e.preventDefault();
                        setIsImageDragging(true);
                        dragStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    };

                    const handlePointerMove = (e: React.PointerEvent) => {
                        if (!isImageDragging) return;
                        const nextX = e.clientX - dragStartRef.current.x;
                        const nextY = e.clientY - dragStartRef.current.y;
                        setPanOffset({ x: nextX, y: nextY });
                    };

                    const handlePointerUp = (e: React.PointerEvent) => {
                        if (isImageDragging) {
                            setIsImageDragging(false);
                            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                        }
                    };

                    const naturalWidth = Math.round(activeItemNode.metadata?.naturalWidth || activeItemNode.width);
                    const naturalHeight = Math.round(activeItemNode.metadata?.naturalHeight || activeItemNode.height);
                    const mimeType = activeItemNode.metadata?.mimeType || "image/png";
                    const format = mimeType.replace("image/", "").toUpperCase();
                    const bytes = activeItemNode.metadata?.bytes || 0;
                    const sizeLabel = bytes ? formatBytes(bytes) : "";
                    const seedVal = activeItemNode.metadata?.seed;

                    return (
                        <div
                            className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/25 backdrop-blur-md transition-all duration-300 select-none cursor-zoom-out"
                            onClick={() => setPreviewNodeId(null)}
                        >
                            {/* Image Container with Zoom & Floating Metadata/Operations */}
                            <div
                                className="relative flex max-h-[85vh] max-w-[85vw] items-center justify-center overflow-visible cursor-default"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {/* Left Navigation Arrow */}
                                {group.length > 1 ? (
                                    <button
                                        type="button"
                                        disabled={!hasPrev}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            if (hasPrev) {
                                                setPreviewNodeId(group[currentIndex - 1].id);
                                            }
                                        }}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        className="absolute left-[-80px] top-1/2 z-[2010] -translate-y-1/2 flex size-14 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-all hover:bg-white/10 hover:scale-105 active:scale-95 disabled:opacity-20 disabled:cursor-not-allowed"
                                    >
                                        <ChevronLeft className="size-8" />
                                    </button>
                                ) : null}

                                {/* Right Navigation Arrow */}
                                {group.length > 1 ? (
                                    <button
                                        type="button"
                                        disabled={!hasNext}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            if (hasNext) {
                                                setPreviewNodeId(group[currentIndex + 1].id);
                                            }
                                        }}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        className="absolute right-[-80px] top-1/2 z-[2010] -translate-y-1/2 flex size-14 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-all hover:bg-white/10 hover:scale-105 active:scale-95 disabled:opacity-20 disabled:cursor-not-allowed"
                                    >
                                        <ChevronRight className="size-8" />
                                    </button>
                                ) : null}

                                {/* Top-Right Operation Overlay: Delete Button */}
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    className="absolute right-0 top-[-62px] z-[2020] flex size-12 cursor-pointer items-center justify-center rounded-full border border-red-500/20 bg-red-500/10 text-red-400 transition-all hover:bg-red-500/20 hover:scale-105 active:scale-95"
                                    title="删除图片"
                                >
                                    <Trash2 className="size-5.5" />
                                </button>

                                {/* Top Floating Metadata (No Border, Glassmorphic overlay directly on the image) */}
                                <div className="absolute left-4 top-4 z-[2015] flex flex-wrap gap-2 select-text" onClick={(e) => e.stopPropagation()}>
                                    <span className="rounded bg-black/45 px-2 py-1 text-[11px] font-medium leading-none text-white/90 backdrop-blur-md">
                                        {naturalWidth} x {naturalHeight} · {format} {sizeLabel ? ` · ${sizeLabel}` : ""}
                                        {seedVal !== undefined && seedVal !== null ? (
                                            <>
                                                {" · Seed: "}
                                                <span
                                                    className="cursor-pointer hover:underline select-all text-blue-400 font-semibold"
                                                    title="点击复制种子值"
                                                    onClick={async (event) => {
                                                        event.stopPropagation();
                                                        await navigator.clipboard.writeText(String(seedVal));
                                                        message.success(`Seed 已复制: ${seedVal}`);
                                                    }}
                                                >
                                                    {seedVal}
                                                </span>
                                            </>
                                        ) : ""}
                                        {group.length > 1 ? ` · [${currentIndex + 1} / ${group.length}]` : ""}
                                    </span>
                                </div>

                                <img
                                    src={activeItemNode.metadata?.content || ""}
                                    alt={activeItemNode.title}
                                    onWheel={handleWheel}
                                    onPointerDown={handlePointerDown}
                                    onPointerMove={handlePointerMove}
                                    onPointerUp={handlePointerUp}
                                    className={`max-h-[85vh] max-w-[85vw] object-contain rounded-2xl shadow-[0_24px_72px_rgba(0,0,0,0.4)] select-text ${previewZoom > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
                                    style={{
                                        transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${previewZoom})`,
                                        transition: isImageDragging ? "none" : "transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                                    }}
                                />
                            </div>
                        </div>
                    );
                })() : null}

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} defaultTab={assetPickerTab} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
            {assistantMounted ? (
                <CanvasAssistantPanel
                    nodes={nodes}
                    selectedNodeIds={selectedNodeIds}
                    sessions={chatSessions}
                    activeSessionId={activeChatId}
                    snapshot={canvasAgentSnapshot}
                    canUndoOps={historyState.canUndo}
                    onSelectNodeIds={setSelectedNodeIds}
                    onSessionsChange={handleAssistantSessionsChange}
                    onInsertImage={insertAssistantImage}
                    onInsertText={insertAssistantText}
                    onCreateImagePromptFlow={createAssistantImagePromptFlow}
                    onRunGeneration={(nodeId, mode, prompt) => void handleGenerateNode(nodeId, mode, prompt || nodesRef.current.find((node) => node.id === nodeId)?.metadata?.prompt || "")}
                    onApplyOps={applyAgentOps}
                    onUndoOps={undoAgentOps}
                    onPasteImage={pasteAssistantImage}
                    onCollapseStart={() => setAssistantCollapsed(true)}
                    onCollapse={() => setAssistantMounted(false)}
                />
            ) : null}
        </main>
    );
}

function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onImportImage,
    onUndo,
    onRedo,
    assistantCollapsed,
    onExpandAssistant,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
    assistantCollapsed: boolean;
    onExpandAssistant: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const accountRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [accountOpen, setAccountOpen] = useState(false);
    const router = useRouter();

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    useEffect(() => {
        if (!accountOpen) return;
        const close = (event: PointerEvent) => {
            if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [accountOpen]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between px-4">
                <div className="pointer-events-auto flex min-w-0 items-center gap-2">
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: "系统主页", onClick: () => router.push("/") },
                                { type: "divider" },
                                { key: "nav-canvas", icon: <Maximize2 className="size-4" />, label: "我的画布", onClick: () => router.push("/canvas") },
                                { key: "nav-image", icon: <ImagePlus className="size-4" />, label: "生图工作台", onClick: () => router.push("/image") },
                                { key: "nav-prompts", icon: <FileText className="size-4" />, label: "提示词库", onClick: () => router.push("/prompts") },
                                { key: "nav-assets", icon: <Images className="size-4" />, label: "我的素材", onClick: () => router.push("/assets") },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} title="页面导航" aria-label="页面导航">
                            <Compass className="size-5" />
                        </button>
                    </Dropdown>

                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: "主页", onClick: onHome },
                                { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: "导入图片", onClick: onImportImage },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-5" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                                onDoubleClick={onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                </div>

                <div className="pointer-events-auto flex items-center gap-1.5">
                    <UserStatusActions
                        variant="canvas"
                        accountOpen={accountOpen}
                        onAccountOpenChange={setAccountOpen}
                        accountRef={accountRef}
                        getPopupContainer={(node) => node.parentElement || document.body}
                        onOpenShortcuts={() => {
                            setShortcutsOpen(true);
                            setAccountOpen(false);
                        }}
                    />
                    {assistantCollapsed ? (
                        <>
                            <span className="h-6 w-px" style={{ background: theme.toolbar.border }} />
                            <Button
                                type="text"
                                className="!h-10 !rounded-xl !px-3 !font-medium"
                                style={{ background: theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }}
                                icon={<MessageSquare className="size-4" />}
                                onClick={onExpandAssistant}
                            >
                                助手
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["拖动画布"]} value="平移视图" />
                    <Shortcut keys={["滚轮"]} value="缩放画布" />
                    <Shortcut keys={["缩放滑杆"]} value="精确调整缩放" />
                    <Shortcut keys={["Ctrl / Cmd", "拖动"]} value="框选多个节点" />
                    <Shortcut keys={["Shift / Ctrl / Cmd", "点击"]} value="追加选择节点" />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value="全选节点" />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value="复制 / 粘贴节点，或粘贴剪切板文本/图片" />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value="撤销" />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value="重做" />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value="重做" />
                    <Shortcut keys={["Delete / Backspace"]} value="删除选中" />
                    <Shortcut keys={["Esc"]} value="取消选择并关闭浮层" />
                    <Shortcut keys={["拖入图片"]} value="上传到画布" />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}

function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[], maskDataUrl?: string): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        outputFormat: config.outputFormat,
        outputCompression: config.outputCompression,
        moderation: config.moderation,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
        maskDataUrl,
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const isStoredImage = url.startsWith("image:") || url.startsWith("server:");
            const dataUrl = isStoredImage ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: isStoredImage ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            if (node.type !== CanvasNodeType.Image || !content) return node;
            if (node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveImageUrl(node.metadata.storageKey, content) } };
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                    images: await Promise.all((message.images || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const next = { ...node, metadata: { ...node.metadata, ...(patch || {}) } };
    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof patch?.size === "string" && node.type === CanvasNodeType.Image && !node.metadata?.content ? nodeSizeFromRatio(patch.size, spec.width, spec.height) : null;
    return size ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

function layoutCanvasGroups(nodes: CanvasNodeData[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const groups = new Map<string, string[]>();
    nodes.forEach((node) => {
        if (node.type !== CanvasNodeType.Group) return;
        const childIds = (node.metadata?.groupChildIds || []).filter((id) => nodeById.get(id)?.type !== CanvasNodeType.Group);
        if (childIds.length) groups.set(node.id, childIds);
    });
    return nodes.flatMap((node) => {
        if (node.type === CanvasNodeType.Group) {
            const childIds = groups.get(node.id);
            if (!childIds?.length) return [];
            const children = childIds.map((id) => nodeById.get(id)!).filter(Boolean);
            const left = Math.min(...children.map((child) => child.position.x));
            const top = Math.min(...children.map((child) => child.position.y));
            const right = Math.max(...children.map((child) => child.position.x + child.width));
            const bottom = Math.max(...children.map((child) => child.position.y + child.height));
            return [{ ...node, position: { x: left - 36, y: top - 52 }, width: right - left + 72, height: bottom - top + 88, metadata: { ...node.metadata, groupChildIds: childIds } }];
        }
        if (node.metadata?.groupId && !groups.has(node.metadata.groupId)) return [{ ...node, metadata: { ...node.metadata, groupId: undefined } }];
        return [node];
    });
}

function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
    };
}

function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : config.textModel;
    const activeChannelId = mode === "image" ? node?.metadata?.imageChannelId || config.imageChannelId : mode === "text" ? node?.metadata?.textChannelId || config.textChannelId : "";
    return {
        ...config,
        model: node?.metadata?.model || defaultModel || config.model || defaultConfig.model,
        apiMode: node?.metadata?.apiMode || config.apiMode || defaultConfig.apiMode,
        activeChannelId,
        imageChannelId: node?.metadata?.imageChannelId || config.imageChannelId,
        textChannelId: node?.metadata?.textChannelId || config.textChannelId,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        outputFormat: node?.metadata?.outputFormat || config.outputFormat || defaultConfig.outputFormat,
        outputCompression: node?.metadata?.outputCompression || config.outputCompression || defaultConfig.outputCompression,
        moderation: node?.metadata?.moderation || config.moderation || defaultConfig.moderation,
        retryAttempts: node?.metadata?.retryAttempts || config.retryAttempts || defaultConfig.retryAttempts,
        count: String(node?.metadata?.count || (mode === "image" ? 3 : config.count) || defaultConfig.count),
        seed: node?.metadata?.seed !== undefined ? String(node.metadata.seed) : config.seed,
    };
}

function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) => (node.metadata?.status === "loading" ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } } : node));
}

function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
