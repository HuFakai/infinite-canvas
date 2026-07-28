"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, Input, Spin, Tabs } from "antd";
import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Layers3, Search } from "lucide-react";

import { usePromptList } from "@/components/prompts/use-prompt-list";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "../types";
import { CanvasNodeType } from "../types";
import type { InsertAssetPayload } from "./asset-picker-modal";

const PANEL_WIDTH_KEY = "infinite-canvas:side-panel-width";

export function CanvasSidePanel({
    nodes,
    selectedNodeIds,
    onSelectNode,
    onInsertAsset,
    onInsertPrompt,
}: {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onSelectNode: (nodeId: string) => void;
    onInsertAsset: (payload: InsertAssetPayload) => void;
    onInsertPrompt: (prompt: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const assets = useAssetStore((state) => state.assets);
    const [collapsed, setCollapsed] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [width, setWidth] = useState(280);
    const widthRef = useRef(width);
    const resizingRef = useRef(false);
    const promptList = usePromptList({ keyword, tags: [], category: "全部", enabled: !collapsed });

    useEffect(() => {
        const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(saved) && saved >= 240 && saved <= 420) {
            widthRef.current = saved;
            setWidth(saved);
        }
    }, []);

    useEffect(() => {
        const move = (event: MouseEvent) => {
            if (!resizingRef.current) return;
            const next = Math.max(240, Math.min(420, event.clientX));
            widthRef.current = next;
            setWidth(next);
        };
        const stop = () => {
            if (!resizingRef.current) return;
            resizingRef.current = false;
            window.localStorage.setItem(PANEL_WIDTH_KEY, String(widthRef.current));
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", stop);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", stop);
        };
    }, []);

    const filteredNodes = useMemo(() => {
        const value = keyword.trim().toLowerCase();
        return nodes.filter((node) => !value || `${node.title} ${node.metadata?.prompt || ""} ${node.metadata?.content || ""}`.toLowerCase().includes(value));
    }, [keyword, nodes]);
    const filteredAssets = useMemo(() => {
        const value = keyword.trim().toLowerCase();
        return assets.filter((asset) => !value || `${asset.title} ${(asset.tags || []).join(" ")}`.toLowerCase().includes(value));
    }, [assets, keyword]);

    if (collapsed) {
        return (
            <button
                type="button"
                className="absolute left-2 top-16 z-50 grid size-9 place-items-center rounded-md border"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                onClick={() => setCollapsed(false)}
                aria-label="展开画布侧栏"
            >
                <ChevronRight className="size-4" />
            </button>
        );
    }

    return (
        <aside className="absolute bottom-3 left-3 top-14 z-40 flex overflow-hidden rounded-lg border backdrop-blur" style={{ width, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 items-center justify-between border-b px-3" style={{ borderColor: theme.toolbar.border }}>
                    <span className="text-sm font-medium">画布资源</span>
                    <button type="button" className="grid size-7 place-items-center rounded-md hover:opacity-70" onClick={() => setCollapsed(true)} aria-label="收起画布侧栏">
                        <ChevronLeft className="size-4" />
                    </button>
                </div>
                <div className="px-3 pt-3">
                    <Input size="small" allowClear prefix={<Search className="size-3.5 opacity-50" />} placeholder="搜索元素、素材或提示词" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                </div>
                <Tabs
                    className="min-h-0 flex-1 px-3 [&_.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content-holder]:overflow-y-auto [&_.ant-tabs-content]:h-full [&_.ant-tabs-tabpane]:h-full"
                    size="small"
                    items={[
                        {
                            key: "elements",
                            label: "元素",
                            children: <ElementList nodes={filteredNodes} selectedNodeIds={selectedNodeIds} onSelect={onSelectNode} />,
                        },
                        {
                            key: "assets",
                            label: "素材",
                            children: (
                                <div className="grid grid-cols-2 gap-2 pb-3">
                                    {filteredAssets.map((asset) => (
                                        <button
                                            key={asset.id}
                                            type="button"
                                            className="overflow-hidden rounded-md border text-left"
                                            style={{ borderColor: theme.toolbar.border, background: theme.node.panel }}
                                            onClick={() =>
                                                asset.kind === "text"
                                                    ? onInsertAsset({ kind: "text", title: asset.title, content: asset.data.content, assetId: asset.id, source: "asset" })
                                                    : onInsertAsset({
                                                          kind: "image",
                                                          title: asset.title,
                                                          dataUrl: asset.data.dataUrl,
                                                          storageKey: asset.data.storageKey,
                                                          assetId: asset.id,
                                                          width: asset.data.width,
                                                          height: asset.data.height,
                                                          bytes: asset.data.bytes,
                                                          mimeType: asset.data.mimeType,
                                                          source: "asset",
                                                      })
                                            }
                                        >
                                            {asset.kind === "image" ? <img src={asset.coverUrl || asset.data.dataUrl} alt={asset.title} className="aspect-square w-full object-cover" /> : <div className="line-clamp-4 aspect-square p-2 text-xs leading-5 opacity-70">{asset.data.content}</div>}
                                            <div className="truncate px-2 py-1.5 text-xs">{asset.title}</div>
                                        </button>
                                    ))}
                                </div>
                            ),
                        },
                        {
                            key: "prompts",
                            label: "提示词",
                            children: promptList.query.isLoading ? (
                                <div className="grid h-32 place-items-center"><Spin size="small" /></div>
                            ) : (
                                <div className="space-y-2 pb-3">
                                    {promptList.items.map((prompt) => (
                                        <button key={prompt.id} type="button" className="w-full rounded-md border p-2 text-left" style={{ borderColor: theme.toolbar.border, background: theme.node.panel }} onClick={() => onInsertPrompt(prompt.prompt)}>
                                            <div className="truncate text-xs font-medium">{prompt.title}</div>
                                            <div className="mt-1 line-clamp-3 text-xs leading-5 opacity-55">{prompt.prompt}</div>
                                        </button>
                                    ))}
                                </div>
                            ),
                        },
                    ]}
                />
            </div>
            <div className="w-1 cursor-col-resize opacity-0 transition hover:opacity-100" style={{ background: theme.node.activeStroke }} onMouseDown={() => (resizingRef.current = true)} />
        </aside>
    );
}

function ElementList({ nodes, selectedNodeIds, onSelect }: { nodes: CanvasNodeData[]; selectedNodeIds: Set<string>; onSelect: (nodeId: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!nodes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无元素" className="py-12" />;
    return (
        <div className="space-y-1 pb-3">
            {nodes.map((node) => (
                <button
                    key={node.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border p-1.5 text-left"
                    style={{ borderColor: selectedNodeIds.has(node.id) ? theme.node.activeStroke : "transparent", background: selectedNodeIds.has(node.id) ? theme.toolbar.activeBg : "transparent" }}
                    onClick={() => onSelect(node.id)}
                >
                    <NodePreview node={node} />
                    <span className="min-w-0 flex-1 truncate text-xs">{node.title}</span>
                </button>
            ))}
        </div>
    );
}

function NodePreview({ node }: { node: CanvasNodeData }) {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return <img src={node.metadata.content} alt="" className="size-9 shrink-0 rounded object-cover" />;
    const Icon = node.type === CanvasNodeType.Text ? FileText : node.type === CanvasNodeType.Group ? Layers3 : ImageIcon;
    return <span className="grid size-9 shrink-0 place-items-center rounded bg-current/10"><Icon className="size-4 opacity-60" /></span>;
}
