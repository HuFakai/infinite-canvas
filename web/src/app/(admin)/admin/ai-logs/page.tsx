"use client";

import { DeleteOutlined, EyeOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { App, Button, Card, Drawer, Flex, Form, Input, InputNumber, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { deleteAdminAICallLogs, fetchAdminAICallLogs, type AdminAICallLog } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export default function AdminAICallLogsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [total, setTotal] = useState(0);
    const [logs, setLogs] = useState<AdminAICallLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [clearDays, setClearDays] = useState(7);
    const [clearing, setClearing] = useState(false);
    const [detail, setDetail] = useState<AdminAICallLog | null>(null);

    const loadLogs = async () => {
        if (!token) return;
        setLoading(true);
        try {
            const result = await fetchAdminAICallLogs(token, { keyword, page, pageSize });
            setLogs(result.items);
            setTotal(result.total);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 AI 调用日志失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadLogs();
    }, [token, page, pageSize]);

    const clearLogs = async () => {
        if (!token) return;
        setClearing(true);
        try {
            const result = await deleteAdminAICallLogs(token, clearDays);
            message.success(`已清理 ${result.removedFiles} 个日志文件`);
            setPage(1);
            await loadLogs();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清理 AI 调用日志失败");
        } finally {
            setClearing(false);
        }
    };

    const columns = useMemo(
        () => [
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => formatTime(value) },
            { title: "用户", dataIndex: "userDisplayName", width: 150, render: (_: string, item: AdminAICallLog) => item.userDisplayName || item.userId || "-" },
            { title: "接口", dataIndex: "endpoint", width: 170 },
            { title: "模型", dataIndex: "model", width: 180, ellipsis: true },
            { title: "渠道", dataIndex: "channelName", width: 150, ellipsis: true, render: (_: string, item: AdminAICallLog) => item.channelName || item.channelId || "-" },
            { title: "状态", dataIndex: "status", width: 90, render: (status: number) => <Tag color={status >= 200 && status < 400 ? "success" : "error"}>{status || "失败"}</Tag> },
            { title: "耗时", dataIndex: "durationMs", width: 110, render: (value: number) => formatDuration(value) },
            { title: "扣点", dataIndex: "credits", width: 80 },
            {
                title: "操作",
                key: "actions",
                width: 90,
                fixed: "right" as const,
                render: (_: unknown, item: AdminAICallLog) => (
                    <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(item)}>
                        详情
                    </Button>
                ),
            },
        ],
        [],
    );

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16} className="w-full">
                <Card variant="borderless">
                    <Form
                        layout="vertical"
                        onFinish={() => {
                            setPage(1);
                            void loadLogs();
                        }}
                    >
                        <div className="grid gap-3 md:grid-cols-[minmax(0,360px)_auto_auto_minmax(0,180px)_auto] md:items-end">
                            <Form.Item label="关键词" className="mb-0">
                                <Input value={keyword} placeholder="搜索用户、模型、渠道、接口或错误" onChange={(event) => setKeyword(event.target.value)} />
                            </Form.Item>
                            <Button htmlType="submit" type="primary" icon={<SearchOutlined />}>
                                查询
                            </Button>
                            <Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setPage(1); void loadLogs(); }}>
                                重置
                            </Button>
                            <Form.Item label="清理范围" className="mb-0">
                                <div className="flex items-center gap-2">
                                    <InputNumber min={1} value={clearDays} className="!w-full" onChange={(value) => setClearDays(Number(value) || 7)} />
                                    <Typography.Text type="secondary" className="shrink-0">
                                        天前
                                    </Typography.Text>
                                </div>
                            </Form.Item>
                            <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={() => void clearLogs()}>
                                清理旧日志
                            </Button>
                        </div>
                    </Form>
                </Card>
                <Card variant="borderless" title={<span>AI 调用日志 <Tag>{total} 条</Tag></span>}>
                    <Table
                        rowKey="id"
                        size="small"
                        loading={loading}
                        columns={columns}
                        dataSource={logs}
                        scroll={{ x: 1180 }}
                        pagination={{
                            current: page,
                            pageSize,
                            total,
                            showSizeChanger: true,
                            onChange: (nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            },
                        }}
                    />
                </Card>
            </Flex>
            <Drawer title="AI 调用详情" placement="right" size="large" open={Boolean(detail)} onClose={() => setDetail(null)}>
                {detail ? (
                    <Flex vertical gap={16} className="w-full">
                        <LogBlock title="请求内容" value={detail.requestBody} />
                        <LogBlock title="返回内容" value={detail.responseBody || detail.error} />
                    </Flex>
                ) : null}
            </Drawer>
        </main>
    );
}

function LogBlock({ title, value }: { title: string; value: string }) {
    return (
        <div>
            <Typography.Text strong>{title}</Typography.Text>
            <pre className="mt-2 max-h-[45vh] overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-200">{value || "-"}</pre>
        </div>
    );
}

function formatTime(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "-";
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
}
