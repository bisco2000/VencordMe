/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast } from "@utils/discord";
import { findByPropsLazy } from "@webpack";
import { showToast, Toasts } from "@webpack/common";

import { Icons, TitlebarButton } from "./ui";

// the store that holds your own auth token
const TokenStore = findByPropsLazy("getToken");

function copyOwnToken() {
    try {
        const token = (TokenStore as any)?.getToken?.();
        if (typeof token === "string" && token.length > 0) {
            copyWithToast(token, "Your Discord token copied");
        } else {
            showToast("Could not read your token", Toasts.Type.FAILURE);
        }
    } catch {
        showToast("Could not read your token", Toasts.Type.FAILURE);
    }
}

export function TokenButton() {
    return (
        <TitlebarButton id="token" tooltip="Copy your Discord token" onClick={copyOwnToken}>
            <Icons.key size={18} />
        </TitlebarButton>
    );
}

export function start(_store: Record<string, any>) { /* nothing long-running */ }
export function stop() { /* nothing to restore */ }
