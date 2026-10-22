/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { OptionType } from "@utils/types";
import {
    ChannelStore, FluxDispatcher, Forms, Menu, MessageStore, Modal,
    openModal, React, showToast, UserStore,
} from "@webpack/common";
import { getBuildNumber } from "@webpack/patcher";

import gitHash from "~git-hash";

import { count } from "./probe";
import { headerBarAvailable, Icons, TitlebarButton } from "./ui";

// the shared titlebar host lives in ./ui — SelfCheck only checks it

// ---------------------------------------------------------------------------
// what this plugin depends on (the exact things pnygo imports at runtime)
// ---------------------------------------------------------------------------

interface CheckResult {
    label: string;
    ok: boolean;
    required: boolean;
    detail?: string;
}

/**
 * Every entry maps 1:1 onto something pnygo actually imports. Checking the
 * RESOLVED Vencord export (not raw webpack code strings) means a Discord update
 * that breaks one of them is detected exactly where the plugin would break —
 * and the check itself never logs a webpack "not found" warning.
 */
function checkRequirements(): CheckResult[] {
    // (typed as a plain function so .tsx doesn't parse `<T>` as JSX)
    function probe<T>(fn: () => T): boolean {
        try { return !!fn(); } catch { return false; }
    }

    return [
        {
            label: "MessageStore (EditMessage / DeleteMessages)",
            ok: probe(() => typeof MessageStore?.getMessage === "function"),
            required: true,
        },
        {
            label: "UserStore (EditProfile / identity)",
            ok: probe(() => typeof UserStore?.getCurrentUser === "function" && typeof UserStore?.getUser === "function"),
            required: true,
        },
        {
            label: "FluxDispatcher (local message updates)",
            ok: probe(() => typeof FluxDispatcher?.dispatch === "function"),
            required: true,
        },
        {
            label: "Menu components (context menu items)",
            ok: probe(() => Menu?.MenuItem != null),
            required: true,
        },
        {
            label: "Modal + openModal (edit windows)",
            ok: probe(() => typeof Modal === "function" && typeof openModal === "function"),
            required: true,
        },
        {
            label: "ChannelStore (message lookups)",
            ok: probe(() => typeof ChannelStore?.getChannel === "function"),
            required: false,
        },
        {
            label: "Header bar button host",
            ok: probe(() => headerBarAvailable()),
            required: false,
        },
        {
            label: "ContextMenuAPI (MissedCalls menu entries)",
            ok: probe(() => typeof addContextMenuPatch === "function" && !!Menu?.MenuItem),
            required: true,
        },
        {
            label: "Chat DOM anchor (MissedCalls rows)",
            ok: probe(() => typeof MutationObserver === "function" && !!document.body && !!document.querySelector('[id^="chat-messages-"]')),
            required: false,
            detail: "open a channel to fill this in",
        },
    ];
}

// ---------------------------------------------------------------------------
// this plugin's own patches (did Discord's code still match?)
// ---------------------------------------------------------------------------

/**
 * Every pnygo patch rewrites Discord code so it calls back into one of our
 * `$self.*` entry points. Counting those calls (modules/probe.ts) is the only
 * reliable "is the patch alive?" signal in a production build: Vencord records
 * patched sources only in dev builds, and `toString()` on a proxied factory
 * returns the ORIGINAL, unpatched source.
 *
 * [label, probe key, true when the entry point can legitimately stay at 0]
 */
const PNYGO_PATCHES: Array<[label: string, key: string, idleIsFine?: boolean]> = [
    ["Titlebar buttons injection", "titlebar"],
    ["Profile badges", "badges", true],
    ["Profile record / bio", "profileView", true],
    ["User object (name / display name)", "userView"],
    ["User createdAt", "createdAt", true],
    ["Snowflake -> timestamp", "snowflake", true],
    ["MissedCalls context menu entry", "cm_missedcall", true],
    ["MissedCalls row injected above a message", "callrow", true],
    ["Girlfriend profile card opened", "girlfriend", true],
    ["Check ID panel opened", "checkid", true],
];

