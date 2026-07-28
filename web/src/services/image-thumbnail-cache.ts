"use client";

import localforage from "localforage";

type ThumbnailEntry = { dataUrl: string; accessedAt: number };

const thumbnailStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_thumbnail_cache" });
const pending = new Map<string, Promise<string>>();
const MAX_ENTRIES = 120;
const THUMBNAIL_SIZE = 480;

export async function getImageThumbnail(key: string, source: string) {
    if (!source) return "";
    const cacheKey = thumbnailKey(key || source);
    const cached = await thumbnailStore.getItem<ThumbnailEntry>(cacheKey);
    if (cached?.dataUrl) {
        void thumbnailStore.setItem(cacheKey, { ...cached, accessedAt: Date.now() });
        return cached.dataUrl;
    }
    const current = pending.get(cacheKey);
    if (current) return current;
    const task = createThumbnail(source)
        .then(async (dataUrl) => {
            await thumbnailStore.setItem(cacheKey, { dataUrl, accessedAt: Date.now() });
            void trimThumbnailCache();
            return dataUrl;
        })
        .finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, task);
    return task;
}

export function warmImageThumbnails(images: Array<{ id: string; dataUrl: string; storageKey?: string }>) {
    const run = () => images.forEach((image) => void getImageThumbnail(image.storageKey || image.id, image.dataUrl).catch(() => {}));
    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(run, { timeout: 3000 });
    } else {
        window.setTimeout(run, 100);
    }
}

async function createThumbnail(source: string) {
    const response = await fetch(source);
    if (!response.ok) throw new Error("缩略图源文件读取失败");
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("缩略图画布不可用");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/webp", 0.78);
}

async function trimThumbnailCache() {
    const entries: Array<{ key: string; accessedAt: number }> = [];
    await thumbnailStore.iterate<ThumbnailEntry, void>((value, key) => {
        entries.push({ key, accessedAt: value?.accessedAt || 0 });
    });
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a.accessedAt - b.accessedAt);
    await Promise.all(entries.slice(0, entries.length - MAX_ENTRIES).map((entry) => thumbnailStore.removeItem(entry.key)));
}

function thumbnailKey(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `thumb:${(hash >>> 0).toString(36)}`;
}
