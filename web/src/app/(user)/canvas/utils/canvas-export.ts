import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getImageBlob, imageToBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "../export-types";
import type { CanvasProject } from "../stores/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无限画布") {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = await getImageBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], connections: CanvasConnection[], fileName = "画布选中内容") {
    const files: { name: string; data: BlobPart }[] = [];
    const exportedNodes = await Promise.all(
        nodes.map(async (node, index) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return node;
            const blob = await imageToBlob({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey });
            const path = `images/${String(index + 1).padStart(2, "0")}-${safeFileName(node.title || node.id)}.${fileExtension(blob.type, node.metadata.storageKey || "")}`;
            files.push({ name: path, data: blob });
            return { ...node, metadata: { ...node.metadata, content: path, storageKey: undefined } };
        }),
    );
    const manifest = { app: "infinite-canvas", type: "selection", version: 1, exportedAt: new Date().toISOString(), nodes: exportedNodes, connections };
    const zip = await createZip([{ name: "selection.json", data: JSON.stringify(manifest, null, 2) }, ...files]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