function checkPatches(): CheckResult[] {
    const results: CheckResult[] = [];
    let active = 0;
    const quiet: string[] = [];

    for (const [label, key, idleIsFine] of PNYGO_PATCHES) {
        const calls = count(key);
        if (calls > 0) {
            active++;
            results.push({ label: `Patch: ${label}`, ok: true, required: false, detail: `${calls} call(s) from Discord` });
        } else if (idleIsFine) {
            quiet.push(label);
            results.push({
                label: `Patch: ${label}`,
                ok: true,
                required: false,
                detail: "not observed yet — this code only runs once you open a profile / badge tooltip",
            });
        } else {
            results.push({
                label: `Patch: ${label}`,
                ok: false,
                required: true,
                detail: "Discord never called it — the patch did NOT match this build",
            });
        }
    }

    results.push({
        label: "Patch activity",
        ok: true,
        required: false,
        detail: `${active}/${PNYGO_PATCHES.length} observed${quiet.length ? `, ${quiet.length} idle until used` : ""}`,
    });

    return results;
}

/** Run every compatibility check. Never throws. */
export function runCompatibilityChecks(): CheckResult[] {
    try {
        return [...checkRequirements(), ...checkPatches()];
    } catch (e) {
        return [{ label: `SelfCheck crashed: ${String(e)}`, ok: false, required: false }];
    }
}

// ---------------------------------------------------------------------------
// version info (Discord build + Vencord version/hash)
// ---------------------------------------------------------------------------

interface VersionInfo {
    vencordVersion: string;
    vencordHash: string;
    discordBuild: number | null;
    discordVersion: string;
    electron: string | null;
    chromium: string | null;
}

function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
}

export function getVersionInfo(): VersionInfo {
    // VERSION is injected at build time as a global
    const vencordVersion = safe(() => typeof VERSION === "string" ? VERSION : "unknown", "unknown");

    // the git hash Vencord itself uses (same source as the settings info rows)
    const vencordHash = safe(() => gitHash || "unknown", "unknown");

    let discordBuild: number | null = null;
    try {
        // same helper Vencord's patcher exposes; -1 means "not found"
        const n = getBuildNumber();
        discordBuild = n === -1 ? null : n;
    } catch { /* ignore */ }

    const discordVersion = safe(
        () => window.DiscordNative?.app?.getVersion?.() ?? "unknown",
        "unknown"
    );

    const versions = safe(() => VencordNative?.native?.getVersions?.() ?? ({} as any), {} as any);

    return {
        vencordVersion,
        vencordHash,
        discordBuild,
        discordVersion,
        electron: versions.electron ?? null,
        chromium: versions.chrome ?? null,
    };
}

// ---------------------------------------------------------------------------
// Vencord update check (uses Vencord's own updater, changes nothing by itself)
// ---------------------------------------------------------------------------

interface UpdateStatus {
    state: "checking" | "up-to-date" | "outdated" | "error" | "unsupported";
    message: string;
    changes?: Array<{ hash: string; author: string; message: string; }>;
}

async function checkVencordUpdate(): Promise<UpdateStatus> {
    if (typeof VencordNative === "undefined" || !VencordNative.updater) {
        return { state: "unsupported", message: "Updater is not available in this build (web / standalone)." };
    }

    try {
        const res = await VencordNative.updater.getUpdates();
        if (!res.ok) {
            return { state: "error", message: `Update check failed: ${String(res.error)}` };
        }
        const changes = res.value ?? [];
        if (changes.length === 0) {
            return { state: "up-to-date", message: "Vencord is up to date." };
        }
        return {
            state: "outdated",
            message: `${changes.length} update${changes.length > 1 ? "s" : ""} available.`,
            changes,
        };
    } catch (e) {
        return { state: "error", message: `Update check failed: ${String(e)}` };
    }
}

