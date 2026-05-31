"use client";

import { App, Button, Form, Input, Modal, Segmented, Select, Switch } from "antd";
import { useEffect, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { fetchImageModels } from "@/services/api/image";
import { fetchUserConfig, measureUserStorageProvider, syncUserModelConfig, syncUserStorageProvider } from "@/services/api/user-config";
import { defaultUserStorageProvider, saveUserStorageProvider, USER_STORAGE_PROVIDER_KEY, type UserStorageProvider } from "@/services/image-storage";
import { normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig, type LocalModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function AppConfigModal() {
    const { message } = App.useApp();
    const [loadingModels, setLoadingModels] = useState(false);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const token = useUserStore((state) => state.token);
    const effectiveConfig = useEffectiveConfig();
    const modelChannel = publicSettings?.modelChannel;
    const storageSettings = publicSettings?.storage;
    const allowUserStorageProvider = storageSettings?.allowUserProvider === true;
    const allowCustomChannel = modelChannel?.allowCustomChannel === true;
    const effectiveMode = allowCustomChannel ? config.channelMode : "remote";
    const modelConfig = effectiveMode === "remote" ? effectiveConfig : config;
    const [userStorage, setUserStorage] = useState<UserStorageProvider>(() => defaultUserStorageProvider());
    const [syncingModel, setSyncingModel] = useState(false);
    const [syncingStorage, setSyncingStorage] = useState(false);
    const [measuringStorage, setMeasuringStorage] = useState(false);
    const [storageUsageText, setStorageUsageText] = useState("");

    useEffect(() => {
        try {
            setUserStorage({ ...defaultUserStorageProvider(), ...JSON.parse(window.localStorage.getItem(USER_STORAGE_PROVIDER_KEY) || "{}") });
        } catch {
            setUserStorage(defaultUserStorageProvider());
        }
        if (!isConfigOpen || !token) return;
        void fetchUserConfig(token)
            .then((payload) => {
                if (payload.modelConfig) {
                    Object.entries(payload.modelConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                }
                if (payload.storageProvider) {
                    const next = { ...defaultUserStorageProvider(), ...payload.storageProvider, enabled: true };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
            })
            .catch(() => {});
    }, [isConfigOpen, token, updateConfig]);

    const finishConfig = async () => {
        if (allowUserStorageProvider) saveUserStorageProvider(userStorage);
        setConfigDialogOpen(false);
        if (effectiveMode === "local" && (!config.baseUrl.trim() || !config.apiKey.trim())) return;
        if (!modelConfig.imageModel.trim() || !modelConfig.videoModel.trim() || !modelConfig.textModel.trim()) return;
        if (!allowCustomChannel && config.channelMode !== "remote") updateConfig("channelMode", "remote");
        if (token && config.syncModelConfig) {
            await syncUserModelConfig(token, config).catch((error) => message.warning(error instanceof Error ? `模型配置同步失败：${error.message}` : "模型配置同步失败"));
        }
        if (token && allowUserStorageProvider && config.syncStorageConfig) {
            await syncUserStorageProvider(token, userStorage).catch((error) => message.warning(error instanceof Error ? `S3/R2 配置同步失败：${error.message}` : "S3/R2 配置同步失败"));
        }
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const syncModelConfig = async () => {
        if (!token) {
            message.warning("请先登录后再同步配置");
            return;
        }
        setSyncingModel(true);
        try {
            await syncUserModelConfig(token, config);
            message.success("模型配置已同步到账号");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型配置同步失败");
        } finally {
            setSyncingModel(false);
        }
    };

    const syncStorageConfig = async () => {
        if (!token) {
            message.warning("请先登录后再同步配置");
            return;
        }
        setSyncingStorage(true);
        try {
            saveUserStorageProvider(userStorage);
            await syncUserStorageProvider(token, userStorage);
            message.success("S3/R2 配置已同步到账号");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "S3/R2 配置同步失败");
        } finally {
            setSyncingStorage(false);
        }
    };

    const measureStorage = async () => {
        if (!token) {
            message.warning("请先登录后再统计容量");
            return;
        }
        setMeasuringStorage(true);
        try {
            const result = await measureUserStorageProvider(token, userStorage);
            setStorageUsageText(`${formatStorageBytes(result.bytes)} / ${formatStorageBytes(result.limitBytes)}${result.overLimit ? "，已达到上限" : ""}`);
            if (result.overLimit) {
                const next = { ...userStorage, enabled: false };
                setUserStorage(next);
                saveUserStorageProvider(next);
            }
            message.success("容量统计完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringStorage(false);
        }
    };

    const refreshModels = async () => {
        if (effectiveMode === "remote") return;
        const channels = normalizeLocalChannels(config);
        if (channels.some((channel) => !channel.baseUrl.trim() || !channel.apiKey.trim())) {
            message.error("请先填写所有本地渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingModels(true);
        try {
            const nextChannels = await Promise.all(
                channels.map(async (channel) => ({
                    ...channel,
                    models: await fetchImageModels({ ...config, channelMode: "local", baseUrl: channel.baseUrl, apiKey: channel.apiKey, localChannels: [{ ...channel, models: channel.models }], model: channel.models[0] || config.model }),
                })),
            );
            updateLocalChannels(nextChannels);
            const models = Array.from(new Set(nextChannels.flatMap((channel) => channel.models)));
            if (models.length && !models.includes(config.imageModel)) updateConfig("imageModel", models[0]);
            if (models.length && !models.includes(config.videoModel)) updateConfig("videoModel", models[0]);
            if (models.length && !models.includes(config.textModel)) updateConfig("textModel", models[0]);
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    const updateLocalChannels = (channels: LocalModelChannel[]) => {
        const normalized = channels.length ? channels : normalizeLocalChannels({ baseUrl: config.baseUrl, apiKey: config.apiKey, models: config.models });
        updateConfig("localChannels", normalized);
        updateConfig("models", Array.from(new Set(normalized.flatMap((channel) => channel.models))));
        if (!normalized.some((channel) => channel.id === config.imageChannelId)) updateConfig("imageChannelId", normalized[0]?.id || "");
        if (!normalized.some((channel) => channel.id === config.videoChannelId)) updateConfig("videoChannelId", normalized[0]?.id || "");
        if (!normalized.some((channel) => channel.id === config.textChannelId)) updateConfig("textChannelId", normalized[0]?.id || "");
        updateConfig("baseUrl", normalized[0]?.baseUrl || config.baseUrl);
        updateConfig("apiKey", normalized[0]?.apiKey || config.apiKey);
    };

    const patchLocalChannel = (id: string, patch: Partial<LocalModelChannel>) => {
        updateLocalChannels(normalizeLocalChannels(config).map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)));
    };

    const addLocalChannel = () => {
        updateLocalChannels([...normalizeLocalChannels(config), { id: `local-${Date.now()}`, name: "新渠道", baseUrl: "", apiKey: "", models: [] }]);
    };

    const removeLocalChannel = (id: string) => {
        updateLocalChannels(normalizeLocalChannels(config).filter((channel) => channel.id !== id));
    };

    const refreshLocalChannelModels = async (channel: LocalModelChannel) => {
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error("请先填写该渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingModels(true);
        try {
            const models = await fetchImageModels({ ...config, channelMode: "local", baseUrl: channel.baseUrl, apiKey: channel.apiKey, localChannels: [{ ...channel, models: channel.models }], model: channel.models[0] || config.model });
            patchLocalChannel(channel.id, { models });
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">模型和密钥</div>
                </div>
            }
            open={isConfigOpen}
            width={760}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            footer={
                <Button type="primary" onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <Form layout="vertical" requiredMark={false}>
                    {allowCustomChannel ? (
                        <Form.Item label="渠道模式" className="mb-4">
                            <Segmented
                                block
                                size="middle"
                                value={effectiveMode}
                                onChange={(value) => updateConfig("channelMode", value as AiConfig["channelMode"])}
                                options={[
                                    { label: "本地直连", value: "local" },
                                    { label: "云端渠道", value: "remote" },
                                ]}
                            />
                        </Form.Item>
                    ) : null}
                    {effectiveMode === "local" ? (
                        <>
                            <div className="mb-4 space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">本地模型渠道</div>
                                        <div className="mt-1 text-xs text-stone-500">可为生图、视频、文本分别选择不同渠道的模型。</div>
                                    </div>
                                    <Button size="small" onClick={addLocalChannel}>
                                        新增渠道
                                    </Button>
                                </div>
                                {normalizeLocalChannels(config).map((channel, index) => (
                                    <div key={channel.id} className="space-y-2 rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                                        <div className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)_auto]">
                                            <Input value={channel.name} placeholder="渠道名称" onChange={(event) => patchLocalChannel(channel.id, { name: event.target.value })} />
                                            <Input value={channel.baseUrl} placeholder="Base URL" onChange={(event) => patchLocalChannel(channel.id, { baseUrl: event.target.value })} />
                                            <Input.Password value={channel.apiKey} placeholder="API Key" onChange={(event) => patchLocalChannel(channel.id, { apiKey: event.target.value })} />
                                            <div className="flex gap-2">
                                                <Button size="small" loading={loadingModels} onClick={() => void refreshLocalChannelModels(channel)}>
                                                    拉取
                                                </Button>
                                                <Button size="small" danger disabled={index === 0 && normalizeLocalChannels(config).length === 1} onClick={() => removeLocalChannel(channel.id)}>
                                                    删除
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="text-xs text-stone-500">已保存 {channel.models.length} 个模型</div>
                                    </div>
                                ))}
                            </div>
                            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">模型列表</div>
                                    <div className="mt-1 text-xs text-stone-500">当前已保存 {config.models.length} 个模型</div>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <span className="text-xs text-stone-500">自动同步</span>
                                    <Switch size="small" checked={config.syncModelConfig} onChange={(checked) => updateConfig("syncModelConfig", checked)} />
                                    <Button size="small" loading={loadingModels} onClick={() => void refreshModels()}>
                                        拉取全部渠道
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="mb-4 rounded-lg border border-stone-200 p-3 text-sm text-stone-500 dark:border-stone-800">
                            <div className="font-medium text-stone-900 dark:text-stone-100">云端渠道</div>
                            <div className="mt-1">由系统后台渠道转发请求，当前可用 {modelChannel?.availableModels.length || 0} 个模型。</div>
                            {modelChannel?.channels?.length ? (
                                <div className="mt-3 grid gap-2">
                                    {modelChannel.channels.slice(0, 4).map((channel, index) => (
                                        <div key={`${channel.name}-${channel.baseUrl}-${index}`} className="rounded-md bg-stone-50 px-2.5 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="truncate font-medium">{channel.name || "未命名渠道"}</span>
                                                <span className="shrink-0">{channel.models.length} 个模型</span>
                                            </div>
                                            <div className="mt-1 truncate opacity-70">{channel.baseUrl}</div>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )}
                    <div className="grid gap-4 md:grid-cols-3">
                        <Form.Item label="默认生图模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.imageModel} channelId={modelConfig.imageChannelId} onChange={(model, channelId) => { updateConfig("imageModel", model); if (channelId) updateConfig("imageChannelId", channelId); }} fullWidth />
                        </Form.Item>
                        <Form.Item label="默认视频模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.videoModel} channelId={modelConfig.videoChannelId} onChange={(model, channelId) => { updateConfig("videoModel", model); if (channelId) updateConfig("videoChannelId", channelId); }} fullWidth />
                        </Form.Item>
                        <Form.Item label="默认文本模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.textModel} channelId={modelConfig.textChannelId} onChange={(model, channelId) => { updateConfig("textModel", model); if (channelId) updateConfig("textChannelId", channelId); }} fullWidth />
                        </Form.Item>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                        <Form.Item label="生图 API 接口" className="mb-4">
                            <Select
                                value={config.apiMode}
                                onChange={(value) => updateConfig("apiMode", value)}
                                options={[
                                    { label: "Image API (/v1/images)", value: "images" },
                                    { label: "Responses API (/v1/responses)", value: "responses" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item label="请求超时（秒）" className="mb-4">
                            <Input value={config.timeout} inputMode="numeric" onChange={(event) => updateConfig("timeout", event.target.value)} />
                        </Form.Item>
                        <Form.Item label="请求中间步骤图像数" className="mb-4">
                            <Select
                                value={config.streamPartialImages}
                                disabled={!config.streamImages}
                                onChange={(value) => updateConfig("streamPartialImages", value)}
                                options={[
                                    { label: "0 张", value: "0" },
                                    { label: "1 张", value: "1" },
                                    { label: "2 张", value: "2" },
                                    { label: "3 张", value: "3" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <div className="mb-4 grid gap-3 md:grid-cols-3">
                        <FeatureSwitch title="流式传输" description="开启后请求中追加 stream，支持读取中间图片事件并避免长时间无数据。" checked={config.streamImages} onChange={(checked) => updateConfig("streamImages", checked)} />
                        <FeatureSwitch title="返回 Base64 图片数据" description="开启后 Image API 请求会追加 response_format: b64_json。" checked={config.responseFormatB64Json} onChange={(checked) => updateConfig("responseFormatB64Json", checked)} />
                        <FeatureSwitch title="Codex CLI 兼容模式" description="开启后减少不兼容参数，并追加防提示词改写前缀。" checked={config.codexCli} onChange={(checked) => updateConfig("codexCli", checked)} />
                    </div>
                    {allowUserStorageProvider ? (
                        <div className="mb-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium">用户 S3/R2 存储</div>
                                    <div className="mt-1 text-xs text-stone-500">开启后，新生成图片会优先保存到你自己的 S3 兼容对象存储。{storageUsageText ? `当前容量：${storageUsageText}` : ""}</div>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <Button size="small" loading={measuringStorage} onClick={() => void measureStorage()}>
                                        统计容量
                                    </Button>
                                    <span className="text-xs text-stone-500">自动同步</span>
                                    <Switch size="small" checked={config.syncStorageConfig} onChange={(checked) => updateConfig("syncStorageConfig", checked)} />
                                    <Switch checked={userStorage.enabled} onChange={(enabled) => setUserStorage((value) => ({ ...value, enabled }))} />
                                </div>
                            </div>
                            {userStorage.enabled ? (
                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <Input value={userStorage.name} placeholder="配置名称" onChange={(event) => setUserStorage((value) => ({ ...value, name: event.target.value }))} />
                                    <Input value={userStorage.endpoint} placeholder="Endpoint，例如 https://<account>.r2.cloudflarestorage.com" onChange={(event) => setUserStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                    <Input value={userStorage.region} placeholder="Region，R2 通常为 auto" onChange={(event) => setUserStorage((value) => ({ ...value, region: event.target.value }))} />
                                    <Input value={userStorage.bucket} placeholder="Bucket 名称" onChange={(event) => setUserStorage((value) => ({ ...value, bucket: event.target.value }))} />
                                    <Input value={userStorage.accessKeyId} placeholder="Access Key ID" onChange={(event) => setUserStorage((value) => ({ ...value, accessKeyId: event.target.value }))} />
                                    <Input.Password value={userStorage.secretAccessKey} placeholder="Secret Access Key" onChange={(event) => setUserStorage((value) => ({ ...value, secretAccessKey: event.target.value }))} />
                                    <Input value={userStorage.publicBaseUrl} placeholder="公开访问地址，例如 https://pub-xxx.r2.dev" onChange={(event) => setUserStorage((value) => ({ ...value, publicBaseUrl: event.target.value }))} />
                                    <Input value={userStorage.pathPrefix} placeholder="保存路径前缀，例如 images" onChange={(event) => setUserStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                    {effectiveMode === "local" ? (
                        <Form.Item label="系统提示词" className="mb-0">
                            <Input.TextArea rows={3} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                        </Form.Item>
                    ) : null}
                </Form>
            </div>
        </Modal>
    );
}

function FeatureSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{title}</div>
                <Switch checked={checked} onChange={onChange} />
            </div>
            <div className="mt-1 text-xs leading-5 text-stone-500">{description}</div>
        </div>
    );
}

function formatStorageBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}
