/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - Thems submodule
 *
 * One titlebar button, one panel: show ANY picture, animated GIF or video
 * across Discord — without paying for it in performance.
 *
 * How it stays fast:
 *   - the media lives in ONE fixed layer (#vc-pnygo-thems-layer) that never
 *     moves and never resizes, so the compositor keeps it on its own texture:
 *     scrolling, typing and animations never repaint it.
 *   - pictures/GIFs are a plain <img>: decoded once, then free.
 *   - videos are muted + playsinline + loop, and are PAUSED while the window
 *     is hidden (and, optionally, unfocused) so nothing decodes while you are
 *     not looking at it.
 *   - no CSS filters, no backdrop-filter, no box-shadows, no keyframe
 *     animations, no per-frame JavaScript. The one exception is Overlay
 *     mode's single mix-blend-mode (a GPU blend pass) which is what keeps
 *     text readable while the picture is bright.
 *
 * Two display modes (switched from the panel):
 *   background — the layer sits behind the app (z-index -1) and Discord's
 *                main surface variables are re-declared translucent, so the
 *                picture shows through the whole client ("glass" UI).
 *                Sliders: UI opacity + dark veil over the picture.
 *   overlay    — the same layer is drawn ON TOP of the client (z-index 9999,
 *                still below modals/menus/tooltips) and BLENDS with what is
 *                underneath (mix-blend-mode: overlay / soft-light), so the
 *                picture never washes out text, names or icons — even at
 *                100% opacity. "Normal" is the old plain stacking.
 *
 * Sources:
 *   file — an image/GIF/video picked from this PC. It is COPIED into
 *          Vencord's IndexedDB, so it survives restarts and the original
 *          file on disk can be moved or deleted.
 *   url  — any https link (pnygo's own CSP entry allows img/media from
 *          https: — see src/main/csp/index.ts).
 *
 * Everything is local and cosmetic: nothing is ever sent to Discord.
 */

import "./thems.css";

import { del, get, set } from "@api/DataStore";
import { Settings, SettingsStore } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Modal, React, ThemeStore } from "@webpack/common";

import { hit } from "./probe";
import { Button, Card, Chip, Field, Icons, Input, openPanel, Switch, Tabs, TitlebarButton } from "./ui";

const logger = new Logger("pnygo/Thems");

/** where the picked file lives (IndexedDB, never inside the settings) */
const MEDIA_KEY = "vc-pnygo:thems-media";
const LAYER_ID = "vc-pnygo-thems-layer";
const STYLE_ID = "vc-pnygo-thems-style";

