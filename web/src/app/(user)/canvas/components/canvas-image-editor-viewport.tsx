"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Button, Tooltip } from "antd";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";

type ImageSize = {
    width: number;
    height: number;
};

const viewportPadding = 24;
const minZoom = 1;
const maxZoom = 4;
const zoomStep = 1.25;

export function CanvasImageEditorViewport({
    image,
    stageRef,
    children,
    className = "h-[440px]",
}: {
    image: ImageSize;
    stageRef?: Ref<HTMLDivElement>;
    children: ReactNode;
    className?: string;
}) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const spacePressedRef = useRef(false);
    const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
    const [baseSize, setBaseSize] = useState({ width: 1, height: 1 });
    const [zoom, setZoom] = useState(1);
    const [panning, setPanning] = useState(false);

    const centerViewport = useCallback(() => {
        requestAnimationFrame(() => {
            const viewport = viewportRef.current;
            if (!viewport) return;
            viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
            viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
        });
    }, []);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const update = () => {
            const availableWidth = Math.max(1, viewport.clientWidth - viewportPadding * 2);
            const availableHeight = Math.max(1, viewport.clientHeight - viewportPadding * 2);
            const scale = Math.min(1, availableWidth / image.width, availableHeight / image.height);
            setBaseSize({ width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) });
            setZoom(1);
            centerViewport();
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [centerViewport, image.height, image.width]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.code === "Space" && !isTextInput(event.target)) {
                event.preventDefault();
                spacePressedRef.current = true;
            }
        };
        const onKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") spacePressedRef.current = false;
        };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
        };
    }, []);

    const changeZoom = (nextZoom: number) => {
        const viewport = viewportRef.current;
        const normalized = Math.min(maxZoom, Math.max(minZoom, nextZoom));
        if (!viewport || normalized === zoom) return;
        const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / zoom;
        const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
        setZoom(normalized);
        requestAnimationFrame(() => {
            viewport.scrollLeft = Math.max(0, centerX * normalized - viewport.clientWidth / 2);
            viewport.scrollTop = Math.max(0, centerY * normalized - viewport.clientHeight / 2);
        });
    };

    const reset = () => {
        setZoom(1);
        centerViewport();
    };

    const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 1 && !(event.button === 0 && spacePressedRef.current)) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        event.preventDefault();
        event.stopPropagation();
        viewport.setPointerCapture(event.pointerId);
        panRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        setPanning(true);
    };

    const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
        const viewport = viewportRef.current;
        const pan = panRef.current;
        if (!viewport || !pan) return;
        viewport.scrollLeft = pan.left - (event.clientX - pan.x);
        viewport.scrollTop = pan.top - (event.clientY - pan.y);
    };

    const stopPan = () => {
        panRef.current = null;
        setPanning(false);
    };

    return (
        <div className="relative overflow-hidden rounded-lg border">
            <div
                ref={viewportRef}
                className={`${className} overflow-auto overscroll-contain bg-black/5 dark:bg-white/[.03] ${panning ? "cursor-grabbing" : ""}`}
                onPointerDownCapture={startPan}
                onPointerMove={movePan}
                onPointerUp={stopPan}
                onPointerCancel={stopPan}
            >
                <div className="grid min-h-full min-w-full place-items-center p-6">
                    <div className="relative shrink-0" style={{ width: baseSize.width * zoom, height: baseSize.height * zoom }}>
                        <div
                            ref={stageRef}
                            className="absolute left-0 top-0 origin-top-left overflow-hidden rounded-md bg-transparent select-none [backface-visibility:hidden]"
                            style={{ width: baseSize.width, height: baseSize.height, transform: `translateZ(0) scale(${zoom})` }}
                        >
                            {children}
                        </div>
                    </div>
                </div>
            </div>
            <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md border bg-[var(--ant-color-bg-elevated)] p-1 shadow-sm">
                <Tooltip title="缩小">
                    <Button type="text" size="small" icon={<ZoomOut className="size-4" />} disabled={zoom <= minZoom} onClick={() => changeZoom(zoom / zoomStep)} />
                </Tooltip>
                <Tooltip title="适应视口">
                    <Button type="text" size="small" icon={<Maximize2 className="size-4" />} onClick={reset} />
                </Tooltip>
                <Tooltip title="放大">
                    <Button type="text" size="small" icon={<ZoomIn className="size-4" />} disabled={zoom >= maxZoom} onClick={() => changeZoom(zoom * zoomStep)} />
                </Tooltip>
            </div>
        </div>
    );
}

function isTextInput(target: EventTarget | null) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}
