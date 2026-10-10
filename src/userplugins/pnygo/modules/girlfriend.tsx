/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - Girlfriend submodule
 *
 * Four settings:
 *   - the TITLE of her card (the "Her" at the top — write anything you like)
 *   - the Discord user ID of the person
 *   - an .mp3 FILE picked from your computer (not a link). The picker also
 *     TRIMS it: drag Start/End to pick the exact part of the song, press
 *     Preview to HEAR that part before it is used, and the chosen window is
 *     stored next to the file in IndexedDB (the file itself is never
 *     re-encoded — the card simply plays 0:00 of it until the window ends
 *     and then loops back to the start of the window).
 *   - a volume slider (also used by the trim preview)
 *
 * The picked file is COPIED into Vencord's own IndexedDB store
 * (VencordData / VencordStore), so it keeps working after a restart and the
 * original file on disk can be moved or deleted at any time. The plugin
 * settings only ever hold the file's NAME, never its bytes, so the settings
 * panel stays small.
 *
 * The heart button in the top titlebar opens ONE centered card that shows her
 * profile (name, @user, avatar, avatar decoration, bio, badges) and starts
 * that song by itself, at the configured volume.
 *
 * The audio element lives exactly as long as the card: closing it (or stopping
 * the plugin) silences it, so nothing keeps playing in the background.
 *
 * Everything is cosmetic and local: nothing is written to Discord.
 */

import "./girlfriend.css";

import { del, get, set } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Modal, React } from "@webpack/common";

import { hit } from "./probe";
import { fetchUserProfile, ProfileCard, type UserProfile } from "./profile";
import { Icons, openPanel, TitlebarButton } from "./ui";

const logger = new Logger("pnygo/Girlfriend");

/** where the picked .mp3 lives (IndexedDB, not in the plugin settings) */
const SONG_KEY = "vc-pnygo:girlfriend-song";

/** the stored song: the file + the trim window (legacy entries are a bare File) */
type SongRecord = { file: File; start: number; end: number; };

async function getSongRecord(): Promise<SongRecord | null> {
    try {
        const raw = await get<any>(SONG_KEY);
        if (!raw) return null;
        if (raw instanceof File) return { file: raw, start: 0, end: 0 };
        if (raw && raw.file instanceof File) {
            const s = Number(raw.start);
            const e = Number(raw.end);
            return {
                file: raw.file,
                start: Number.isFinite(s) && s > 0 ? s : 0,
                end: Number.isFinite(e) && e > 0 ? e : 0,
            };
        }
        return null;
    } catch { return null; }
}

async function saveSongRecord(file: File, start: number, end: number): Promise<void> {
    await set(SONG_KEY, { file, start, end });
}

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

/** the audio element of the currently open card — killed by stop() too */
let currentAudio: HTMLAudioElement | null = null;

/** the settings-panel trim preview — killed by stop() too */
let currentPreview: HTMLAudioElement | null = null;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const AUDIO_FILE_RE = /\.(mp3|ogg|oga|wav|m4a|flac|opus)$/i;

/**
 * the "choose an mp3 from my files" row in the plugin settings, plus a
 * Start/End trim editor with a live preview of the selected segment
 */
