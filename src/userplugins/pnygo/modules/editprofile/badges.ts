/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findStore } from "@webpack";
import { RestAPI, UserStore } from "@webpack/common";

const logger = new Logger("EditProfile");

export interface OfficialBadgeDef {
    id: string;
    description: string;
    /** icon hash on cdn.discordapp.com/badge-icons/ (legacy badges) */
    icon?: string;
    /** full image url (badge-directory badges) — rendered natively by Discord */
    iconSrc?: string;
    link?: string;
}

export const BADGE_CATALOG: OfficialBadgeDef[] = [
    { id: "staff", description: "Discord Staff", icon: "5e74e9b61934fc1f67c65515d1f7e60d", link: "https://discord.com/company" },
    { id: "staff_hidden", description: "Discord Staff (hidden)", icon: "5e74e9b61934fc1f67c65515d1f7e60d", link: "https://discord.com/company" },
    { id: "partner", description: "Partnered Server Owner", icon: "3f9748e53446a137a052f3454e2de41e", link: "https://discord.com/partners" },
    { id: "certified_moderator", description: "Moderator Programs Alumni", icon: "fee1624003e2fee35cb398e125dc479b", link: "https://discord.com/safety" },
    { id: "hypesquad", description: "HypeSquad Events", icon: "bf01d1073931f921909045f3a39fd264", link: "https://discord.com/hypesquad" },
    { id: "hypesquad_house_1", description: "HypeSquad Bravery", icon: "8a88d63823d8a71cd5e390baa45efa02" },
    { id: "hypesquad_house_2", description: "HypeSquad Brilliance", icon: "011940fd013da3f7fb926e4a1cd2e618" },
    { id: "hypesquad_house_3", description: "HypeSquad Balance", icon: "3aa41de486fa12454c3761e8e223442e" },
    { id: "bug_hunter_level_1", description: "Discord Bug Hunter", icon: "2717692c7dca7289b35297368a940dd0" },
    { id: "bug_hunter_level_2", description: "Discord Bug Hunter Gold", icon: "848f79194d4be5ff5f81505cbd0ce1e6" },
    { id: "active_developer", description: "Active Developer", icon: "6bdc42827a38498929a4920da12695d9" },
    { id: "verified_developer", description: "Early Verified Bot Developer", icon: "6df5892e0f35b051f8b61eace34f4967" },
    { id: "early_supporter", description: "Early Supporter", icon: "7060786766c9c840eb3019e725d2b358" },
    { id: "premium", description: "Subscriber since Dec 22, 2016", icon: "2ba85e8026a8614b640c2837bcdfe21b" },
    { id: "premium_tenure_1_month_v2", description: "Subscriber since 1 month", icon: "4f33c4a9c64ce221936bd256c356f91f" },
    { id: "premium_tenure_3_month_v2", description: "Subscriber since 3 months", icon: "4514fab914bdbfb4ad2fa23df76121a6" },
    { id: "premium_tenure_6_month_v2", description: "Subscriber since 6 months", icon: "2895086c18d5531d499862e41d1155a6" },
    { id: "premium_tenure_12_month_v2", description: "Subscriber since 12 months", icon: "0334688279c8359120922938dcb1d6f8" },
    { id: "premium_tenure_24_month_v2", description: "Subscriber since 24 months", icon: "0d61871f72bb9a33a7ae568c1fb4f20a" },
    { id: "premium_tenure_36_month_v2", description: "Subscriber since 36 months", icon: "11e2d339068b55d3a506cff34d3780f3" },
    { id: "premium_tenure_60_month_v2", description: "Subscriber since 60 months", icon: "cd5e2cfd9d7f27a8cdcd3e8a8d5dc9f4" },
    { id: "premium_tenure_72_month_v2", description: "Subscriber since 72 months", icon: "5b154df19c53dce2af92c9b61e6be5e2" },
    { id: "guild_booster_lvl1", description: "Server boosting since 1 month", icon: "51040c70d4f20a921ad6674ff86fc95c" },
    { id: "guild_booster_lvl2", description: "Server boosting since 2 months", icon: "0e4080d1d333bc7ad29ef6528b6f2fb7" },
    { id: "guild_booster_lvl3", description: "Server boosting since 3 months", icon: "72bed924410c304dbe3d00a6e593ff59" },
    { id: "guild_booster_lvl4", description: "Server boosting since 6 months", icon: "df199d2050d3ed4ebf84d64ae83989f8" },
    { id: "guild_booster_lvl5", description: "Server boosting since 9 months", icon: "996b3e870e8a22ce519b3a50e6bdd52f" },
    { id: "guild_booster_lvl6", description: "Server boosting since 12 months", icon: "991c9f39ee33d7537d9f408c3e53141e" },
    { id: "guild_booster_lvl7", description: "Server boosting since 15 months", icon: "cb3ae83c15e970e8f3d410bc62cb8b99" },
    { id: "guild_booster_lvl8", description: "Server boosting since 18 months", icon: "7142225d31238f6387d9f09efaa02759" },
    { id: "guild_booster_lvl9", description: "Server boosting since 24 months", icon: "ec92202290b48d0879b7413d2dde3bab" },
    { id: "automod", description: "Uses AutoMod", icon: "f2459b691ac7453ed6039bbcfaccbfcd" },
    { id: "legacy_username", description: "Originally known as their old username", icon: "6de6d34650760ba5551a79732e98ed60" },
    { id: "quest_completed", description: "Completed a Quest", icon: "7d9ae358c8c5e118768335dbe68b4fb8" },
    { id: "bot_commands", description: "Supports Commands", icon: "6f9e37f9029ff57aef81db857890005e" },
    { id: "orb_profile_badge", description: "Collected the Orb Profile Badge", icon: "83d8a1eb09a8d64e59233eec5d4d5c2d" },
];