/** Ask Vencord to update + rebuild itself, then offer a restart. */
async function runVencordUpdate(setBusy: (b: boolean) => void, refresh: () => void) {
    setBusy(true);
    try {
        const updateRes = await VencordNative.updater.update();
        if (!updateRes.ok) throw new Error(String(updateRes.error));

        if (updateRes.value) {
            const rebuildRes = await VencordNative.updater.rebuild();
            if (!rebuildRes.ok) throw new Error(String(rebuildRes.error));
        }

        showToast({ text: "Vencord updated successfully. Restart to apply.", variant: "success" });
        showNotification({
            title: "pnygo — SelfCheck",
            body: "Vencord was updated. Restart Discord to load the new build.",
            noPersist: true,
        });
    } catch (e) {
        showToast({ text: `Update failed: ${String(e)}`, variant: "critical" });
    } finally {
        setBusy(false);
        refresh();
    }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const settings = {
    autoCheckOnStart: {
        type: OptionType.BOOLEAN,
        description: "SelfCheck — after each Discord/Vencord update, automatically verify this plugin's compatibility and notify you",
        default: true,
    },
    autoCheckUpdates: {
        type: OptionType.BOOLEAN,
        description: "SelfCheck — also check for Vencord updates on startup",
        default: true,
    },
} as const;

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const OK_COLOR = "var(--green-360)";
const BAD_COLOR = "var(--red-360)";
const WARN_COLOR = "var(--yellow-360)";

function StatusLine({ ok, required, label, detail }: CheckResult) {
    const mark = ok ? "✔" : (required ? "✖" : "•");
    const color = ok ? OK_COLOR : (required ? BAD_COLOR : WARN_COLOR);
    const suffix = ok ? "" : (required ? " — missing (feature disabled)" : "");
    return (
        <div style={{ fontSize: 12, padding: "2px 0", display: "flex", gap: 8 }}>
            <span style={{ color, width: 14, fontWeight: 900 }}>{mark}</span>
            <span style={{ opacity: ok ? .95 : 1, color: ok ? "var(--text-default)" : color }}>
                {label}{suffix}
                {detail ? <span style={{ opacity: .65 }}> — {detail}</span> : null}
            </span>
        </div>
    );
}

function SelfCheckPanel(props: any) {
    const [checks, setChecks] = React.useState<CheckResult[]>([]);
    const [info, setInfo] = React.useState<VersionInfo | null>(null);
    const [update, setUpdate] = React.useState<UpdateStatus>({ state: "checking", message: "Checking..." });
    const [busy, setBusy] = React.useState(false);

    const refresh = React.useCallback(() => {
        setChecks(runCompatibilityChecks());
        setInfo(getVersionInfo());
        setUpdate({ state: "checking", message: "Checking..." });
        checkVencordUpdate().then(setUpdate);
    }, []);

    React.useEffect(() => { refresh(); }, [refresh]);

    const requiredFailures = checks.filter(c => !c.ok && c.required);
    const optionalFailures = checks.filter(c => !c.ok && !c.required);
    const healthy = requiredFailures.length === 0;

    const card: React.CSSProperties = {
        background: "var(--background-secondary)",
        border: "1px solid var(--background-modifier-accent)",
        borderRadius: 10,
        padding: 10,
        marginBottom: 10,
    };

    const btnStyle = (bg: string, color = "#fff"): React.CSSProperties => ({
        background: bg, color,
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 6, padding: "6px 12px",
        fontWeight: 700, cursor: "pointer", fontSize: 12,
    });

    return (
        <Modal {...props} size="md" title="pnygo — SelfCheck (compatibility & updates)">
            <div style={{ padding: "0 16px 14px" }}>

                <div style={card}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: 0, marginBottom: 6 }}>Compatibility</Forms.FormTitle>
                    <Forms.FormText style={{ marginBottom: 6, color: healthy ? OK_COLOR : BAD_COLOR, fontWeight: 700 }}>
                        {healthy
                            ? "All required parts found — the plugin is compatible with this build."
                            : `${requiredFailures.length} required part(s) missing — some features are disabled to keep Discord safe.`}
                    </Forms.FormText>
                    {checks.map(c => <StatusLine key={c.label} {...c} />)}
                    {optionalFailures.length > 0 && (
                        <Forms.FormText style={{ marginTop: 6, fontSize: 11, opacity: .7 }}>
                            Optional parts are only used by secondary features and never crash the client.
                        </Forms.FormText>
                    )}
                </div>

                <div style={card}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: 0, marginBottom: 6 }}>Versions</Forms.FormTitle>
                    <Forms.FormText style={{ fontSize: 12 }}>
                        Vencord: <b>{info?.vencordVersion ?? "..."}</b>
                        {info && info.vencordHash !== "unknown" ? <> ({info.vencordHash.slice(0, 7)})</> : null}<br />
                        Discord: <b>{info?.discordVersion ?? "..."}</b>
                        {info?.discordBuild != null ? <> (build {info.discordBuild})</> : null}<br />
                        {info?.electron ? <>Electron: <b>{info.electron}</b><br /></> : null}
                        {info?.chromium ? <>Chromium: <b>{info.chromium}</b></> : null}
                    </Forms.FormText>
                </div>

                <div style={card}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: 0, marginBottom: 6 }}>Vencord update</Forms.FormTitle>
                    <Forms.FormText style={{
                        fontSize: 12,
                        color: update.state === "outdated" ? WARN_COLOR
                            : update.state === "up-to-date" ? OK_COLOR
                                : update.state === "error" ? BAD_COLOR : "var(--text-default)"
                    }}>
                        {update.message}
                    </Forms.FormText>
                    {update.changes && update.changes.length > 0 && (
                        <div style={{ maxHeight: 140, overflowY: "auto", marginTop: 6, fontSize: 11, opacity: .9 }}>
                            {update.changes.slice(0, 20).map((c, i) => (
                                <div key={i} style={{ padding: "1px 0" }}>• {c.message}</div>
                            ))}
                        </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                        <button style={btnStyle("var(--background-tertiary)", "var(--text-default)")} disabled={busy} onClick={refresh}>
                            Re-check
                        </button>
                        {update.state === "outdated" && (
                            <button style={btnStyle("var(--brand-500)")} disabled={busy}
                                onClick={() => runVencordUpdate(setBusy, refresh)}>
                                {busy ? "Updating..." : "Update Vencord now"}
                            </button>
                        )}
                    </div>
                </div>

                <Forms.FormText style={{ fontSize: 11, opacity: .7 }}>
                    This only inspects your own client and uses Vencord's official updater. Nothing is sent to any third party.
                </Forms.FormText>
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------------------
// startup check
// ---------------------------------------------------------------------------

const LAST_BUILD_KEY = "pnygo-selfcheck:last-build";

/**
 * Runs after start: if this Discord build (or Vencord version) differs from the
 * last one we saw, re-run the checks and warn about required breakage or a
 * pending Vencord update. Always wrapped so it can never break startup.
 */
export async function runStartupCheck(store: Record<string, any>) {
    try {
        if (!store.autoCheckOnStart) return;

        const info = getVersionInfo();
        const checks = runCompatibilityChecks();
        const requiredFailures = checks.filter(c => !c.ok && c.required).map(c => c.label);
        const optionalFailures = checks.filter(c => !c.ok && !c.required).map(c => c.label);

        console.log(
            `[pnygo/SelfCheck] Discord ${info.discordVersion}${info.discordBuild != null ? ` (build ${info.discordBuild})` : ""}, ` +
            `Vencord ${info.vencordVersion}, checks: ${checks.length - requiredFailures.length - optionalFailures.length}/${checks.length} ok` +
            (requiredFailures.length ? `, MISSING: ${requiredFailures.join(", ")}` : "") +
            (optionalFailures.length ? `, optional missing: ${optionalFailures.join(", ")}` : "")
        );

        let lastBuild: string | null = null;
        try {
            lastBuild = localStorage.getItem(LAST_BUILD_KEY);
        } catch { }
        const currentBuild = `${info.vencordVersion}|${info.discordBuild ?? "?"}`;
        const buildChanged = lastBuild !== currentBuild;
        try { localStorage.setItem(LAST_BUILD_KEY, currentBuild); } catch { }

        // surface required breakage immediately, on every launch
        if (requiredFailures.length > 0) {
            showNotification({
                title: "pnygo — compatibility issue",
                body: `Missing parts: ${requiredFailures.join(", ")}.\nAffected features were disabled to protect Discord.`,
                noPersist: false,
            });
        }

        // check for Vencord updates when the build actually changed
        if (store.autoCheckUpdates) {
            const update = await checkVencordUpdate();
            console.log(`[pnygo/SelfCheck] Vencord update check: ${update.state} — ${update.message}${buildChanged ? " (build changed)" : ""}`);
            if (update.state === "outdated" && buildChanged) {
                showNotification({
                    title: "pnygo — Vencord update available",
                    body: `${update.message} Open the SelfCheck panel to update.`,
                    noPersist: false,
                });
            }
        }
    } catch (e) {
        // never let the self check break the plugin or the client
        console.warn("[pnygo/SelfCheck] startup check failed:", e);
    }
}

// ---------------------------------------------------------------------------
// UI entry points (wired by index.tsx)
// ---------------------------------------------------------------------------

export function SelfCheckHeaderButton() {
    if (!headerBarAvailable()) return null;
    return (
        <TitlebarButton
            id="selfcheck"
            tooltip="pnygo — SelfCheck (compatibility & updates)"
            onClick={() => openModal(props => (
                <ErrorBoundary noop>
                    <SelfCheckPanel {...props} />
                </ErrorBoundary>
            ))}
        >
            <Icons.shield size={18} />
        </TitlebarButton>
    );
}

export function openSelfCheck() {
    openModal(props => (
        <ErrorBoundary noop>
            <SelfCheckPanel {...props} />
        </ErrorBoundary>
    ));
}

export const toolboxActions = {
    "pnygo SelfCheck": () => openSelfCheck(),
};

export function start(_store: Record<string, any>) { /* started from pnygo's start() */ }
export function stop() { /* nothing long-running */ }