function SongFilePicker({ setValue }: { setValue: (value: any) => void; }) {
    const [name, setName] = React.useState(() => String(storeRef.girlfriendSongFile ?? ""));
    const [status, setStatus] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [duration, setDuration] = React.useState(0);
    const [start, setStart] = React.useState(0);
    const [end, setEnd] = React.useState(0);
    const [previewing, setPreviewing] = React.useState(false);
    const [previewErr, setPreviewErr] = React.useState("");
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    const fileRef = React.useRef<File | null>(null);
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const urlRef = React.useRef("");
    const saveTimerRef = React.useRef<number | null>(null);
    const startRef = React.useRef(0);
    const endRef = React.useRef(0);

    // the clamped window everything below agrees on (sliders, preview, save)
    const startD = duration > 0 ? Math.max(0, Math.min(start, Math.max(0, duration - 0.5))) : 0;
    const endD = duration > 0 ? Math.max(startD + 0.5, Math.min(end > 0 ? end : duration, duration)) : 0;
    startRef.current = startD;
    endRef.current = endD;

    const stopPreview = React.useCallback(() => {
        const a = audioRef.current;
        if (a) {
            try { a.pause(); } catch { /* ignore */ }
            try { a.currentTime = startRef.current; } catch { /* ignore */ }
        }
        currentPreview = null;
        setPreviewing(false);
    }, []);

    const disposeAudio = React.useCallback(() => {
        const a = audioRef.current;
        if (a) { try { a.pause(); } catch { /* ignore */ } }
        audioRef.current = null;
        currentPreview = null;
        if (urlRef.current) { try { URL.revokeObjectURL(urlRef.current); } catch { /* ignore */ } }
        urlRef.current = "";
        setPreviewing(false);
    }, []);

    const ensureAudio = React.useCallback((file: File) => {
        if (audioRef.current) return;
        urlRef.current = URL.createObjectURL(file);
        const a = new Audio(urlRef.current);
        a.preload = "metadata";
        a.addEventListener("loadedmetadata", () => {
            setDuration(Number.isFinite(a.duration) ? a.duration : 0);
        });
        a.addEventListener("error", () => {
            setPreviewErr("That file could not be loaded as audio.");
        });
        audioRef.current = a;
    }, []);

    // load the stored song + its trim on first mount
    React.useEffect(() => {
        let alive = true;
        void (async () => {
            const rec = await getSongRecord();
            if (!alive || !rec) return;
            fileRef.current = rec.file;
            setName(String(rec.file.name));
            setStart(rec.start);
            setEnd(rec.end);
            ensureAudio(rec.file);
        })();

        return () => {
            alive = false;
            // flush a trim the user made right before closing the settings
            if (saveTimerRef.current) {
                window.clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
                const f = fileRef.current;
                if (f) void saveSongRecord(f, startRef.current, endRef.current).catch(() => { /* ignore */ });
            }
            disposeAudio();
        };
    }, [ensureAudio, disposeAudio]);

    const scheduleSave = () => {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            const f = fileRef.current;
            if (!f) return;
            void saveSongRecord(f, startRef.current, endRef.current)
                .catch(e => logger.warn("could not save the trim:", e));
        }, 400);
    };

    // preview: follow the sliders EXACTLY — wherever you drag a line, the
    // audio jumps there on the next frame; one full pass then stops
    React.useEffect(() => {
        if (!previewing) return;
        let raf = 0;
        let lastStart = startRef.current;
        let lastEnd = endRef.current;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const a = audioRef.current;
            if (!a) { setPreviewing(false); return; }

            const s = startRef.current;
            const e = endRef.current;
            const startMoved = s !== lastStart;
            const endMoved = e !== lastEnd;

            if (startMoved || endMoved) {
                lastStart = s;
                lastEnd = e;
                // start dragged → always land on it; end dragged below the
                // playhead → fall back to the start of the window
                if (startMoved || a.currentTime >= e - 0.03 || a.currentTime < s - 0.05) {
                    try { a.currentTime = s; } catch { /* ignore */ }
                }
                return;
            }

            if (a.currentTime >= e - 0.03 || a.paused) {
                // one full pass finished (or playback was refused) — rewind & stop
                try { a.currentTime = s; } catch { /* ignore */ }
                try { a.pause(); } catch { /* ignore */ }
                currentPreview = null;
                setPreviewing(false);
                return;
            }
            if (a.currentTime < s - 0.05) {
                try { a.currentTime = s; } catch { /* ignore */ }
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [previewing]);

    const pick = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;

        if (!AUDIO_FILE_RE.test(file.name) && !/^audio\//i.test(file.type ?? "")) {
            setStatus("That is not an audio file — please choose an .mp3.");
            return;
        }

        if (saveTimerRef.current) { window.clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        disposeAudio();

        setBusy(true);
        setStatus("Saving the file…");
        try {
            await saveSongRecord(file, 0, 0);
            fileRef.current = file;
            setName(file.name);
            setValue(file.name);
            setDuration(0);
            setStart(0);
            setEnd(0);
            setPreviewErr("");
            ensureAudio(file);
            setStatus(`Saved “${file.name}” (${Math.max(1, Math.round(file.size / 1024))} KB) — trim it below.`);
        } catch (e) {
            logger.warn("could not store the song:", e);
            setStatus("Could not save that file — try a smaller one.");
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        if (saveTimerRef.current) { window.clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        disposeAudio();
        try { await del(SONG_KEY); } catch { /* nothing there */ }
        fileRef.current = null;
        setName("");
        setValue("");
        setDuration(0);
        setStart(0);
        setEnd(0);
        setStatus("Song removed.");
        setBusy(false);
    };

    const preview = () => {
        const a = audioRef.current;
        if (!a || duration <= 0) return;
        setPreviewErr("");
        const vol = Number(storeRef.girlfriendVolume);
        a.volume = Math.max(0, Math.min(1, (Number.isFinite(vol) ? vol : 70) / 100));
        try { a.currentTime = startRef.current; } catch { /* ignore */ }
        const attempt = a.play();
        if (attempt && typeof attempt.catch === "function") {
            attempt.catch(() => {
                setPreviewing(false);
                setPreviewErr("Preview was blocked — press it once more.");
            });
        }
        currentPreview = a;
        setPreviewing(true);
    };

    return (
        <div className="vc-pnygo-gf-picker">
            <div className="vc-pnygo-gf-pickerTitle">Song file (.mp3)</div>
            <div className="vc-pnygo-gf-pickerDesc">
                Picked from your computer and copied into Vencord's storage — trim it below, then it plays
                automatically when the card opens.
            </div>

            <div className="vc-pnygo-gf-pickerRow">
                <input
                    ref={inputRef}
                    type="file"
                    accept="audio/mpeg,audio/ogg,audio/wav,audio/*,.mp3,.ogg,.wav"
                    style={{ display: "none" }}
                    onChange={e => { void pick(e.currentTarget.files); e.currentTarget.value = ""; }}
                />
                <button
                    type="button"
                    className="vc-pnygo-gf-pickerBtn"
                    disabled={busy}
                    onClick={() => inputRef.current?.click()}
                >
                    {busy ? "…" : "Choose mp3 file…"}
                </button>

                <span className="vc-pnygo-gf-pickerName" title={name}>
                    {name || "No file chosen yet"}
                </span>

                {name !== "" && (
                    <button type="button" className="vc-pnygo-gf-pickerBtn vc-pnygo-gf-pickerBtn--ghost" onClick={() => void remove()}>
                        Remove
                    </button>
                )}
            </div>

            {status && <div className="vc-pnygo-gf-pickerHint">{status}</div>}

            {duration > 0 && (
                <div className="vc-pnygo-gf-trim">
                    <div className="vc-pnygo-gf-trimHead">
                        <span>Trim the song</span>
                        <span className="vc-pnygo-gf-trimTimes">
                            {fmtTime(startD)} → {fmtTime(endD)} · {fmtTime(endD - startD)} long
                        </span>
                    </div>

                    <label className="vc-pnygo-gf-trimRow">
                        <span className="vc-pnygo-gf-trimLabel">Start</span>
                        <input
                            className="vc-pnygo-gf-trimRange"
                            type="range"
                            min={0}
                            max={Math.max(0.5, endD - 0.5)}
                            step={0.1}
                            value={startD}
                            onChange={e => { setStart(Number(e.currentTarget.value)); scheduleSave(); }}
                        />
                        <span className="vc-pnygo-gf-trimVal">{fmtTime(startD)}</span>
                    </label>

                    <label className="vc-pnygo-gf-trimRow">
                        <span className="vc-pnygo-gf-trimLabel">End</span>
                        <input
                            className="vc-pnygo-gf-trimRange"
                            type="range"
                            min={startD + 0.5}
                            max={duration}
                            step={0.1}
                            value={endD}
                            onChange={e => { setEnd(Number(e.currentTarget.value)); scheduleSave(); }}
                        />
                        <span className="vc-pnygo-gf-trimVal">{fmtTime(endD)}</span>
                    </label>

                    <div className="vc-pnygo-gf-trimBtns">
                        <button type="button" className="vc-pnygo-gf-pickerBtn" disabled={previewing} onClick={preview}>
                            {previewing ? "Playing…" : "▶ Preview segment"}
                        </button>
                        <button type="button" className="vc-pnygo-gf-pickerBtn vc-pnygo-gf-pickerBtn--neutral" onClick={stopPreview}>
                            ■ Stop
                        </button>
                        <button
                            type="button"
                            className="vc-pnygo-gf-pickerBtn vc-pnygo-gf-pickerBtn--neutral"
                            onClick={() => { setStart(0); setEnd(duration); scheduleSave(); }}
                        >
                            Full song
                        </button>
                    </div>

                    <div className="vc-pnygo-gf-pickerHint">
                        Preview plays exactly the part you selected — hear it before it is used.
                    </div>
                    {previewErr && <div className="vc-pnygo-gf-pickerHint">{previewErr}</div>}
                </div>
            )}
        </div>
    );
}

export const settings = {
    girlfriendTitle: {
        type: OptionType.STRING,
        description: "Girlfriend — the title shown at the top of her card (write anything you like)",
        placeholder: "Her",
        default: "Her",
    },
    girlfriendUserId: {
        type: OptionType.STRING,
        description: "Girlfriend — her Discord user ID",
        placeholder: "123456789012345678",
        default: "",
    },
    girlfriendSongFile: {
        type: OptionType.COMPONENT,
        component: SongFilePicker,
    },
    girlfriendVolume: {
        type: OptionType.SLIDER,
        description: "Girlfriend — song volume",
        markers: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as number[],
        stickToMarkers: false,
        default: 70,
    },
} as const;

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

/** ten hearts that drift up the card forever */
// must stay a function: creating JSX while the renderer bundle is still evaluating
// reads Vencord.Webpack before the global exists and aborts the whole Vencord startup.
const getHearts = () => Array.from({ length: 10 }, (_, i) => (
    <i
        key={i}
        className="vc-pnygo-gf-heart"
        style={{
            left: `${(i * 37 + 6) % 96}%`,
            animationDelay: `${-(i % 5) * 1.7}s`,
            animationDuration: `${7 + (i % 4) * 1.6}s`,
            fontSize: `${13 + (i % 4) * 5}px`,
        }}
    />
));

/** the equalizer — bar heights come from the song itself (Web Audio), never from CSS */
const BAR_COUNT = 44;

function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
}

/** "#ff4d8d" -> "255,77,141" so CSS can build rgba() out of the accent var */
function hexToRgb(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return "255,77,141";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** hue (0..360) of the accent colour — the bars sweep around it, no CSS filters */
function hexToHue(hex: string): number {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return 330;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!d) return 330;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return Math.round(h < 0 ? h + 360 : h);
}

function Equalizer({ eqRef, litCount, live, hue }: {
    eqRef: React.RefObject<HTMLDivElement | null>;
    /** how many bars are behind the playback position (React owns the classes) */
    litCount: number;
    live: boolean;
    /** accent hue — every bar is painted from it, no CSS filters at runtime */
    hue: number;
}) {
    // one sweep across the strip: pink -> purple -> blue, tight enough to stay coherent
    const colorFor = (i: number) => Math.round((((hue - i * 3) % 360) + 360) % 360);

    return (
        <div className={`vc-pnygo-gf-eq${live ? " vc-pnygo-gf-eq--live" : ""}`} ref={eqRef} aria-hidden="true">
            {Array.from({ length: BAR_COUNT }, (_, i) => {
                const on = i < litCount;
                const h = colorFor(i);
                // colours are computed here, once per render — the analyser loop
                // only writes `height`, so nothing expensive runs per frame
                const style: React.CSSProperties = on
                    ? {
                        background: `linear-gradient(180deg, #ffffff 0%, hsl(${h} 100% 80%) 24%, hsl(${h} 96% 60%) 72%, hsl(${(h - 20 + 360) % 360} 96% 52%) 100%)`,
                        boxShadow: `0 0 10px hsl(${h} 96% 62% / .7)`,
                    }
                    : {
                        background: `linear-gradient(180deg, hsl(${h} 96% 72% / .95) 0%, hsl(${h} 96% 54% / .32) 100%)`,
                    };

                return (
                    <span
                        key={i}
                        className={`vc-pnygo-gf-eqBar${on ? " vc-pnygo-gf-eqBar--on" : ""}`}
                        style={style}
                    />
                );
            })}
        </div>
    );
}

function GirlfriendCard(props: any) {
    const { onClose } = props;

    const volume = Math.max(0, Math.min(100, Number(storeRef.girlfriendVolume) || 0)) / 100;

    const [profile, setProfile] = React.useState<UserProfile | null>(null);
    const [loading, setLoading] = React.useState(true);

    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const [songState, setSongState] = React.useState<"loading" | "ready" | "none" | "error">("loading");
    const [playing, setPlaying] = React.useState(false);
    const [pos, setPos] = React.useState(0);
    const [dur, setDur] = React.useState(0);
    const [blocked, setBlocked] = React.useState(false);
    const [audioErr, setAudioErr] = React.useState("");
    /** the active trim window from the settings picker (null = whole file) */
    const [trimWin, setTrimWin] = React.useState<{ s: number; e: number; } | null>(null);

    // ---- spectrum: the bars follow the song, not a CSS loop ----------------
    const stageRef = React.useRef<HTMLDivElement | null>(null);
    const eqRef = React.useRef<HTMLDivElement | null>(null);
    const graphRef = React.useRef<{ ctx: AudioContext; source: MediaElementAudioSourceNode; } | null>(null);
    const attachingRef = React.useRef(false);
    const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);

    /**
     * Routes the element through an AnalyserNode so the bars can read the real
     * frequency data. Never routes the element unless the AudioContext is
     * already RUNNING — a suspended context would mute the song — so on a cold
     * start we bail out and retry on the first real click.
     */
    const attachGraph = React.useCallback(async (a: HTMLAudioElement | null) => {
        if (!a || graphRef.current || attachingRef.current) return;
        attachingRef.current = true;
        try {
            const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
            if (!AC) return;

            const ctx: AudioContext = new AC();
            if (ctx.state !== "running") {
                try { await ctx.resume(); } catch { /* ignore */ }
            }
            if (ctx.state !== "running") {
                // no user activation yet — drop it and retry on a click
                try { await ctx.close(); } catch { /* ignore */ }
                return;
            }

            const source = ctx.createMediaElementSource(a);
            const fft = ctx.createAnalyser();
            fft.fftSize = 256; // 128 bins, more than enough for 44 bars
            fft.smoothingTimeConstant = 0.78;
            source.connect(fft);
            fft.connect(ctx.destination);

            graphRef.current = { ctx, source };
            setAnalyser(fft);
        } catch (e) {
            logger.warn("could not attach the spectrum analyser:", e);
        } finally {
            attachingRef.current = false;
        }
    }, []);

    // ---- profile ---------------------------------------------------------
    React.useEffect(() => {
        let alive = true;
        fetchUserProfile(storeRef.girlfriendUserId)
            .then(p => { if (alive) setProfile(p); })
            .catch(e => logger.warn("profile fetch failed:", e))
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, []);

    // ---- autoplay: pull the picked file out of IndexedDB and play it -----
    React.useEffect(() => {
        let alive = true;
        let audio: HTMLAudioElement | null = null;
        let url = "";
        let detach: (() => void) | null = null;

        (async () => {
            let file: File | null = null;
            let tStart = 0;
            let tEnd = 0;
            try {
                const rec = await getSongRecord();
                file = rec?.file ?? null;
                if (rec) { tStart = rec.start; tEnd = rec.end; }
            } catch { file = null; }
            if (!alive) return;

            if (!file) { setSongState("none"); return; }

            try {
                url = URL.createObjectURL(file);
                audio = new Audio(url);
            } catch {
                setSongState("error");
                setAudioErr("That file could not be loaded as audio.");
                return;
            }

            const a = audio;
            a.loop = true;
            a.volume = volume;
            audioRef.current = a;
            currentAudio = a;

            let trimActive = false;

            const onTime = () => {
                setPos(a.currentTime);
                // stay inside the trimmed window — timeupdate keeps firing even
                // when requestAnimationFrame is throttled (Discord in background)
                if (trimActive && a.currentTime >= tEnd - 0.03) a.currentTime = tStart;
            };
            const onMeta = () => {
                const d = Number.isFinite(a.duration) ? a.duration : 0;
                setDur(d);
                if (d > 0) {
                    // clamp the stored window to the real file, then adopt it
                    if (tEnd <= 0 || tEnd > d) tEnd = d;
                    if (tStart >= tEnd - 0.05) tStart = 0;
                    trimActive = tStart > 0.05 || tEnd < d - 0.05;
                    if (trimActive) {
                        setTrimWin({ s: tStart, e: tEnd });
                        // start AT the chosen point — never play the head of the file
                        try { a.currentTime = tStart; } catch { /* ignore */ }
                    }
                }
            };
            const onPlay = () => { setPlaying(true); setBlocked(false); };
            const onPause = () => setPlaying(false);
            const onError = () => {
                setPlaying(false);
                setSongState("error");
                setAudioErr("Could not play that file.");
            };

            a.addEventListener("timeupdate", onTime);
            a.addEventListener("loadedmetadata", onMeta);
            a.addEventListener("play", onPlay);
            a.addEventListener("pause", onPause);
            a.addEventListener("error", onError);

            const stage = stageRef.current;
            void attachGraph(a);
            // cold start: the context only becomes RUNNING on the first real click
            const onGesture = () => { void attachGraph(a); };
            stage?.addEventListener("pointerdown", onGesture, { capture: true });

            detach = () => {
                a.removeEventListener("timeupdate", onTime);
                a.removeEventListener("loadedmetadata", onMeta);
                a.removeEventListener("play", onPlay);
                a.removeEventListener("pause", onPause);
                a.removeEventListener("error", onError);
                stage?.removeEventListener("pointerdown", onGesture, { capture: true });
            };

            setSongState("ready");

            const tryPlay = () => {
                const attempt = a.play();
                if (attempt && typeof attempt.catch === "function") {
                    // the browser may refuse an unprompted autoplay — offer the button
                    attempt.catch(() => { setPlaying(false); setBlocked(true); });
                }
            };

            // wait for metadata first: onMeta must do the trim seek BEFORE
            // playback starts, so the song never plays its untrimmed head
            if (a.readyState >= 1) tryPlay();
            else {
                const once = () => { a.removeEventListener("loadedmetadata", once); tryPlay(); };
                a.addEventListener("loadedmetadata", once);
            }
        })();

        return () => {
            alive = false;
            try { detach?.(); } catch { /* ignore */ }
            try { audio?.pause(); } catch { /* ignore */ }
            if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
            if (currentAudio === audio) currentAudio = null;
            if (audioRef.current === audio) audioRef.current = null;
            setTrimWin(null);

            // closing the context unroutes the element — safe, it is discarded below
            const g = graphRef.current;
            graphRef.current = null;
            setAnalyser(null);
            try { void g?.ctx.close(); } catch { /* ignore */ }
        };
    }, [volume, attachGraph]);

    // ---- paint the bars + the side lights from the real spectrum ----------
    React.useEffect(() => {
        if (!analyser) return;

        const bins = new Uint8Array(analyser.frequencyBinCount);
        const levels = new Float32Array(BAR_COUNT);
        let raf = 0;

        const tick = () => {
            raf = requestAnimationFrame(tick);
            analyser.getByteFrequencyData(bins);

            const stage = stageRef.current;
            const eq = eqRef.current;
            if (!stage || !eq) return;

            const bars = eq.children;
            const usable = Math.max(8, Math.floor(bins.length * 0.7)); // the top bins are noise
            let sum = 0;

            for (let i = 0; i < BAR_COUNT && i < bars.length; i++) {
                const t = i / (BAR_COUNT - 1);
                const start = Math.min(usable - 2, Math.floor(Math.pow(t, 1.9) * (usable - 4)));
                const end = Math.min(usable, start + 3);

                let peak = 0;
                for (let b = start; b < end; b++) peak = Math.max(peak, bins[b]);

                // lows carry far more energy — tilt the curve back down
                const target = (peak / 255) * (1.25 - 0.45 * t);
                const prev = levels[i];
                // fast attack, slow release: follows the tune, never drifts by itself
                levels[i] = target > prev
                    ? prev + (target - prev) * 0.55
                    : prev + (target - prev) * 0.16;
                sum += levels[i];

                const bar = bars[i] as HTMLElement | undefined;
                if (bar) bar.style.height = `${(4 + Math.min(1, levels[i]) * 96).toFixed(1)}%`;
            }

            stage.style.setProperty("--vc-gf-level", Math.min(1, (sum / BAR_COUNT) * 2.4).toFixed(3));
        };

        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            stageRef.current?.style.setProperty("--vc-gf-level", "0");
        };
    }, [analyser]);

    const toggleAudio = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) {
            void attachGraph(audio); // real user gesture → the context can run
            const attempt = audio.play();
            if (attempt && typeof attempt.catch === "function") attempt.catch(() => setBlocked(true));
        } else {
            audio.pause();
        }
    };

    // the card shows the TRIMMED window (that is "the song"), not the raw file
    const winS = trimWin?.s ?? 0;
    const winE = trimWin?.e ?? dur;
    const winLen = Math.max(0.001, winE - winS);
    const shownPos = trimWin ? Math.max(0, Math.min(winLen, pos - winS)) : pos;
    const shownDur = trimWin ? winLen : dur;
    const percent = shownDur > 0 ? Math.min(100, (shownPos / shownDur) * 100) : 0;
    const litCount = Math.round((percent / 100) * BAR_COUNT);
    const accent = profile?.accent || "#ff4d8d";

    // sits ABOVE the data table (ProfileCard's aboveFacts slot)
    const cardTitle = String(storeRef.girlfriendTitle ?? "").trim() || "Her";
    const eqStrip = songState === "ready" ? (
        <div className="vc-pnygo-gf-eqStrip">
            <div className="vc-pnygo-gf-eqHead">
                <span className="vc-pnygo-gf-eqLabel">{playing ? "Now playing" : "Paused"}</span>
                <span className="vc-pnygo-gf-eqTime">{fmtTime(shownPos)} / {fmtTime(shownDur)}</span>
            </div>
            <Equalizer eqRef={eqRef} litCount={litCount} live={playing} hue={hexToHue(accent)} />
            <div className="vc-pnygo-gf-progress">
                <div className="vc-pnygo-gf-progressFill" style={{ width: `${percent}%` }} />
            </div>
        </div>
    ) : null;

    const player = songState === "ready" ? (
        <div className="vc-pnygo-gf-player">
            <div className="vc-pnygo-gf-playerTop">
                <button
                    type="button"
                    className="vc-pnygo-gf-playBtn"
                    onClick={toggleAudio}
                    title={playing ? "Pause" : "Play"}
                >
                    {playing ? "❚❚" : "▶"}
                </button>
                <div className="vc-pnygo-gf-playerMeta">
                    <div className="vc-pnygo-gf-playerTitle">Our song</div>
                    <div className="vc-pnygo-gf-playerSub">
                        {Math.round(volume * 100)}% · {playing ? "playing" : "paused"}
                    </div>
                </div>
                <span className={`vc-pnygo-gf-beat${playing ? " vc-pnygo-gf-beat--on" : ""}`}>
                    <Icons.heart size={16} />
                </span>
            </div>

            {blocked && (
                <div className="vc-pnygo-pf-note vc-pnygo-pf-note--bad">
                    Autoplay was blocked by the browser — press ▶ once.
                </div>
            )}
        </div>
    ) : songState === "loading" ? (
        <div className="vc-pnygo-pf-note">Loading the song…</div>
    ) : songState === "error" ? (
        <div className="vc-pnygo-pf-note vc-pnygo-pf-note--bad">
            {audioErr || "The song could not be played."}
        </div>
    ) : (
        <div className="vc-pnygo-pf-note">
            No song yet — open pnygo’s settings and press “Choose mp3 file…”.
        </div>
    );

    return (
        <Modal
            {...props}
            size="md"
            title={cardTitle}
            actions={[{ text: "Close", variant: "secondary", onClick: onClose }]}
        >
            <div
                className="vc-pnygo-gf-stage"
                ref={stageRef}
                style={{
                    "--vc-gf-accent": accent,
                    "--vc-gf-accent-rgb": hexToRgb(accent),
                } as React.CSSProperties}
            >
                <span className="vc-pnygo-gf-hearts" aria-hidden="true">{getHearts()}</span>
                <span className="vc-pnygo-gf-rail vc-pnygo-gf-rail--l" aria-hidden="true" />
                <span className="vc-pnygo-gf-rail vc-pnygo-gf-rail--r" aria-hidden="true" />
                <ProfileCard
                    profile={profile}
                    loading={loading}
                    heart
                    hideCreated
                    aboveFacts={
                        <>
                            {eqStrip}
                            {player}
                        </>
                    }
                    placeholder="No profile found — check the user ID in the plugin settings."
                />
            </div>
        </Modal>
    );
}

