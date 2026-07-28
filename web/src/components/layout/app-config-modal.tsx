"use client";

import { App, Button, Form, Input, Modal, Segmented, Select, Switch, Tabs, Checkbox, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { ReloadOutlined } from "@ant-design/icons";
import { Download, Upload } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { fetchChannelModels, type AdminModelChannel } from "@/services/api/admin";
import { fetchUserConfig, measureUserStorageProvider, syncUserModelConfig, syncUserStorageProvider } from "@/services/api/user-config";
import { defaultUserStorageProvider, saveUserStorageProvider, USER_STORAGE_PROVIDER_KEY, type UserStorageProvider, clearStorageConfigCache as clearImageStorageCache } from "@/services/image-storage";
import { defaultBaseUrlForProtocol, normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig, type LocalModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { applyAppConfigFile, exportSafeAppConfig, readAppConfigFile, type AppConfigPreview } from "@/services/config-file";

export function AppConfigModal() {
    const { message, modal } = App.useApp();
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
    const [saving, setSaving] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [migrationProgress, setMigrationProgress] = useState({ current: 0, total: 0 });
    const configInputRef = useRef<HTMLInputElement>(null);
    const [configPreview, setConfigPreview] = useState<AppConfigPreview | null>(null);

    const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
    const [selectingChannelId, setSelectingChannelId] = useState("");
    const [modelSelectSource, setModelSelectSource] = useState<string[]>([]);
    const [modelSelectExisting, setModelSelectExisting] = useState<string[]>([]);
    const [modelSelectSelected, setModelSelectSelected] = useState<string[]>([]);
    const [modelSelectKeyword, setModelSelectKeyword] = useState("");
    const [modelSelectNewModel, setModelSelectNewModel] = useState("");
    const [modelSelectTab, setModelSelectTab] = useState<"new" | "current">("new");

    useEffect(() => {
        try {
            setUserStorage({ ...defaultUserStorageProvider(), ...JSON.parse(window.localStorage.getItem(USER_STORAGE_PROVIDER_KEY) || "{}") });
        } catch {
            setUserStorage(defaultUserStorageProvider());
        }
        if (!isConfigOpen || !token) return;
        void fetchUserConfig(token)
            .then((payload) => {
                let syncModel = false;
                let syncStorage = false;
                if (payload.modelConfig) {
                    syncModel = !!payload.modelConfig.syncModelConfig;
                    syncStorage = !!payload.modelConfig.syncStorageConfig;

                    if (syncModel) {
                        Object.entries(payload.modelConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                    } else {
                        updateConfig("syncModelConfig", false);
                    }

                    if (syncStorage) {
                        updateConfig("syncStorageConfig", true);
                    } else {
                        updateConfig("syncStorageConfig", false);
                    }
                } else {
                    updateConfig("syncModelConfig", false);
                    updateConfig("syncStorageConfig", false);
                }

                if (syncStorage && payload.storageProvider) {
                    const next = {
                        ...defaultUserStorageProvider(),
                        ...payload.storageProvider,
                        enabled: payload.storageProvider.enabled !== undefined ? payload.storageProvider.enabled : true
                    };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
            })
            .catch(() => {});
    }, [isConfigOpen, token, updateConfig]);

    const finishConfig = async () => {
        if (allowUserStorageProvider) saveUserStorageProvider(userStorage);
        if (!allowCustomChannel && config.channelMode !== "remote") updateConfig("channelMode", "remote");

        const isLocalIncomplete = effectiveMode === "local" && (!config.baseUrl.trim() || !config.apiKey.trim());
        const isModelIncomplete = !modelConfig.imageModel.trim() || !modelConfig.textModel.trim();

        setSaving(true);
        try {
            if (token) {
                if (config.syncModelConfig) {
                    await syncUserModelConfig(token, config);
                } else {
                    await syncUserModelConfig(token, {
                        ...config,
                        syncModelConfig: false,
                        apiKey: "",
                        baseUrl: "",
                        localChannels: [],
                    });
                }
            }
            if (token && allowUserStorageProvider) {
                if (config.syncStorageConfig) {
                    await syncUserStorageProvider(token, userStorage);
                } else {
                    await syncUserStorageProvider(token, {
                        ...userStorage,
                        enabled: false,
                        endpoint: "",
                        bucket: "",
                        accessKeyId: "",
                        secretAccessKey: "",
                    });
                }
            }
            
            clearImageStorageCache();

            if (token) {
                const userConfig = await fetchUserConfig(token);
                const cloudSyncActive = userConfig.syncCapabilities?.userData === true && userConfig.syncCapabilities?.assets === true;
                
                if (cloudSyncActive) {
                    const { checkLocalAssetsExist, migrateLocalAssetsToCloud } = await import("@/services/storage-migration");
                    const hasLocalData = await checkLocalAssetsExist();
                    if (hasLocalData) {
                        const confirmMigration = await new Promise<boolean>((resolve) => {
                            modal.confirm({
                                title: "迁移本地资源到云端",
                                content: "检测到您之前有在浏览器本地离线保存的图片资产。是否现在一键将它们安全地迁移到刚刚配置的云端存储中？这样您在其他设备上也能正常查看它们。",
                                okText: "一键迁移",
                                cancelText: "暂不迁移",
                                onOk: () => resolve(true),
                                onCancel: () => resolve(false),
                            });
                        });

                        if (confirmMigration) {
                            setMigrating(true);
                            setMigrationProgress({ current: 0, total: 0 });
                            try {
                                await migrateLocalAssetsToCloud((current, total) => {
                                    setMigrationProgress({ current, total });
                                });
                                message.success("迁移成功！您的所有资产已安全地上传至云端并完成同步。");
                            } catch (migError) {
                                console.error("Migration error", migError);
                                message.error("资产迁移过程中遇到错误，请检查您的对象存储配置是否正确。");
                            } finally {
                                setMigrating(false);
                            }
                        }
                    }
                }
            }

            if (isLocalIncomplete || isModelIncomplete) {
                message.warning("部分通道的模型或直连密钥尚未配置完整，配置已保存并同步");
            } else {
                message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
            }
            setConfigDialogOpen(false);
            clearPromptContinue();
        } catch (error) {
            message.error(error instanceof Error ? `同步配置失败：${error.message}` : "同步配置失败");
        } finally {
            setSaving(false);
        }
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
            
            clearImageStorageCache();

            const userConfig = await fetchUserConfig(token);
            const cloudSyncActive = userConfig.syncCapabilities?.userData === true && userConfig.syncCapabilities?.assets === true;
            
            if (cloudSyncActive) {
                const { checkLocalAssetsExist, migrateLocalAssetsToCloud } = await import("@/services/storage-migration");
                const hasLocalData = await checkLocalAssetsExist();
                if (hasLocalData) {
                    const confirmMigration = await new Promise<boolean>((resolve) => {
                        modal.confirm({
                            title: "迁移本地资源到云端",
                            content: "检测到您之前有在浏览器本地离线保存的图片资产。是否现在一键将它们安全地迁移到刚刚配置的云端存储中？这样您在其他设备上也能正常查看它们。",
                            okText: "一键迁移",
                            cancelText: "暂不迁移",
                            onOk: () => resolve(true),
                            onCancel: () => resolve(false),
                        });
                    });

                    if (confirmMigration) {
                        setMigrating(true);
                        setMigrationProgress({ current: 0, total: 0 });
                        try {
                            await migrateLocalAssetsToCloud((current, total) => {
                                setMigrationProgress({ current, total });
                            });
                            message.success("迁移成功！您的所有资产已安全地上传至云端并完成同步。");
                        } catch (migError) {
                            console.error("Migration error", migError);
                            message.error("资产迁移过程中遇到错误，请检查您的对象存储配置是否正确。");
                        } finally {
                            setMigrating(false);
                        }
                    }
                }
            }

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
        if (!token) {
            message.error("请先登录后再拉取渠道模型");
            return;
        }
        const channels = normalizeLocalChannels(config);
        if (channels.some((channel) => !channel.baseUrl.trim())) {
            message.error("请先填写所有本地渠道的 Base URL");
            return;
        }
        setLoadingModels(true);
        try {
            const nextChannels = await Promise.all(
                channels.map(async (channel) => ({
                    ...channel,
                    models: await fetchChannelModels(token, { channel: localChannelToAdminChannel(channel) }),
                })),
            );
            updateLocalChannels(nextChannels);
            const models = Array.from(new Set(nextChannels.flatMap((channel) => channel.models)));
            if (models.length && !models.includes(config.imageModel)) updateConfig("imageModel", models[0]);
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
        if (!normalized.some((channel) => channel.id === config.textChannelId)) updateConfig("textChannelId", normalized[0]?.id || "");
        updateConfig("baseUrl", normalized[0]?.baseUrl || config.baseUrl);
        updateConfig("apiKey", normalized[0]?.apiKey || config.apiKey);
    };

    const patchLocalChannel = (id: string, patch: Partial<LocalModelChannel>) => {
        updateLocalChannels(normalizeLocalChannels(config).map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)));
    };

    const patchLocalChannelProtocol = (channel: LocalModelChannel, protocol: LocalModelChannel["protocol"]) => {
        patchLocalChannel(channel.id, {
            protocol,
            baseUrl: !channel.baseUrl.trim() || channel.baseUrl.trim() === defaultBaseUrlForProtocol(channel.protocol) ? defaultBaseUrlForProtocol(protocol) : channel.baseUrl,
        });
    };

    const addLocalChannel = () => {
        updateLocalChannels([...normalizeLocalChannels(config), { id: `local-${Date.now()}`, protocol: "openai", name: "新渠道", baseUrl: "", apiKey: "", models: [] }]);
    };

    const removeLocalChannel = (id: string) => {
        updateLocalChannels(normalizeLocalChannels(config).filter((channel) => channel.id !== id));
    };

    const uniqueModels = (arr: string[]) => Array.from(new Set(arr.filter(Boolean)));

    const openLocalChannelModelSelector = (channel: LocalModelChannel) => {
        const current = uniqueModels(channel.models || []);
        setModelSelectExisting(current);
        setModelSelectSource([]);
        setModelSelectSelected(current);
        setSelectingChannelId(channel.id);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
        setModelSelectTab("current");
        setModelSelectorOpen(true);
    };

    const refreshLocalChannelModels = async (channel: LocalModelChannel) => {
        if (!token) {
            message.error("请先登录后再拉取渠道模型");
            return;
        }
        if (!channel.baseUrl.trim()) {
            message.error("请先填写该渠道的 Base URL");
            return;
        }
        setLoadingModels(true);
        try {
            const models = await fetchChannelModels(token, { channel: localChannelToAdminChannel(channel) });
            
            const current = uniqueModels(channel.models || []);
            setModelSelectExisting(current);
            setModelSelectSource(uniqueModels(models));
            setModelSelectSelected(uniqueModels([...current, ...models]));
            setSelectingChannelId(channel.id);
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setModelSelectTab(models.length ? "new" : "current");
            setModelSelectorOpen(true);
            message.success(`已获取 ${models.length} 个模型，请选择后确认`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    const refetchModelsInSelector = async () => {
        const channel = normalizeLocalChannels(config).find((c) => c.id === selectingChannelId);
        if (!channel) return;
        if (!token) {
            message.error("请先登录后再拉取渠道模型");
            return;
        }
        setLoadingModels(true);
        try {
            const models = await fetchChannelModels(token, { channel: localChannelToAdminChannel(channel) });
            const current = uniqueModels(modelSelectSelected);
            setModelSelectExisting(current);
            setModelSelectSource(uniqueModels(models));
            setModelSelectSelected(uniqueModels([...current, ...models]));
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setModelSelectTab("new");
            message.success(`已更新并拉取 ${models.length} 个模型`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    const modelSelectGroups = {
        new: modelSelectSource.filter((m) => !modelSelectExisting.includes(m)),
        current: modelSelectExisting,
    };

    const filteredNewModels = modelSelectGroups.new.filter((m) => m.toLowerCase().includes(modelSelectKeyword.toLowerCase()));
    const filteredCurrentModels = modelSelectGroups.current.filter((m) => m.toLowerCase().includes(modelSelectKeyword.toLowerCase()));
    const activeModelSelectModels = modelSelectTab === "new" ? filteredNewModels : filteredCurrentModels;

    const activeSelectedCount = activeModelSelectModels.filter((m) => modelSelectSelected.includes(m)).length;

    const toggleSelectedModel = (model: string, checked: boolean) => {
        setModelSelectSelected((current) => (checked ? uniqueModels([...current, model]) : current.filter((item) => item !== model)));
    };

    const selectActiveModels = () => {
        setModelSelectSelected((current) => uniqueModels([...current, ...activeModelSelectModels]));
    };

    const clearActiveModels = () => {
        const active = new Set(activeModelSelectModels);
        setModelSelectSelected((current) => current.filter((model) => !active.has(model)));
    };

    const addModelInSelector = () => {
        const model = modelSelectNewModel.trim();
        if (!model) return;
        setModelSelectExisting((current) => uniqueModels([...current, model]));
        setModelSelectSelected((current) => uniqueModels([...current, model]));
        setModelSelectNewModel("");
        setModelSelectTab("current");
    };

    const closeChannelModelSelector = () => {
        setModelSelectorOpen(false);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
    };

    const confirmChannelModelSelector = () => {
        const models = uniqueModels(modelSelectSelected);
        patchLocalChannel(selectingChannelId, { models });
        closeChannelModelSelector();
    };

    const loadConfigFile = async (file: File) => {
        try {
            setConfigPreview(await readAppConfigFile(file));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "配置文件读取失败");
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const confirmConfigImport = () => {
        if (!configPreview) return;
        const nextStorage = applyAppConfigFile(configPreview.file, config, userStorage);
        setUserStorage(nextStorage);
        saveUserStorageProvider(nextStorage);
        setConfigPreview(null);
        message.success("配置已导入；本机密钥保持不变，请确认后再保存");
    };

    return (
        <>
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
                <Button type="primary" loading={saving} onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                    <div className="text-xs text-stone-500">配置文件默认不包含 API Key、S3/R2 密钥或后台渠道快照。</div>
                    <div className="flex gap-2">
                        <Button size="small" icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                            导入
                        </Button>
                        <Button size="small" icon={<Download className="size-4" />} onClick={() => exportSafeAppConfig(config, userStorage)}>
                            安全导出
                        </Button>
                        <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                    </div>
                </div>
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
                                        <div className="mt-1 text-xs text-stone-500">可为生图和文本分别选择不同渠道的模型。</div>
                                    </div>
                                    <Button size="small" onClick={addLocalChannel}>
                                        新增渠道
                                    </Button>
                                </div>
                                {normalizeLocalChannels(config).map((channel, index) => (
                                    <div key={channel.id} className="space-y-2 rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                                        <div className="grid gap-2 md:grid-cols-[120px_140px_minmax(0,1fr)_minmax(0,1fr)_auto]">
                                            <Input value={channel.name} placeholder="渠道名称" onChange={(event) => patchLocalChannel(channel.id, { name: event.target.value })} />
                                            <Select
                                                value={channel.protocol || "openai"}
                                                options={[
                                                    { label: "OpenAI", value: "openai" },
                                                    { label: "Gemini", value: "gemini" },
                                                    { label: "火山方舟", value: "ark" },
                                                ]}
                                                onChange={(value) => patchLocalChannelProtocol(channel, value)}
                                            />
                                            <Input value={channel.baseUrl} placeholder="Base URL" onChange={(event) => patchLocalChannel(channel.id, { baseUrl: event.target.value })} />
                                            <Input.Password value={channel.apiKey} placeholder="API Key" onChange={(event) => patchLocalChannel(channel.id, { apiKey: event.target.value })} />
                                            <div className="flex gap-2">
                                                <Button size="small" onClick={() => openLocalChannelModelSelector(channel)}>
                                                    选择模型
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
                                    <span className="text-xs text-stone-500">请在各渠道的“选择模型”弹窗中拉取和勾选模型</span>
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
                    <div className="grid gap-4 md:grid-cols-2">
                        <Form.Item label="默认生图模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.imageModel} channelId={modelConfig.imageChannelId} onChange={(model, channelId) => { updateConfig("imageModel", model); if (channelId) updateConfig("imageChannelId", channelId); }} fullWidth />
                        </Form.Item>
                        <Form.Item label="默认文本模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.textModel} channelId={modelConfig.textChannelId} onChange={(model, channelId) => { updateConfig("textModel", model); if (channelId) updateConfig("textChannelId", channelId); }} fullWidth />
                        </Form.Item>
                    </div>
                    <div className="grid gap-4 md:grid-cols-4">
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
                        <Form.Item label="失败重试次数" className="mb-4">
                            <Input value={config.retryAttempts} inputMode="numeric" onChange={(event) => updateConfig("retryAttempts", event.target.value)} />
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
        <Modal
            title="确认导入配置"
            open={Boolean(configPreview)}
            onCancel={() => setConfigPreview(null)}
            onOk={confirmConfigImport}
            okText="导入"
            cancelText="取消"
            destroyOnHidden
        >
            {configPreview ? (
                <div className="space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                        <PreviewItem label="渠道" value={`${configPreview.channelCount} 个`} />
                        <PreviewItem label="模型" value={`${configPreview.modelCount} 个`} />
                        <PreviewItem label="默认生图模型" value={configPreview.imageModel || "未设置"} />
                        <PreviewItem label="默认文本模型" value={configPreview.textModel || "未设置"} />
                    </div>
                    <div className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                        {configPreview.includesStorage ? "包含不带密钥的对象存储地址信息。" : "不包含对象存储信息。"} 导入不会覆盖当前设备保存的 API Key 和访问密钥，也不会自动开启账号同步。
                    </div>
                </div>
            ) : null}
        </Modal>
        <Modal
            title={
                <Space size={12}>
                    <span className="text-lg font-semibold">选择渠道模型</span>
                    <Typography.Text type="secondary">
                        已选择 {modelSelectSelected.length} / {uniqueModels([...modelSelectSource, ...modelSelectExisting]).length}
                    </Typography.Text>
                </Space>
            }
            open={modelSelectorOpen}
            width={760}
            centered
            onCancel={closeChannelModelSelector}
            footer={
                <Space>
                    <Button onClick={closeChannelModelSelector}>取消</Button>
                    <Button type="primary" onClick={confirmChannelModelSelector}>
                        确定
                    </Button>
                </Space>
            }
            destroyOnHidden
        >
            <div className="flex flex-col gap-4 pt-2">
                <div className="flex flex-wrap gap-3">
                    <Input.Search
                        placeholder="搜索模型"
                        allowClear
                        value={modelSelectKeyword}
                        onChange={(event) => setModelSelectKeyword(event.target.value)}
                        style={{ flex: "1 1 240px" }}
                    />
                    <Space.Compact style={{ flex: "1 1 320px" }}>
                        <Input
                            value={modelSelectNewModel}
                            placeholder="输入模型名称"
                            onChange={(event) => setModelSelectNewModel(event.target.value)}
                            onPressEnter={addModelInSelector}
                        />
                        <Button onClick={addModelInSelector}>增加模型</Button>
                        <Button
                            icon={<ReloadOutlined />}
                            loading={loadingModels}
                            onClick={() => void refetchModelsInSelector()}
                        >
                            拉取模型列表
                        </Button>
                    </Space.Compact>
                </div>
                <Tabs
                    activeKey={modelSelectTab}
                    onChange={(key) => setModelSelectTab(key as "new" | "current")}
                    items={[
                        { key: "new", label: `新获取的模型 (${modelSelectGroups.new.length})` },
                        { key: "current", label: `已有的模型 (${modelSelectGroups.current.length})` },
                    ]}
                />
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <Typography.Text type="secondary">
                        当前列表已选择 {activeSelectedCount} / {activeModelSelectModels.length}
                    </Typography.Text>
                    <Space size={8}>
                        <Button
                            size="small"
                            disabled={!activeModelSelectModels.length || activeSelectedCount === activeModelSelectModels.length}
                            onClick={selectActiveModels}
                        >
                            全选当前列表
                        </Button>
                        <Button
                            size="small"
                            disabled={!activeSelectedCount}
                            onClick={clearActiveModels}
                        >
                            取消当前列表
                        </Button>
                    </Space>
                </div>
                <div className="max-h-[300px] overflow-y-auto border-t border-stone-200 pt-3 dark:border-stone-800">
                    {activeModelSelectModels.length ? (
                        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                            {activeModelSelectModels.map((model) => (
                                <Checkbox
                                    key={model}
                                    checked={modelSelectSelected.includes(model)}
                                    onChange={(event) => toggleSelectedModel(model, event.target.checked)}
                                >
                                    <span className="break-all text-sm">{model}</span>
                                </Checkbox>
                            ))}
                        </div>
                    ) : (
                        <div className="py-12 text-center">
                            <Typography.Text type="secondary">没有匹配的模型</Typography.Text>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
        <Modal
            open={migrating}
            footer={null}
            closable={false}
            mask={{ closable: false }}
            title="数据同步中"
            centered
        >
            <div className="flex flex-col items-center justify-center p-6 space-y-4">
                <ReloadOutlined spin className="text-3xl text-blue-500" />
                <span className="text-base font-medium">正在将本地图片资源安全地同步到云端存储...</span>
                <span className="text-sm text-gray-500">
                    进度: {migrationProgress.current} / {migrationProgress.total} (
                    {migrationProgress.total > 0 ? Math.round((migrationProgress.current / migrationProgress.total) * 100) : 0}
                    %)
                </span>
            </div>
        </Modal>
    </>
);
}

function PreviewItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
            <div className="text-xs text-stone-500">{label}</div>
            <div className="mt-1 truncate font-medium">{value}</div>
        </div>
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

function localChannelToAdminChannel(channel: LocalModelChannel): AdminModelChannel {
    return {
        id: channel.id,
        protocol: channel.protocol || "openai",
        name: channel.name,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        models: channel.models || [],
        weight: 1,
        timeout: 600,
        enabled: true,
        remark: "",
    };
}
