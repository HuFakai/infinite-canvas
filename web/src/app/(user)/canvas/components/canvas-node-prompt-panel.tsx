"use client";

import { useEffect, useState } from "react";
import { ArrowUp, Library, LoaderCircle } from "lucide-react";
import { Button, Segmented, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenAssetLibrary?: () => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onImageSettingsOpenChange, onOpenAssetLibrary }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(isEditingExistingContent ? "" : node.metadata?.prompt || "");

    useEffect(() => {
        setPrompt(isEditingExistingContent ? "" : node.metadata?.prompt || "");
    }, [isEditingExistingContent, node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
        setPrompt("");
    };

    return (
        <div
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <textarea
                value={prompt}
                onChange={(event) => updatePrompt(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    event.preventDefault();
                    submit();
                }}
                className="thin-scrollbar h-24 w-full resize-none rounded-xl border px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                placeholder={mode === "image" ? (hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容") : hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容"}
            />

            {mode === "image" && (
                <div className="mt-2 flex items-center justify-between gap-3 px-1" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="text-xs opacity-75">接口模式</div>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={config.apiMode}
                        onChange={(value) => onConfigChange(node.id, { apiMode: value as "images" | "responses" })}
                        options={[
                            { value: "images", label: "标准 (Images)" },
                            { value: "responses", label: "对话 (Responses)" },
                        ]}
                    />
                </div>
            )}

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {onOpenAssetLibrary && (
                        <Tooltip title="素材库">
                            <Button
                                type="text"
                                className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                                style={{ color: theme.node.text }}
                                icon={<Library className="size-3.5" />}
                                onClick={onOpenAssetLibrary}
                                aria-label="素材库"
                            />
                        </Tooltip>
                    )}
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} channelId={config.imageChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, ...(channelId ? { imageChannelId: channelId } : {}) })} onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : (
                        <ModelPicker config={config} value={config.model} channelId={config.textChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, ...(channelId ? { textChannelId: channelId } : {}) })} onMissingConfig={() => openConfigDialog(true)} />
                    )}
                </div>
                <Button type="primary" className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3" disabled={isRunning || !prompt.trim()} onClick={submit} aria-label="生成">
                    <span className="flex items-center gap-1.5">
                        {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                    </span>
                </Button>
            </div>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : globalConfig.textModel;
    return {
        ...globalConfig,
        model: node.metadata?.model || defaultModel || globalConfig.model || defaultConfig.model,
        apiMode: node.metadata?.apiMode || globalConfig.apiMode || defaultConfig.apiMode,
        imageChannelId: node.metadata?.imageChannelId || globalConfig.imageChannelId,
        textChannelId: node.metadata?.textChannelId || globalConfig.textChannelId,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        outputFormat: node.metadata?.outputFormat || globalConfig.outputFormat || defaultConfig.outputFormat,
        outputCompression: node.metadata?.outputCompression || globalConfig.outputCompression || defaultConfig.outputCompression,
        moderation: node.metadata?.moderation || globalConfig.moderation || defaultConfig.moderation,
        count: String(node.metadata?.count || (mode === "image" ? 3 : globalConfig.count) || defaultConfig.count),
    };
}
