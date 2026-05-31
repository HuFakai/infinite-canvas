"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useConfigStore } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const hydrateAccountAssets = useAssetStore((state) => state.hydrateAccountAssets);
    const stopAccountAssetSync = useAssetStore((state) => state.stopAccountAssetSync);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        if (token && user?.id) {
            void hydrateAccountAssets(token);
            return;
        }
        stopAccountAssetSync();
    }, [hydrateAccountAssets, stopAccountAssetSync, token, user?.id]);

    return <>{children}</>;
}