const MEDIA_FILE_RE = /\.(png|jpe?g|gif|apng|webp|avif|bmp|svg|mp4|webm|mov|m4v|mkv|ogv)$/i;
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|avi)([?#]|$)/i;

type Source = "off" | "file" | "url";
type Mode = "background" | "overlay";
type Blend = "overlay" | "soft-light" | "normal";
type Kind = "image" | "video";
type MediaState = "idle" | "loading" | "ready" | "error";

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

// ---- the one layer + the one dynamic stylesheet ---------------------------
let layerEl: HTMLDivElement | null = null;
let dimEl: HTMLDivElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let mediaEl: HTMLImageElement | HTMLVideoElement | null = null;
let mediaSig = "";
let chromeSig = "";
let mediaState: MediaState = "idle";
let mediaError = "";
let runId = 0;

// object URL of the stored file (kept alive for the whole session)
let fileUrl = "";
let fileUrlKey = "";

// the stored file itself — read from IndexedDB ONCE, then reused, so dragging
// a slider never touches the database
let storedFile: File | null = null;
let storedFileLoaded = false;

async function getStoredFile(): Promise<File | null> {
    if (!storedFileLoaded) {
        try { storedFile = (await get<File>(MEDIA_KEY)) ?? null; }
        catch { storedFile = null; }
        storedFileLoaded = true;
    }
    return storedFile;
}

/** panels subscribe to this to re-render when async media state changes */
const uiListeners = new Set<() => void>();

function notifyUi(): void {
    for (const cb of uiListeners) {
        try { cb(); } catch { /* a dead listener must never break us */ }
    }
}

// ---------------------------------------------------------------------------
// settings helpers
// ---------------------------------------------------------------------------

/** the live, auto-saving pnygo settings object (works even when stopped) */
function live(): Record<string, any> {
    try {
        const p = (Settings as any)?.plugins?.pnygo;
        if (p) return p as Record<string, any>;
    } catch { /* plugin not registered yet */ }
    return storeRef;
}

function setSetting(key: string, value: unknown): void {
    try {
        const p = (Settings as any)?.plugins?.pnygo;
        if (p) {
            p[key] = value;
            return;
        }
    } catch { /* fall through to the cached store */ }
    storeRef[key] = value;
}

function num(value: unknown, fallback: number, min = 0, max = 100): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function isLight(): boolean {
    try { return ThemeStore.theme === "light"; } catch { return false; }
}

function detectKind(src: string, mime?: string, nameHint?: string): Kind {
    if (mime) {
        if (mime.startsWith("video/")) return "video";
        if (mime.startsWith("image/")) return "image";
    }
    // extension-less links and extension-less blobs both fall back to the
    // file name — pictures are the default, videos must say so
    if (nameHint && VIDEO_URL_RE.test(nameHint)) return "video";
    return VIDEO_URL_RE.test(src) ? "video" : "image";
}

// ---------------------------------------------------------------------------
// the dynamic stylesheet (surface transparency for the background mode)
// ---------------------------------------------------------------------------

/**
 * Discord's surface colours, translated 1:1 — only the alpha changes, so the
 * visual hierarchy between chat / sidebars / panels is kept exactly as is.
 */
function buildSurfaceCss(alpha: number): string {
    const light = isLight();
    const c = light
        ? {
            primary: "255,255,255",
            secondary: "242,243,245",
            secondaryAlt: "235,237,239",
            tertiary: "227,229,232",
            floating: "255,255,255",
            lowest: "255,255,255",
            lower: "242,243,245",
            low: "235,237,239",
        }
        : {
            primary: "49,51,56",
            secondary: "43,45,49",
            secondaryAlt: "35,36,40",
            tertiary: "30,31,34",
            floating: "17,18,20",
            lowest: "17,18,20",
            lower: "26,27,30",
            low: "43,45,49",
        };

    const a = Math.min(1, Math.max(0, alpha)).toFixed(3);
    const decl = (rgb: string) => `rgba(${rgb},${a}) !important`;

    // declared on every place Discord could possibly hang its theme on, so a
    // build that moves the theme class around still gets the glass effect
    const roots = ":root, html, body, .theme-dark, .theme-light, .theme-midnight, #app-mount, #app-mount > div";

    return `
${roots} {
    --background-primary: ${decl(c.primary)};
    --background-secondary: ${decl(c.secondary)};
    --background-secondary-alt: ${decl(c.secondaryAlt)};
    --background-tertiary: ${decl(c.tertiary)};
    --background-floating: ${decl(c.floating)};
    --background-base-lowest: ${decl(c.lowest)};
    --background-base-lower: ${decl(c.lower)};
    --background-base-low: ${decl(c.low)};
}
#app-mount, #app-mount > div:not(#${LAYER_ID}) { background-color: transparent !important; }
`;
}

// ---------------------------------------------------------------------------
// layer / media management
// ---------------------------------------------------------------------------

function ensureStyle(): HTMLStyleElement {
    if (styleEl?.isConnected) return styleEl;
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
    return styleEl;
}

function ensureLayer(): HTMLDivElement {
    if (!layerEl?.isConnected) {
        layerEl = document.createElement("div");
        layerEl.id = LAYER_ID;
        layerEl.className = "vc-pnygo-thems";
        layerEl.setAttribute("aria-hidden", "true");

        dimEl = document.createElement("div");
        dimEl.className = "vc-pnygo-thems-dim";
        layerEl.appendChild(dimEl);
    }

    // Discord can remount its tree (theme switch, HMR) — always keep the
    // layer as the FIRST child of #app-mount so it paints behind the app
    const mount = document.getElementById("app-mount");
    if (mount && layerEl.parentElement !== mount) mount.prepend(layerEl);
    else if (!mount && layerEl.parentElement !== document.body) document.body.prepend(layerEl);

    if (!dimEl) {
        dimEl = document.createElement("div");
        dimEl.className = "vc-pnygo-thems-dim";
        layerEl.insertBefore(dimEl, layerEl.firstChild);
    }

    return layerEl;
}

function clearMedia(): void {
    if (mediaEl) {
        try { mediaEl.remove(); } catch { /* already gone */ }
    }
    mediaEl = null;
    mediaSig = "";
    if (mediaState !== "idle") {
        mediaState = "idle";
        mediaError = "";
        notifyUi();
    }
}

function asBlend(value: unknown): Blend {
    return value === "soft-light" || value === "normal" ? value : "overlay";
}

function applyChrome(mode: Mode, alpha: number, overlayAlpha: number, dim: number, blend: Blend): void {
    const layer = ensureLayer();
    const sig = `${mode}|${alpha}|${overlayAlpha}|${dim}|${blend}|${isLight()}`;

    layer.classList.toggle("vc-pnygo-thems--overlay", mode === "overlay");
    layer.style.setProperty("--vc-thems-dim", String(dim));
    layer.style.setProperty("--vc-thems-overlay-alpha", String(overlayAlpha));
    layer.style.setProperty("--vc-thems-blend", blend);

    if (sig === chromeSig && styleEl?.isConnected) return;
    chromeSig = sig;

    const style = ensureStyle();
    style.textContent = mode === "background" ? buildSurfaceCss(alpha) : "";
}

function removeChrome(): void {
    chromeSig = "";
    if (styleEl?.isConnected) styleEl.textContent = "";
    if (layerEl?.isConnected) layerEl.remove();
    layerEl = null;
    dimEl = null;
}

/** object URL for the stored file — reused until the stored file changes */
function fileObjectUrl(file: File): string {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (fileUrl && fileUrlKey === key) return fileUrl;
    if (fileUrl) { try { URL.revokeObjectURL(fileUrl); } catch { /* ignore */ } }
    fileUrl = URL.createObjectURL(file);
    fileUrlKey = key;
    return fileUrl;
}

function setMedia(src: string, mime: string, nameHint = ""): void {
    const layer = ensureLayer();
    const kind = detectKind(src, mime, nameHint);

    if (mediaSig === src && mediaEl) {
        // same source: only make sure it still sits in the live layer,
        // BELOW the dim veil
        if (mediaEl.parentElement !== layer) layer.insertBefore(mediaEl, dimEl ?? null);
        return;
    }

    clearMedia();
    mediaSig = src;
    mediaState = "loading";
    mediaError = "";

    let el: HTMLImageElement | HTMLVideoElement;
    if (kind === "video") {
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = "auto";
        video.disablePictureInPicture = true;
        video.addEventListener("error", () => {
            mediaState = "error";
            mediaError = "That video could not be loaded — the site may block embedding, or the link is not a video.";
            notifyUi();
        }, { once: true });
        video.addEventListener("loadeddata", () => {
            mediaState = "ready";
            mediaError = "";
            notifyUi();
        }, { once: true });
        el = video;
    } else {
        const img = document.createElement("img");
        img.decoding = "async";
        img.draggable = false;
        img.addEventListener("error", () => {
            mediaState = "error";
            mediaError = "That image could not be loaded — check the link (hotlink-protected sites refuse embedding).";
            notifyUi();
        }, { once: true });
        img.addEventListener("load", () => {
            mediaState = "ready";
            mediaError = "";
            notifyUi();
        }, { once: true });
        el = img;
    }

    el.className = "vc-pnygo-thems-media";
    mediaEl = el;
    // insert BEFORE the dim veil so the veil always paints above the picture
    layer.insertBefore(el, dimEl ?? null);

    el.setAttribute("src", src);
    if (el instanceof HTMLVideoElement) syncPlayback();
}

// ---------------------------------------------------------------------------
// video playback — nothing decodes while nobody is looking
// ---------------------------------------------------------------------------

function syncPlayback(): void {
    const el = mediaEl;
    if (!(el instanceof HTMLVideoElement)) return;

    const pauseUnfocused = live()?.themsPauseUnfocused !== false;
    const shouldPause = document.hidden || (pauseUnfocused && !document.hasFocus());

    if (shouldPause) {
        if (!el.paused) el.pause();
    } else if (el.paused) {
        const attempt = el.play();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => { /* autoplay policy */ });
    }
}

// ---------------------------------------------------------------------------
// apply / reapply
// ---------------------------------------------------------------------------

async function reapply(): Promise<void> {
    const run = ++runId;
    const s = live();

    const enabled = s?.enableThems !== false;
    const sourceSel = String(s?.themsSource ?? "off") as Source;
    const mode: Mode = s?.themsMode === "overlay" ? "overlay" : "background";

    const alpha = num(s?.themsAlpha, 60) / 100;
    const overlayAlpha = num(s?.themsOverlay, 30) / 100;
    const dim = num(s?.themsDim, 30) / 100;
    const blend = asBlend(s?.themsBlend);

    // resolve the source first — the glass CSS is only ever injected while a
    // picture is actually there to show
    let src = "";
    let mime = "";
    let nameHint = "";
    if (enabled && sourceSel === "url") {
        src = String(s?.themsUrl ?? "").trim();
    } else if (enabled && sourceSel === "file") {
        const file = await getStoredFile();
        if (file) {
            src = fileObjectUrl(file);
            mime = file.type ?? "";
            nameHint = file.name ?? "";
        }
    }

    if (run !== runId) return; // superseded by a newer change

    if (!src) {
        clearMedia();
        removeChrome();
        return;
    }

    applyChrome(mode, alpha, overlayAlpha, dim, blend);
    setMedia(src, mime, nameHint);
    // settings like "pause unfocused" changed → re-evaluate playback right away
    syncPlayback();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** the "choose a picture/gif/video from my files" row (settings + panel) */
function MediaFilePicker() {
    const [name, setName] = React.useState("");
    const [status, setStatus] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
        let alive = true;
        void getStoredFile()
            .then(f => { if (alive) setName(f ? String(f.name) : ""); })
            .catch(() => { /* nothing stored */ });
        return () => { alive = false; };
    }, []);

    const pick = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;

        if (!MEDIA_FILE_RE.test(file.name) && !/^(image|video)\//i.test(file.type ?? "")) {
            setStatus("That is not an image or video file.");
            return;
        }

        setBusy(true);
        setStatus("Saving the file…");
        try {
            await set(MEDIA_KEY, file);
            storedFile = file;
            storedFileLoaded = true;
            setName(file.name);
            setSetting("themsSource", "file");
            const kb = Math.max(1, Math.round(file.size / 1024));
            setStatus(`Saved “${file.name}” (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`})`);
        } catch (e) {
            logger.warn("could not store the media file:", e);
            setStatus("Could not save that file — try a smaller one.");
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        try { await del(MEDIA_KEY); } catch { /* nothing there */ }
        storedFile = null;
        storedFileLoaded = true;
        setName("");
        setStatus("File removed.");
        setBusy(false);
        if (String(live()?.themsSource) === "file") setSetting("themsSource", "off");
    };

    return (
        <div className="vc-pnygo-thems-picker">
            <div className="vc-pnygo-thems-pickerRow">
                <input
                    ref={inputRef}
                    type="file"
                    accept="image/*,video/*,.png,.jpg,.jpeg,.gif,.webp,.apng,.svg,.mp4,.webm,.mov"
                    style={{ display: "none" }}
                    onChange={e => { void pick(e.currentTarget.files); e.currentTarget.value = ""; }}
                />
                <Button variant="neutral" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
                    {busy ? "…" : "Choose file…"}
                </Button>
                <span className="vc-pnygo-thems-name" title={name}>{name || "No file chosen yet"}</span>
                {name !== "" && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
                        Remove
                    </Button>
                )}
            </div>
            {status && <div className="vc-pnygo-thems-note">{status}</div>}
        </div>
    );
}

export const settings = {
    themsSource: {
        type: OptionType.SELECT,
        description: "Thems — which background to show (pick a file or paste a link from the titlebar panel)",
        options: [
            { label: "Off", value: "off", default: true },
            { label: "Local file (picked on this PC)", value: "file" },
            { label: "Link (image / gif / video URL)", value: "url" },
        ],
    },
    themsUrl: {
        type: OptionType.STRING,
        description: "Thems — image, GIF or video link (https://)",
        default: "",
        placeholder: "https://…/wallpaper.jpg",
    },
    themsMediaFile: {
        type: OptionType.COMPONENT,
        component: MediaFilePicker,
    },
    themsMode: {
        type: OptionType.SELECT,
        description: "Thems — Background: behind the UI, Discord turns glassy. Overlay: drawn on top of everything at a low opacity",
        options: [
            { label: "Background (behind the UI)", value: "background", default: true },
            { label: "Overlay (on top)", value: "overlay" },
        ],
    },
    themsAlpha: {
        type: OptionType.SLIDER,
        description: "Thems — UI opacity in Background mode (lower = more of the picture shows through)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as number[],
        stickToMarkers: false,
        default: 60,
    },
    themsOverlay: {
        type: OptionType.SLIDER,
        description: "Thems — opacity of the picture in Overlay mode (with Overlay / Soft light blending the text stays readable at any value)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as number[],
        stickToMarkers: false,
        default: 30,
    },
    themsBlend: {
        type: OptionType.SELECT,
        description: "Thems — how the picture blends with the UI in Overlay mode; Overlay / Soft light preserve text contrast, Normal can cover the UI",
        options: [
            { label: "Overlay — keeps text readable", value: "overlay", default: true },
            { label: "Soft light — subtler", value: "soft-light" },
            { label: "Normal — plain, can cover text", value: "normal" },
        ],
    },
    themsDim: {
        type: OptionType.SLIDER,
        description: "Thems — dark veil over the picture in Background mode (keeps text readable)",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as number[],
        stickToMarkers: false,
        default: 30,
    },
    themsPauseUnfocused: {
        type: OptionType.BOOLEAN,
        description: "Thems — also pause the video while another window is in front of Discord (it always pauses while Discord is hidden)",
        default: true,
    },
} as const;

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

function Range({ label, hint, value, onChange }: {
    label: string;
    hint?: string;
    value: number;
    onChange: (v: number) => void;
}) {
    return (
        <Field label={`${label} — ${value}%`} hint={hint}>
            <input
                className="vc-pnygo-thems-range"
                type="range"
                min={0}
                max={100}
                step={1}
                value={value}
                onChange={e => onChange(Number(e.currentTarget.value))}
            />
        </Field>
    );
}

function ThemsPanel(props: any) {
    const { onClose } = props;
    const [, force] = React.useReducer((x: number) => x + 1, 0);

    React.useEffect(() => {
        const cb = () => force();
        SettingsStore.addPrefixChangeListener("plugins.pnygo", cb);
        uiListeners.add(cb);
        return () => {
            SettingsStore.removePrefixChangeListener("plugins.pnygo", cb);
            uiListeners.delete(cb);
        };
    }, []);

    const s = live();
    const mode: Mode = s.themsMode === "overlay" ? "overlay" : "background";
    const source: Source = (["off", "file", "url"].includes(String(s.themsSource)) ? s.themsSource : "off") as Source;

    const [draft, setDraft] = React.useState(() => String(s.themsUrl ?? ""));
    const [err, setErr] = React.useState("");

    const applyLink = () => {
        const value = draft.trim();
        if (value && !/^https:\/\//i.test(value) && !/^data:/i.test(value)) {
            setErr("The link must start with https://");
            return;
        }
        setErr("");
        setSetting("themsUrl", value);
        setSetting("themsSource", value ? "url" : "off");
    };

    const turnOff = () => {
        setErr("");
        setSetting("themsSource", "off");
    };

    const nothingYet = source === "file" && mediaState === "idle";
    const noLink = source === "url" && !String(s.themsUrl ?? "").trim();

    return (
        <Modal
            {...props}
            size="md"
            title="Thems"
            actions={[{ text: "Close", variant: "secondary", onClick: onClose }]}
        >
            <div className="vc-pnygo-thems-panel">
                <Card title="Picture or video" subtitle="Image, animated GIF or video — a local file or any https link (links without a file extension are treated as pictures)">
                    <div className="vc-pnygo-thems-row">
                        <Input
                            value={draft}
                            spellCheck={false}
                            placeholder="https://…/wallpaper.jpg"
                            onChange={e => { setDraft(e.currentTarget.value); setErr(""); }}
                            onKeyDown={e => { if (e.key === "Enter") applyLink(); }}
                        />
                        <Button variant="primary" onClick={applyLink}>Use link</Button>
                    </div>

                    <MediaFilePicker />

                    <div className="vc-pnygo-thems-row vc-pnygo-thems-statusRow">
                        <Chip tone={source === "off" ? "default" : "ok"}>
                            {source === "off" ? "Off" : source === "file" ? "Local file" : "Link"}
                        </Chip>
                        <Chip tone={mediaState === "ready" ? "ok" : mediaState === "error" ? "bad" : mediaState === "loading" ? "warn" : "default"}>
                            {mediaState === "ready" ? "Loaded" : mediaState === "error" ? "Failed" : mediaState === "loading" ? "Loading…" : "—"}
                        </Chip>
                        {source !== "off" && (
                            <Button variant="danger" size="sm" onClick={turnOff}>Turn off</Button>
                        )}
                    </div>

                    {err && <div className="vc-pnygo-thems-note vc-pnygo-thems-note--bad">{err}</div>}
                    {mediaState === "error" && (
                        <div className="vc-pnygo-thems-note vc-pnygo-thems-note--bad">{mediaError}</div>
                    )}
                    {nothingYet && (
                        <div className="vc-pnygo-thems-note">No file is stored yet — press “Choose file…” above.</div>
                    )}
                    {noLink && (
                        <div className="vc-pnygo-thems-note">Paste a link above and press “Use link”.</div>
                    )}
                </Card>

                <Card title="Appearance">
                    <Tabs<Mode>
                        tabs={[
                            { id: "background", label: "Background" },
                            { id: "overlay", label: "Overlay" },
                        ]}
                        value={mode}
                        onChange={v => setSetting("themsMode", v)}
                    />

                    {mode === "background" ? (
                        <>
                            <Range
                                label="UI opacity"
                                hint="How solid Discord's surfaces are — lower shows more of the picture"
                                value={num(s.themsAlpha, 60)}
                                onChange={v => setSetting("themsAlpha", v)}
                            />
                            <Range
                                label="Dark veil"
                                hint="Darkens the picture so text stays readable"
                                value={num(s.themsDim, 30)}
                                onChange={v => setSetting("themsDim", v)}
                            />
                        </>
                    ) : (
                        <>
                            <Range
                                label="Overlay opacity"
                                hint="Brightness of the picture over the client (modals stay untouched)"
                                value={num(s.themsOverlay, 30)}
                                onChange={v => setSetting("themsOverlay", v)}
                            />
                            <Field
                                label="Blend mode"
                                hint="How the picture combines with what is underneath — Overlay / Soft light keep text, names and icons readable at any opacity"
                            >
                                <Tabs<Blend>
                                    tabs={[
                                        { id: "overlay", label: "Overlay" },
                                        { id: "soft-light", label: "Soft light" },
                                        { id: "normal", label: "Normal" },
                                    ]}
                                    value={asBlend(s.themsBlend)}
                                    onChange={v => setSetting("themsBlend", v)}
                                />
                            </Field>
                        </>
                    )}

                    <Switch
                        checked={s.themsPauseUnfocused !== false}
                        onChange={v => setSetting("themsPauseUnfocused", v)}
                        label="Pause the video when Discord is not focused"
                        hint="It always pauses while Discord is hidden — this also pauses it when another window is in front"
                    />
                </Card>

                <Card title="Performance" variant="flat">
                    <div className="vc-pnygo-thems-note">
                        One fixed layer that never moves or resizes, so scrolling and typing never repaint it.
                        Pictures and GIFs are decoded once and then free. Videos are muted, looped and paused
                        while Discord is hidden (or unfocused, see the switch above). No CSS filters, no
                        backdrop-blur, no animations, no per-frame JavaScript. Overlay mode adds one GPU
                        blend (Overlay / Soft light) so the picture merges with the UI instead of covering it —
                        text and names keep their contrast at any opacity.
                    </div>
                </Card>
            </div>
        </Modal>
    );
}

/** opens the Thems panel (and counts as a live self-check probe) */
export function openThems(): boolean {
    hit("thems");
    return openPanel(props => <ThemsPanel {...props} />);
}

// ---------------------------------------------------------------------------
// wiring (index.tsx pulls all of this in)
// ---------------------------------------------------------------------------

function ThemeHeaderButton() {
    return (
        <TitlebarButton
            id="thems"
            tooltip="Thems — background picture / gif / video"
            onClick={() => openThems()}
        >
            <Icons.image size={18} />
        </TitlebarButton>
    );
}

export function ThemsHeaderButton_() {
    return (
        <ErrorBoundary key="vc-thems-titlebar" noop>
            <ThemeHeaderButton />
        </ErrorBoundary>
    );
}

export const toolboxActions = {
    "Thems": () => openThems(),
};

let settingsListener: (() => void) | undefined;
let themeListener: (() => void) | undefined;
const onVisibility = () => syncPlayback();
const onFocus = () => syncPlayback();
const onBlur = () => syncPlayback();

export function start(store: Record<string, any>): void {
    storeRef = store;

    settingsListener = () => { void reapply(); };
    themeListener = () => { void reapply(); };

    SettingsStore.addPrefixChangeListener("plugins.pnygo", settingsListener);
    ThemeStore.addChangeListener(themeListener);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    void reapply();
}

export function stop(): void {
    if (settingsListener) {
        SettingsStore.removePrefixChangeListener("plugins.pnygo", settingsListener);
        settingsListener = undefined;
    }
    if (themeListener) {
        ThemeStore.removeChangeListener(themeListener);
        themeListener = undefined;
    }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);

    runId++;
    clearMedia();
    removeChrome();
    mediaState = "idle";
    mediaError = "";
    if (fileUrl) { try { URL.revokeObjectURL(fileUrl); } catch { /* ignore */ } }
    fileUrl = "";
    fileUrlKey = "";
    storedFile = null;
    storedFileLoaded = false;
    storeRef = {};
    notifyUi();
}
