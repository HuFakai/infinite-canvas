"use client";

import localforage from "localforage";

export type ImageHistoryIndexImage = {
    id: string;
    dataUrl?: string;
    storageKey?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

export type ImageHistoryIndexEntry = {
    id: string;
    createdAt: number;
    categoryIds: string[];
    status: string;
    imageCount: number;
    coverImages: ImageHistoryIndexImage[];
};

type StoredHistoryLog = {
    id?: string;
    createdAt?: number;
    categoryIds?: string[];
    status?: string;
    imageCount?: number;
    successCount?: number;
    images?: ImageHistoryIndexImage[];
};

type ImageHistoryIndex = {
    version: 1;
    entries: ImageHistoryIndexEntry[];
};

const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const INDEX_STORE_KEY = "index:v1";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });
const indexStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_log_index" });
let indexWriteChain = Promise.resolve();

export async function readImageHistoryIndex() {
    if (typeof window === "undefined") return [];
    const stored = await indexStore.getItem<ImageHistoryIndex>(INDEX_STORE_KEY);
    if (stored?.version === 1 && Array.isArray(stored.entries)) return stored.entries;
    return rebuildImageHistoryIndex();
}

export async function rebuildImageHistoryIndex() {
    if (typeof window === "undefined") return [];
    const entries: ImageHistoryIndexEntry[] = [];
    await logStore.iterate<StoredHistoryLog, void>((log, key) => {
        entries.push(toIndexEntry(log, key));
    });
    entries.sort((a, b) => b.createdAt - a.createdAt);
    await writeIndex(entries);
    return entries;
}

export async function readImageHistoryLogsByIds<T>(ids: string[]): Promise<T[]> {
    const values = await Promise.all(ids.map((id) => logStore.getItem<T>(id)));
    return values.reduce<T[]>((items, value) => {
        if (value) items.push(value as T);
        return items;
    }, []);
}

export async function readAllImageHistoryLogs<T extends { createdAt?: number }>() {
    if (typeof window === "undefined") return [];
    const values: T[] = [];
    await logStore.iterate<T, void>((value) => {
        values.push(value);
    });
    return values.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function putImageHistoryLog<T extends StoredHistoryLog>(log: T) {
    if (!log.id) return;
    await logStore.setItem(log.id, log);
    await updateIndex((entries) => [toIndexEntry(log, log.id!), ...entries.filter((entry) => entry.id !== log.id)]);
}

export async function putImageHistoryLogs<T extends StoredHistoryLog>(logs: T[]) {
    await Promise.all(logs.filter((log) => log.id).map((log) => logStore.setItem(log.id!, log)));
    const replacements = new Map(logs.filter((log) => log.id).map((log) => [log.id!, toIndexEntry(log, log.id!)]));
    await updateIndex((entries) => [...replacements.values(), ...entries.filter((entry) => !replacements.has(entry.id))]);
}

export async function removeImageHistoryLogs(ids: string[]) {
    const deletedIds = new Set(ids);
    await Promise.all(ids.map((id) => logStore.removeItem(id)));
    await updateIndex((entries) => entries.filter((entry) => !deletedIds.has(entry.id)));
}

export async function replaceImageHistoryLogs<T extends StoredHistoryLog>(logs: T[]) {
    await logStore.clear();
    await Promise.all(logs.filter((log) => log.id).map((log) => logStore.setItem(log.id!, log)));
    await writeIndex(logs.filter((log) => log.id).map((log) => toIndexEntry(log, log.id!)).sort((a, b) => b.createdAt - a.createdAt));
}

export async function readImageHistoryCategories<T>() {
    if (typeof window === "undefined") return [];
    const value = await categoryStore.getItem<T[]>(CATEGORY_STORE_KEY);
    return Array.isArray(value) ? value : [];
}

export async function putImageHistoryCategories<T>(categories: T[]) {
    await categoryStore.setItem(CATEGORY_STORE_KEY, categories);
}

function toIndexEntry(log: StoredHistoryLog, fallbackId: string): ImageHistoryIndexEntry {
    return {
        id: log.id || fallbackId,
        createdAt: log.createdAt || 0,
        categoryIds: Array.isArray(log.categoryIds) ? log.categoryIds : [],
        status: log.status || "",
        imageCount: log.imageCount ?? log.successCount ?? log.images?.length ?? 0,
        coverImages: (log.images || []).slice(0, 4).map((image) => ({
            id: image.id,
            dataUrl: image.dataUrl?.startsWith("data:") ? "" : image.dataUrl,
            storageKey: image.storageKey,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            mimeType: image.mimeType,
        })),
    };
}

async function updateIndex(update: (entries: ImageHistoryIndexEntry[]) => ImageHistoryIndexEntry[]) {
    const previous = indexWriteChain;
    indexWriteChain = (async () => {
        await previous.catch(() => {});
        const entries = await readImageHistoryIndex();
        await writeIndex(update(entries).sort((a, b) => b.createdAt - a.createdAt));
    })();
    await indexWriteChain;
}

async function writeIndex(entries: ImageHistoryIndexEntry[]) {
    await indexStore.setItem<ImageHistoryIndex>(INDEX_STORE_KEY, { version: 1, entries });
}
