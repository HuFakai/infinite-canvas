"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Segmented } from "antd";
import { Sparkles } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { readImageMeta } from "@/lib/image-utils";
import type { AiConfig } from "@/stores/use-config-store";
import { MAX_UPSCALE_LONG_EDGE, resolveUpscaleSize } from "../utils/canvas-image-data";

export type CanvasImageSuperResolveParams = {
    model: string;
    channelId: string;
    targetLongEdge: number;
    prompt: string;
};

const targetOptions = [
    { label: "2K", value: 2048 },
    { label: "4K", value: MAX_UPSCALE_LONG_EDGE },
];

const defaultPrompt = "对输入图片执行 AI 超分辨率重建。严格保持原始构图、人物身份、文字内容、颜色、边缘位置和宽高比，不添加、删除或移动任何元素。仅恢复真实纹理、锐化边缘并减少压缩噪点，输出高分辨率清晰图片。";

export function CanvasNodeSuperResolveDialog({
    dataUrl,
    config,
    open,
    loading,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    config: AiConfig;
    open: boolean;
    loading: boolean;
    onClose: () => void;
    onConfirm: (params: CanvasImageSuperResolveParams) => void;
}) {
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [model, setModel] = useState("");
    const [channelId, setChannelId] = useState("");
    const [targetLongEdge, setTargetLongEdge] = useState(MAX_UPSCALE_LONG_EDGE);
    const [prompt, setPrompt] = useState(defaultPrompt);
    const sourceLongEdge = image ? Math.max(image.width, image.height) : 0;
    const outputSize = useMemo(() => (image ? resolveUpscaleSize(image.width, image.height, targetLongEdge) : null), [image, targetLongEdge]);
    const canGenerate = Boolean(image && model && prompt.trim() && sourceLongEdge < targetLongEdge);

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setModel(config.imageModel || config.model);
        setChannelId(config.imageChannelId || config.activeChannelId);
        setPrompt(defaultPrompt);
    }, [config.activeChannelId, config.imageChannelId, config.imageModel, config.model, dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then((meta) => {
            setImage(meta);
            setTargetLongEdge(targetOptions.find((option) => Math.max(meta.width, meta.height) < option.value)?.value || MAX_UPSCALE_LONG_EDGE);
        });
    }, [dataUrl, open]);

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={860} centered destroyOnHidden closable={!loading} maskClosable={!loading} keyboard={!loading}>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">AI 超分</h2>
                    <div className="mt-1 text-sm opacity-55">使用图片模型重建细节并输出更高分辨率结果</div>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="rounded-lg border p-4">
                        <div className="grid min-h-[300px] place-items-center overflow-hidden rounded-md bg-black/5 dark:bg-white/[.03]">
                            <img src={dataUrl} alt="" className="max-h-[340px] max-w-full object-contain" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-55">源图</span>
                            <span className="font-medium">{image ? `${image.width} x ${image.height} px` : "读取中"}</span>
                        </div>
                    </div>
                    <div className="space-y-5 py-1">
                        <label className="grid gap-2 text-sm font-medium">
                            超分模型
                            <ModelPicker
                                config={config}
                                value={model}
                                channelId={channelId}
                                onChange={(nextModel, nextChannelId) => {
                                    setModel(nextModel);
                                    setChannelId(nextChannelId || "");
                                }}
                                className="!h-10 !w-full !rounded-md"
                                fullWidth
                            />
                        </label>
                        <div className="grid gap-2 text-sm font-medium">
                            目标分辨率
                            <Segmented
                                block
                                value={targetLongEdge}
                                options={targetOptions.map((option) => ({ ...option, label: `${option.label} · ${option.value}px`, disabled: sourceLongEdge >= option.value }))}
                                onChange={(value) => setTargetLongEdge(Number(value))}
                            />
                        </div>
                        <label className="grid gap-2 text-sm font-medium">
                            增强要求
                            <Input.TextArea value={prompt} rows={5} maxLength={800} showCount onChange={(event) => setPrompt(event.target.value)} />
                        </label>
                        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                            <span className="opacity-55">预计输出</span>
                            <span className="font-medium">{outputSize ? `${outputSize.width} x ${outputSize.height} px` : "未知"}</span>
                        </div>
                        {image && sourceLongEdge >= MAX_UPSCALE_LONG_EDGE ? <div className="text-sm text-red-500">源图已经达到 4K 上限。</div> : null}
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button
                        type="primary"
                        size="large"
                        icon={<Sparkles className="size-4" />}
                        loading={loading}
                        disabled={!canGenerate}
                        onClick={() => onConfirm({ model, channelId, targetLongEdge, prompt: prompt.trim() })}
                    >
                        开始 AI 超分
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
