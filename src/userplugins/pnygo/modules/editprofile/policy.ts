/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore } from "@webpack/common";

// set from the merged plugin's start()
let store: Record<string, any> = {};

export function setPolicyStore(next: Record<string, any>): void {
    store = next ?? {};
}

/** master toggle of this feature */
export function isEnabled(): boolean {
    return !!store.enableEditProfile;
}

/**
 * Re-entrancy guard.
 *
 * `UserStore.getCurrentUser()` is itself patched and calls back into the view
 * builder, which again asks "is this the current user?" -> without this flag
 * that question would recurse forever on EVERY getUser() call and freeze
 * Discord. While the inner lookup runs we simply answer "not self", which is
 * harmless: the inner lookup only needs the id.
 */
let resolvingSelf = false;

/**
 * Should the profile of `userId` show local overrides?
 * When "apply to other users" is off, only your own profile is faked.
 */
export function shouldApplyTo(userId: string | null | undefined): userId is string {
    if (!userId) return false;
    if (resolvingSelf) return false;

    resolvingSelf = true;
    try {
        if (userId === UserStore.getCurrentUser()?.id) return true;
    } catch {
        // store not ready yet -> fall back to the "other users" rule
    } finally {
        resolvingSelf = false;
    }
    return !!store.applyToOtherUsers;
}

/** both gates at once, the single check every view performs */
export function shouldFake(userId: string | null | undefined): userId is string {
    return !!userId && isEnabled() && shouldApplyTo(userId);
}