// ---------------------------------------------------------------------------
// live badge directory (Discord's own catalog store)
// ---------------------------------------------------------------------------

/** shape of a badge item inside BadgeDirectoryStore */
interface DirectoryBadge {
    badge_id?: string;
    name?: string;
    simple_icon_raster_url?: string;
    simple_icon_url?: string;
    owned?: boolean;
    is_earnable?: boolean;
}

/**
 * Discord's own route for the badge directory, from its constants module:
 * USER_BADGES(e) => `/users/${e}/badges`, with "@me" for the current user.
 */
const USER_BADGES_URL = "/users/@me/badges";

/**
 * Fetch the badge directory directly through Discord's own API client
 * (the same one Vencord exposes as RestAPI). This is the exact request the
 * badge directory modal makes, so it needs no lazy module and works even
 * right after startup.
 */
async function fetchDirectoryBadges(): Promise<DirectoryBadge[] | null> {
    try {
        const res = await RestAPI.get({ url: USER_BADGES_URL });
        const body = (res as { body?: { badges?: unknown } })?.body;
        if (!body || !Array.isArray(body.badges)) return null;
        return body.badges as DirectoryBadge[];
    } catch (e) {
        logger.warn("badge directory fetch failed:", e);
        return null;
    }
}

/** normalized badge defs coming from the live directory */
let directoryCatalog: OfficialBadgeDef[] = [];

/** merged static + directory catalog, keyed by id */
let mergedCatalog = new Map<string, OfficialBadgeDef>();
rebuildMerged();

function rebuildMerged() {
    mergedCatalog = new Map();
    // static first (legacy hashes win for ids that exist in both),
    // then live directory entries for everything new
    for (const def of [...BADGE_CATALOG, ...directoryCatalog]) {
        if (def.id && !mergedCatalog.has(def.id)) mergedCatalog.set(def.id, def);
    }
}

/** turn whatever icon value the directory gives us into a usable url */
function normalizeIconUrl(url: string | undefined | null): string | undefined {
    if (!url || typeof url !== "string") return undefined;
    const trimmed = url.trim();
    if (!trimmed) return undefined;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // relative path -> resolve against the badge-icons cdn
    if (trimmed.startsWith("/")) return `https://cdn.discordapp.com${trimmed}`;
    return `https://cdn.discordapp.com/badge-icons/${trimmed}.png`;
}

/**
 * Refresh the live catalog.
 *
 * Prefers Discord's BadgeDirectoryStore (already-fetched data, no request),
 * and falls back to fetching the badge directory directly through Discord's
 * own API client when the store has nothing yet. Either way the result is
 * the complete, up-to-date badge list. Safe to call repeatedly; never throws.
 */
export async function refreshDirectoryCatalog(): Promise<void> {
    try {
        const myId = UserStore.getCurrentUser()?.id;
        if (!myId) return;

        let badges: DirectoryBadge[] | null = null;

        // 1) try Discord's own store first (instant, no network)
        const store = findStore("BadgeDirectoryStore");
        if (store && typeof store.getBadges === "function") {
            const fromStore = store.getBadges(myId);
            if (Array.isArray(fromStore) && fromStore.length > 0) badges = fromStore;
        }

        // 2) store empty -> fetch it ourselves with Discord's API client
        if (!badges) {
            badges = await fetchDirectoryBadges();
        }

        if (!Array.isArray(badges)) return;

        const next: OfficialBadgeDef[] = [];
        for (const b of badges) {
            try {
                if (!b || !b.badge_id) continue;
                const iconSrc = normalizeIconUrl(b.simple_icon_raster_url ?? b.simple_icon_url);
                if (!iconSrc) continue; // no usable icon -> cannot render anyway
                next.push({
                    id: String(b.badge_id),
                    description: String(b.name ?? b.badge_id),
                    iconSrc,
                });
            } catch { /* skip a single malformed entry, keep the rest */ }
        }

        directoryCatalog = next;
        rebuildMerged();
    } catch (e) {
        logger.warn("refreshDirectoryCatalog failed:", e);
    }
}

/** the full merged list (static legacy + live directory), for the picker UI */
export function getAllBadges(): OfficialBadgeDef[] {
    return Array.from(mergedCatalog.values());
}

export function getOfficialBadge(id: string | undefined | null): OfficialBadgeDef | undefined {
    return id ? mergedCatalog.get(id) : undefined;
}

export function badgeIconUrl(hash: string | undefined | null): string {
    return hash ? `https://cdn.discordapp.com/badge-icons/${hash}.png` : "";
}

/** resolve the image url for any badge def (hash or full url) */
export function badgeImageUrl(def: OfficialBadgeDef | undefined | null): string {
    if (!def) return "";
    return def.iconSrc ?? badgeIconUrl(def.icon);
}