/** opens the centered profile card (and counts as a live self-check probe) */
export function openGirlfriend(): boolean {
    hit("girlfriend");
    return openPanel(props => <GirlfriendCard {...props} />);
}

/** opens pnygo's settings — the Girlfriend section (title, id, song, volume) lives there */
export function openGirlfriendSettings(): boolean {
    hit("girlfriend");
    try {
        const plugins = (window as any).Vencord?.Plugins?.plugins;
        const pnygo = plugins?.pnygo;
        if (pnygo) {
            openPluginModal(pnygo);
            return true;
        }
    } catch (e) {
        logger.warn("could not open the plugin settings:", e);
    }
    return false;
}

// ---------------------------------------------------------------------------
// wiring (index.tsx pulls all of this in)
// ---------------------------------------------------------------------------

function HeartHeaderButton() {
    return (
        <TitlebarButton
            id="girlfriend"
            tooltip="Girlfriend — profile card"
            onClick={() => openGirlfriend()}
        >
            <Icons.heart size={18} />
        </TitlebarButton>
    );
}

export function GirlfriendHeaderButton_() {
    return (
        <ErrorBoundary key="vc-gf-titlebar" noop>
            <HeartHeaderButton />
        </ErrorBoundary>
    );
}

/** heart + gear — sits NEXT to the plain heart and opens the settings */
function HeartGearHeaderButton() {
    return (
        <TitlebarButton
            id="girlfriend-settings"
            tooltip="Girlfriend — settings"
            onClick={() => openGirlfriendSettings()}
        >
            <Icons.heartGear size={18} />
        </TitlebarButton>
    );
}

export function GirlfriendSettingsHeaderButton_() {
    return (
        <ErrorBoundary key="vc-gf-settings-titlebar" noop>
            <HeartGearHeaderButton />
        </ErrorBoundary>
    );
}

export const toolboxActions = {
    "Girlfriend card": () => openGirlfriend(),
    "Girlfriend settings": () => openGirlfriendSettings(),
};

export function start(store: Record<string, any>): void {
    storeRef = store;
}

export function stop(): void {
    try { currentAudio?.pause(); } catch { /* ignore */ }
    currentAudio = null;
    try { currentPreview?.pause(); } catch { /* ignore */ }
    currentPreview = null;
}
