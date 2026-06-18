"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Form, Input } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import { fetchCurrentUser } from "@/services/api/auth";
import { useSiteInfo } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type LoginFormValues = {
    username: string;
    password: string;
};

// 仅放行站内相对路径，拦截开放重定向。浏览器会忽略 URL 中的 Tab/换行/回车，并把
// //host 或 /\host 解析为协议相对的跨站地址，因此先剥离控制字符，再拒绝 // 与 /\ 前缀。
function safeRedirect(value: string | null): string {
    const cleaned = (value ?? "").replace(/[\t\n\r]/g, "");
    if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
        return "/";
    }
    return cleaned;
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginContent />
        </Suspense>
    );
}

function LoginContent() {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const login = useUserStore((state) => state.login);
    const setSession = useUserStore((state) => state.setSession);
    const isLoading = useUserStore((state) => state.isLoading);
    const site = useSiteInfo();
    const redirect = safeRedirect(searchParams.get("redirect"));

    useEffect(() => {
        const token = searchParams.get("token");
        const error = searchParams.get("error");
        if (error) message.error(error);
        if (!token) return;
        void fetchCurrentUser(token).then((user) => {
            setSession(token, user);
            message.success("登录成功");
            router.replace(redirect);
            router.refresh();
        });
    }, [message, redirect, router, searchParams, setSession]);

    const submit = async (values: LoginFormValues) => {
        try {
            const user = await login({ username: values.username, password: values.password });
            message.success("登录成功");
            router.replace(redirect);
            router.refresh();
            if (user.role !== "admin") router.replace("/");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        }
    };

    return (
        <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
            <section className="w-full max-w-[420px]">
                <div className="mb-7 text-center">
                    {site.logoUrl ? (
                        <img src={site.logoUrl} alt={site.name} className="mx-auto mb-4 block size-12 object-contain" />
                    ) : (
                        <span
                            className="mx-auto mb-4 block size-12 bg-stone-950 dark:bg-stone-100"
                            style={{
                                mask: "url(/logo.svg) center / contain no-repeat",
                                WebkitMask: "url(/logo.svg) center / contain no-repeat",
                            }}
                            aria-label={site.name}
                        />
                    )}
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">{site.subtitle || `${site.name} 账号登录`}</h1>
                    <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">使用账号密码登录。</p>
                </div>

                <Form<LoginFormValues> layout="vertical" size="large" requiredMark={false} onFinish={submit}>
                    <Form.Item name="username" label={<span className="font-medium text-stone-800 dark:text-stone-200">用户名</span>} rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input prefix={<UserOutlined />} autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label={<span className="font-medium text-stone-800 dark:text-stone-200">密码</span>} rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
                    </Form.Item>
                    <Button block type="primary" htmlType="submit" loading={isLoading}>
                        登录
                    </Button>
                </Form>
            </section>
        </main>
    );
}
