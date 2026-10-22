/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Button, Menu, showToast, UserProfileStore,UserStore } from "@webpack/common";

import { getOfficialBadge, refreshDirectoryCatalog } from "./badges";
import { HeaderOverlay, openEditProfileModal } from "./components/ProfileEditOverlay";
import { ensureLoaded, getOverrides, getRevision, resetAll, resetEverything, subscribeOverrides } from "./overrides";
import { isEnabled, setPolicyStore } from "./policy";
import { clearViews, createdAtTimestamp, profileView, snowflakeMs, userView } from "./views";

const logger = new Logger("pnygo/EditProfile");

// re-exported for the merged plugin's patch replacements ($self.*)
export { createdAtTimestamp, profileView, snowflakeMs, userView };

export const settings = {

    applyToOtherUsers: {
        type: OptionType.BOOLEAN,
        description: "Also apply stored profile overrides when viewing OTHER users' profiles (overrides are saved per user id)",
        default: false,
    },
    editProfileWipeAll: {
        type: OptionType.COMPONENT,
        description: "Remove every stored profile override for every user (restores all real values instantly)",
        component: ResetEverythingButton,
    },
} as const;

/** Settings button: wipe every stored override across all users. */
function ResetEverythingButton() {
    return (
        <Button
            color={Button.Colors.RED}
            onClick={async () => {
                await resetEverything();
                showToast({ text: "EditProfile: all local overrides removed", variant: "success" });
            }}
        >
            Reset everything
        </Button>
    );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** shape of the badge objects Discord stores on the user profile record */
interface DiscordBadge {
    id?: string;
    description?: string;
    icon?: string;
    iconSrc?: string;
    link?: string;
}

/** read the userId off an unknown profile record without assuming its shape */
function recordUserId(profile: unknown): string | null {
    if (!profile || typeof profile !== "object") return null;
    const rec = profile as { userId?: unknown; user?: { id?: unknown } };
    if (typeof rec.userId === "string") return rec.userId;
    if (typeof rec.user?.id === "string") return rec.user.id;
    return null;
}

/**
 * Read the real badges array off the profile record without modifying it.
 *
 * Discord's own `getBadges()` merges `_userProfile.badges` with
 * `_guildMemberProfile.badges`; the record exposes neither as `badges`, so all
 * three shapes are checked here. (Getting this wrong silently hides the real
 * badges, which is exactly what the previous version did.)
 */
function extractRealBadges(record: unknown): DiscordBadge[] {
    try {
        const rec = record as {
            badges?: unknown;
            _userProfile?: { badges?: unknown };
            _guildMemberProfile?: { badges?: unknown };
        } | null;
        if (!rec) return [];
        if (Array.isArray(rec.badges)) return rec.badges as DiscordBadge[];

        const out: DiscordBadge[] = [];
        if (Array.isArray(rec._userProfile?.badges)) out.push(...rec._userProfile!.badges as DiscordBadge[]);
        if (Array.isArray(rec._guildMemberProfile?.badges)) out.push(...rec._guildMemberProfile!.badges as DiscordBadge[]);
        return out;
    } catch (e) {
        logger.warn("could not read real badges:", e);
        return [];
    }
}

function dedupeById(badges: DiscordBadge[]): DiscordBadge[] {
    const seen = new Set<string>();
    const out: DiscordBadge[] = [];
    for (const b of badges) {
        const id = String(b?.id ?? "");
        if (!id || seen.has(id)) continue; // duplicate ids are skipped -> no "badge spam" ever
        seen.add(id);
        out.push(b);
    }
    return out;
}

/** build the injected (fake) badge list for one profile record */
function buildInjectedBadges(userId: string | null): DiscordBadge[] {
    if (!userId) return [];
    const ov = getOverrides(userId);
    const out: DiscordBadge[] = [];
    for (const b of ov.badges) {
        if (b.kind === "official") {
            const def = getOfficialBadge(b.officialId);
            if (!def) continue;
            out.push({
                id: `editprofile-official-${def.id}`, // stable unique id, always prefixed
                description: def.description,
                icon: def.icon, // cdn hash (legacy badges)
                iconSrc: def.iconSrc, // full url (badge-directory badges) — Discord renders this natively
                link: def.link,
            });
        } else if (b.custom?.imageUrl) {
            out.push({
                id: b.uid,
                description: b.custom.tooltip,
                iconSrc: b.custom.imageUrl, // Discord's badge component renders full URLs via iconSrc
            });
        }
    }
    return out;
}

/** stable badge arrays: Discord's badge hooks run on every render, see views.ts */
const badgeCache = new WeakMap<object, { rev: number; real: DiscordBadge[]; hideReal: boolean; out: DiscordBadge[]; }>();

/**
 * THE anti-duplication core. Called from the patched `getBadges()` of the user
 * profile record, with Discord's own badge expression passed in as `real`:
 *
 *   getBadges(){ return $self.badgesFor(this, [...this._userProfile.badges ?? []]); }
 *
 * So the real badges are never lost, they are only extended. The result array
 * is cached per record + revision, because Discord's badge hooks run this on
 * every render and compare the array identity.
 */
export function badgesFor(record: unknown, real?: DiscordBadge[]): DiscordBadge[] {
    const realBadges = Array.isArray(real) ? real : extractRealBadges(record);
    try {
        const userId = recordUserId(record);
        if (!isEnabled() || !userId) return realBadges; // feature off -> Discord's own array, untouched

        const ov = getOverrides(userId);
        // nothing faked for this user -> stay out of the way completely
        if (ov.badges.length === 0 && !ov.hideRealBadges) return realBadges;

        const key = typeof record === "object" && record !== null ? record as object : null;
        const rev = getRevision();
        const hit = key ? badgeCache.get(key) : undefined;
        if (hit && hit.rev === rev && hit.real === realBadges && hit.hideReal === ov.hideRealBadges) return hit.out;

        const mine = buildInjectedBadges(userId);
        const out = ov.hideRealBadges ? dedupeById(mine) : dedupeById([...realBadges, ...mine]);
        if (key) badgeCache.set(key, { rev, real: realBadges, hideReal: ov.hideRealBadges, out });
        return out;
    } catch (e) {
        logger.warn("badgesFor failed, keeping the real badges:", e);
        return realBadges;
    }
}

/**
 * ErrorBoundary-wrapped header overlay component (kept for parity; the editor
 * is opened from the context menu and the modal, not a profile header patch).
 */
export const SafeHeaderOverlay = ErrorBoundary.wrap(HeaderOverlay, { noop: true });

/**
 * Best-effort reactivity nudge: override changes do not dispatch anything, so
 * the two stores are asked to notify their listeners. That makes an already
 * open profile re-render with the new values immediately.
 */
function nudgeStores() {
    for (const [name, store] of [["UserStore", UserStore], ["UserProfileStore", UserProfileStore]] as const) {
        try {
            (store as unknown as { emitChange?: () => void })?.emitChange?.();
        } catch (e) {
            logger.warn(`could not nudge ${name}:`, e);
        }
    }
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!isEnabled()) return;
    try {
        const user = props?.user;
        const userId = user?.id ?? props?.userId;
        if (!userId) return;
        children.push(
            <Menu.MenuItem
                id="vc-editprofile-edit"
                label="Edit Profile (local only)"
                action={() => openEditProfileModal(userId)}
            />,
            <Menu.MenuItem
                id="vc-editprofile-reset"
                label="Reset Profile (local only)"
                action={() => {
                    resetAll(userId);
                    showToast({ text: "EditProfile: real profile restored", variant: "success" });
                }}
            />
        );
    } catch (e) {
        logger.warn("user context menu patch failed:", e);
    }
};

// true while the user context menu patch is registered
let contextMenuPatched = false;
// unsubscribes the override listener that nudges the stores
let overridesUnsubscribe: (() => void) | undefined;

export async function start(store: Record<string, any>): Promise<void> {
    setPolicyStore(store);
    clearViews();
    await ensureLoaded();
    refreshDirectoryCatalog();
    addContextMenuPatch("user-context", userContextMenuPatch);
    contextMenuPatched = true;
    // every save / reset bumps the revision; tell the stores so an open profile
    // re-renders right away (registered after the load, so no startup nudge)
    overridesUnsubscribe = subscribeOverrides(nudgeStores);
}

export function stop() {
    overridesUnsubscribe?.();
    overridesUnsubscribe = undefined;
    if (contextMenuPatched) {
        removeContextMenuPatch("user-context", userContextMenuPatch);
        contextMenuPatched = false;
    }
    clearViews();
    nudgeStores();
}
