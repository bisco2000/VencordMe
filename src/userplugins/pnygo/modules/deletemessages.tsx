/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Forms, MessageStore, Modal, openModal, React, UserStore } from "@webpack/common";

import { Button, CARD, CLS, Icons, rowStyle, Tabs, TitlebarButton } from "./ui";

const TokenStore = findByPropsLazy("getToken");

const API = "https://discord.com/api/v9";
const JOB_KEY = "delmsgs:job";

const SEARCH_PAGE = 25; // search returns 25 hits per page
const MAX_SEARCH_OFFSET = 10000; // same cap as the standalone tool
const DELETE_GAP_MS = 700; // pause between deletes (rate-limit safe)
const INDEX_WAIT_MS = 1500; // wait for search index (HTTP 202)
const MAX_INDEX_WAITS = 20;

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

function getToken(): string {
    try {
        return (TokenStore as any).getToken();
    } catch {
        return "";
    }
}

function myId(): string {
    return UserStore.getCurrentUser()?.id ?? "";
}

function parseRetryAfterMs(body: any, fallback = 2500): number {
    const ra = body?.retry_after;
    const n = typeof ra === "number" ? ra : parseFloat(ra);
    return Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function api(path: string, method: "GET" | "DELETE" = "GET"): Promise<{ status: number; body: any }> {
    try {
        const res = await fetch(API + path, {
            method,
            headers: { Authorization: getToken() }
        });
        let body: any = null;
        try { body = await res.json(); } catch { }
        return { status: res.status, body };
    } catch (e) {
        return { status: 0, body: { error: String(e) } };
    }
}

// ---------------------------------------------------------------------------
// job model
// ---------------------------------------------------------------------------

interface JobItem {
    key: string; // unique key
    kind: "guild" | "dm";
    guildId?: string; // for guild items
    channelId?: string; // for dm items
    label: string;
    found: number;
    deleted: number;
    done?: boolean;
    failed?: boolean;
    note?: string;
}

interface Job {
    running: boolean;
    kind: "servers" | "dms";
    items: JobItem[];
    currentKey?: string;
    startedAt: number;
    finishedAt?: number;
}

let job: Job | null = null;
let jobLoaded = false;
let workerRunning = false;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(l => l());
}

async function saveJob() {
    try { await set(JOB_KEY, job); } catch { }
}

async function loadJob() {
    if (jobLoaded) return;
    jobLoaded = true;
    try {
        const j = await get<Job>(JOB_KEY);
        if (j && Array.isArray(j.items)) job = j;
    } catch { }
}

function startJob(kind: "servers" | "dms", items: JobItem[]) {
    job = {
        running: true,
        kind,
        items,
        startedAt: Date.now()
    };
    saveJob();
    emit();
    worker();
}

function stopJob() {
    if (!job) return;
    job.running = false;
    job.finishedAt = Date.now();
    saveJob();
    emit();
}

function totals() {
    if (!job) return { found: 0, deleted: 0, done: 0, total: 0 };
    const found = job.items.reduce((a, i) => a + (i.found || 0), 0);
    const deleted = job.items.reduce((a, i) => a + (i.deleted || 0), 0);
    const done = job.items.filter(i => i.done || i.failed).length;
    return { found, deleted, done, total: job.items.length };
}

function percent(): number {
    const { found, deleted } = totals();
    if (!job) return 0;
    if (found === 0) return job.running ? 0 : 100;
    const p = (deleted / found) * 100;
    return Math.max(0, Math.min(100, Math.round(p)));
}

// ---------------------------------------------------------------------------
// deletion phases
// ---------------------------------------------------------------------------

interface Hit { cid: string; mid: string; }

/** Guild-wide search for my messages (like the standalone tool). */
async function searchGuildHits(guildId: string, item: JobItem): Promise<Hit[] | null> {
    const me = myId();
    const hits: Hit[] = [];
    let offset = 0;
    let total: number | null = null;
    let indexWaits = 0;

    while (job?.running) {
        const { status, body } = await api(`/guilds/${guildId}/messages/search?author_id=${me}&offset=${offset}`);

        if (status === 202) {
            if (++indexWaits > MAX_INDEX_WAITS) return null;
            await sleep(INDEX_WAIT_MS);
            continue;
        }
        if (status === 429) {
            await sleep(parseRetryAfterMs(body));
            continue;
        }
        if (status === 403 || status === 404 || status === 500) return null;
        if (status !== 200 || !body || typeof body !== "object") return null;

        if (total == null) {
            total = parseInt(body.total_results, 10) || 0;
            item.found = total;
            emit();
        }

        const groups = body.messages ?? [];
        if (!groups.length) break;

        for (const grp of groups) {
            if (!Array.isArray(grp)) continue;
            for (const m of grp) {
                if (String(m?.author?.id) === me && m?.channel_id && m?.id) {
                    hits.push({ cid: String(m.channel_id), mid: String(m.id) });
                }
            }
        }

        offset += SEARCH_PAGE;
        if (total != null && offset >= total) break;
        if (offset > MAX_SEARCH_OFFSET) break;
    }
    return hits;
}

/** Fallback when search is unavailable: sweep text channels page by page. */
async function sweepGuildChannels(guildId: string, item: JobItem): Promise<Hit[]> {
    const me = myId();
    const hits: Hit[] = [];

    const { status: chStatus, body: channels } = await api(`/guilds/${guildId}/channels`);
    if (chStatus !== 200 || !Array.isArray(channels)) return hits;

    const textChannels = channels.filter(c => c.type === 0 || c.type === 5);

    for (const ch of textChannels) {
        if (!job?.running) break;
        const cid = String(ch.id);
        let before: string | undefined;

        for (let page = 0; page < 250; page++) {
            if (!job?.running) break;
            const q = `?limit=100${before ? `&before=${before}` : ""}`;
            const { status, body } = await api(`/channels/${cid}/messages${q}`);
            if (status === 429) { await sleep(parseRetryAfterMs(body)); continue; }
            if (status !== 200 || !Array.isArray(body) || !body.length) break;

            for (const m of body) {
                if (String(m?.author?.id) === me && m?.id) {
                    hits.push({ cid, mid: String(m.id) });
                    item.found++;
                }
            }
            emit();

            const oldest = body.reduce((a, m) => (BigInt(m.id) < BigInt(a.id) ? m : a), body[0]);
            before = String(oldest.id);
            if (before === "0" || before === "") break;
            await sleep(400);
        }
    }
    return hits;
}

/** DM search for my messages in one channel. */
async function searchChannelHits(channelId: string, item: JobItem): Promise<Hit[] | null> {
    const me = myId();
    const hits: Hit[] = [];
    let offset = 0;
    let total: number | null = null;
    let indexWaits = 0;

    while (job?.running) {
        const { status, body } = await api(`/channels/${channelId}/messages/search?author_id=${me}&offset=${offset}`);

        if (status === 202) {
            if (++indexWaits > MAX_INDEX_WAITS) return null;
            await sleep(INDEX_WAIT_MS);
            continue;
        }
        if (status === 429) {
            await sleep(parseRetryAfterMs(body));
            continue;
        }
        if (status === 403 || status === 404) return null;
        if (status !== 200 || !body || typeof body !== "object") return null;

        if (total == null) {
            total = parseInt(body.total_results, 10) || 0;
            item.found = total;
            emit();
        }

        const groups = body.messages ?? [];
        if (!groups.length) break;

        for (const grp of groups) {
            if (!Array.isArray(grp)) continue;
            for (const m of grp) {
                if (String(m?.author?.id) === me && m?.id) {
                    hits.push({ cid: String(m.channel_id ?? channelId), mid: String(m.id) });
                }
            }
        }

        offset += SEARCH_PAGE;
        if (total != null && offset >= total) break;
        if (offset > MAX_SEARCH_OFFSET) break;
    }
    return hits;
}

async function deleteHits(item: JobItem, hits: Hit[]) {
    for (const h of hits) {
        if (!job?.running) break;

        let { status, body } = await api(`/channels/${h.cid}/messages/${h.mid}`, "DELETE");
        if (status === 429) {
            await sleep(parseRetryAfterMs(body));
            ({ status, body } = await api(`/channels/${h.cid}/messages/${h.mid}`, "DELETE"));
        }
        if (status === 200 || status === 204) {
            item.deleted++;
            emit();
        }
        await sleep(DELETE_GAP_MS);
    }
}

async function processItem(item: JobItem) {
    if (item.kind === "guild") {
        const hits = await searchGuildHits(item.guildId!, item);

        if (hits == null) {
            // search unavailable -> channel sweep fallback
            item.note = "search unavailable - sweeping channels";
            emit();
            const swept = await sweepGuildChannels(item.guildId!, item);
            await deleteHits(item, swept);
        } else {
            await deleteHits(item, hits);
        }
    } else {
        const hits = await searchChannelHits(item.channelId!, item);
        if (hits == null) {
            item.failed = true;
            item.note = "search unavailable";
            emit();
            return;
        }
        await deleteHits(item, hits);
    }
}

async function worker() {
    if (workerRunning) return;
    workerRunning = true;
    try {
        while (job?.running) {
            if (!storeRef.enableDeleteMessages) {
                // feature turned off mid-run: pause the job but keep it saved
                job.running = false;
                await saveJob();
                emit();
                break;
            }
            const item = job.items.find(i => !i.done && !i.failed);
            if (!item) {
                job.running = false;
                job.finishedAt = Date.now();
                await saveJob();
                emit();
                const { deleted } = totals();
                showNotification({
                    title: "Delete My Messages - finished",
                    body: `${deleted} messages deleted.`,
                    noPersist: true
                });
                break;
            }
            job.currentKey = item.key;
            emit();
            try {
                await processItem(item);
                item.done = true;
            } catch (e) {
                item.failed = true;
                item.note = String(e).slice(0, 120);
            }
            await saveJob();
            emit();
        }
    } finally {
        workerRunning = false;
    }
}

// ---------------------------------------------------------------------------
// data loading (servers / dms)
// ---------------------------------------------------------------------------

interface GuildRow { id: string; name: string; }
interface DmRow { channelId: string; userId: string; name: string; type: number; }

async function fetchGuilds(): Promise<GuildRow[]> {
    const { status, body } = await api("/users/@me/guilds");
    if (status !== 200 || !Array.isArray(body)) return [];
    return body.map(g => ({ id: String(g.id), name: String(g.name ?? g.id) }));
}

async function fetchDms(): Promise<DmRow[]> {
    const { status, body } = await api("/users/@me/channels");
    if (status !== 200 || !Array.isArray(body)) return [];

    const rows: DmRow[] = [];
    for (const ch of body) {
        if (ch.type !== 1 && ch.type !== 3) continue;
        const recips = Array.isArray(ch.recipients) ? ch.recipients : [];
        const names = recips.map((r: any) => {
            const un = r.username ? `@${r.username}` : String(r.id ?? "?");
            return r.global_name && r.global_name !== r.username ? `${r.global_name} (${un})` : un;
        });
        const label = ch.type === 3
            ? (ch.name ? `Group: ${ch.name}` : `Group: ${names.join(", ") || "group DM"}`)
            : (names[0] ?? `DM ${ch.id}`);
        rows.push({
            channelId: String(ch.id),
            userId: String(recips[0]?.id ?? ch.id),
            name: label,
            type: ch.type
        });
    }
    return rows;
}

/** count MY messages in one dm channel via search total_results */
async function countDmMessages(channelId: string): Promise<number | null> {
    const me = myId();
    for (let i = 0; i < 8; i++) {
        const { status, body } = await api(`/channels/${channelId}/messages/search?author_id=${me}&offset=0`);
        if (status === 200 && body && typeof body === "object" && "total_results" in body) {
            return parseInt(body.total_results, 10) || 0;
        }
        if (status === 202) { await sleep(INDEX_WAIT_MS); continue; }
        if (status === 429) { await sleep(parseRetryAfterMs(body)); continue; }
        break;
    }
    return null;
}

// ---------------------------------------------------------------------------
// purge MessageLogger remnants (red deleted messages)
// ---------------------------------------------------------------------------

function purgeLoggedDeleted(): number {
    let purged = 0;
    const channelIds: string[] = (ChannelStore as any).getChannelIds?.() ?? [];
    for (const cid of channelIds) {
        const msgs = MessageStore.getMessages(cid);
        if (!msgs) continue;
        (msgs as any).forEach((m: any) => {
            if (m?.deleted) {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_DELETE",
                    channelId: cid,
                    id: m.id,
                    mlDeleted: true
                });
                purged++;
            }
        });
    }
    return purged;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// ---- UI ---------------------------------------------------------------
// The shared look (cards, buttons, rows) lives in ./ui so every pnygo panel
// is styled from one place. Only the destruction-specific bits stay here.

function ProgressBar() {
    const p = percent();
    const { found, deleted } = totals();
    return (
        <div>
            <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8
            }}>
                <div style={{
                    flex: 1,
                    height: 16,
                    background: "var(--background-tertiary)",
                    borderRadius: 8,
                    overflow: "hidden",
                    border: "1px solid var(--background-modifier-accent)"
                }}>
                    <div style={{
                        width: `${p}%`,
                        height: "100%",
                        background: "linear-gradient(90deg, var(--red-400), var(--red-600))",
                        boxShadow: "0 0 8px rgba(240,70,70,0.45)",
                        transition: "width .4s ease"
                    }} />
                </div>
                <span
                    style={{
                        background: "var(--red-400)",
                        color: "#fff",
                        fontWeight: 800,
                        fontSize: 11,
                        borderRadius: 10,
                        padding: "1px 8px",
                        minWidth: 38,
                        textAlign: "center"
                    }}
                >
                    {p}%
                </span>
            </div>
            <Forms.FormText style={{ marginTop: 4, fontSize: 12, opacity: .85 }}>
                <b>{deleted}</b> / <b>{found}</b> deleted
            </Forms.FormText>
        </div>
    );
}

function ProgressView() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
        const l = () => force(t => t + 1);
        listeners.add(l);
        const ivl = setInterval(l, 1000);
        return () => { listeners.delete(l); clearInterval(ivl); };
    }, []);

    const t = totals();
    const current = job?.items.find(i => i.key === job?.currentKey);

    return (
        <div style={CARD}>
            <Forms.FormTitle tag="h5" style={{ marginTop: 0, marginBottom: 8 }}>
                Deletion in progress — {t.done}/{t.total}
            </Forms.FormTitle>
            <ProgressBar />
            {current && (
                <Forms.FormText style={{ marginTop: 4, fontSize: 12, opacity: .85 }}>
                    <b>{current.label}</b> — {current.deleted}/{current.found}
                    {current.note ? ` (${current.note})` : ""}
                </Forms.FormText>
            )}

            <div style={{ maxHeight: 200, overflowY: "auto", margin: "8px 0", background: "var(--background-tertiary)", border: "1px solid var(--background-modifier-accent)", borderRadius: 8, padding: 6 }}>
                {job!.items.map(i => (
                    <div key={i.key} style={{ fontSize: 12, padding: "2px 0", display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <span style={{
                            color: i.failed ? "var(--red-360)" : i.done ? "var(--green-360)" : "var(--text-default)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                        }}>
                            {i.failed ? "✖" : i.done ? "✔" : "…"} {i.label}{i.note ? ` (${i.note})` : ""}
                        </span>
                        <span style={{ opacity: .8, whiteSpace: "nowrap" }}>
                            {i.deleted}/{i.found || 0}
                        </span>
                    </div>
                ))}
            </div>

            <Button size="sm" onClick={stopJob}>■ Stop</Button>
        </div>
    );
}

function ServersTab() {
    const [guilds, setGuilds] = React.useState<GuildRow[] | null>(null);
    const [selected, setSelected] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        fetchGuilds().then(setGuilds);
    }, []);

    const toggle = (id: string) => {
        setSelected(s => {
            const n = new Set(s);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };

    const start = () => {
        const items: JobItem[] = guilds!
            .filter(g => selected.has(g.id))
            .map(g => ({
                key: `guild:${g.id}`,
                kind: "guild" as const,
                guildId: g.id,
                label: g.name,
                found: 0,
                deleted: 0
            }));
        if (items.length) startJob("servers", items);
    };

    if (!guilds) return <Forms.FormText>Loading servers…</Forms.FormText>;
    if (!guilds.length) return <Forms.FormText>No servers found.</Forms.FormText>;

    return (
        <div>
            <div className={CLS.btnRow} style={{ marginBottom: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(guilds.map(g => g.id)))}>All</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>None</Button>
                <span style={{ flex: 1 }} />
                <Button
                    size="sm"
                    variant="danger"
                    disabled={!selected.size}
                    onClick={start}
                >
                    🗑 Delete ({selected.size})
                </Button>
            </div>
            <div style={{ maxHeight: 330, overflowY: "auto", ...CARD, padding: 6 }}>
                {guilds.map(g => (
                    <label key={g.id} style={{ ...rowStyle, cursor: "pointer" }}>
                        <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggle(g.id)} />
                        <span style={{ fontSize: 13 }}>{g.name}</span>
                    </label>
                ))}
            </div>
        </div>
    );
}

function DmsTab() {
    const [dms, setDms] = React.useState<DmRow[] | null>(null);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [counting, setCounting] = React.useState(false);
    const [countProgress, setCountProgress] = React.useState(0);

    React.useEffect(() => {
        fetchDms().then(setDms);
    }, []);

    // prefill deleted counts from a previous/active job
    React.useEffect(() => {
        loadJob().then(() => {
            if (!job) return;
            const map: Record<string, number> = {};
            for (const i of job.items) {
                if (i.kind === "dm" && i.deleted > 0) map[i.key] = i.deleted;
            }
            setCounts(c => ({ ...map, ...c }));
        });
    }, []);

    const countAll = async () => {
        if (!dms) return;
        setCounting(true);
        const map: Record<string, number> = {};
        for (let i = 0; i < dms.length; i++) {
            setCountProgress(i + 1);
            const c = await countDmMessages(dms[i].channelId);
            if (c != null) map[dms[i].channelId] = c;
        }
        setCounts(c => ({ ...map, ...c }));
        setCounting(false);
    };

    const toggle = (id: string) => {
        setSelected(s => {
            const n = new Set(s);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };

    const start = (rows?: DmRow[]) => {
        const list = rows ?? dms!.filter(d => selected.has(d.channelId));
        const items: JobItem[] = list.map(d => ({
            key: `dm:${d.channelId}`,
            kind: "dm" as const,
            channelId: d.channelId,
            label: d.name,
            found: 0,
            deleted: 0
        }));
        if (items.length) startJob("dms", items);
    };

    if (!dms) return <Forms.FormText>Loading DMs…</Forms.FormText>;
    if (!dms.length) return <Forms.FormText>No DM conversations found.</Forms.FormText>;

    return (
        <div>
            <div className={CLS.btnRow} style={{ marginBottom: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(dms.map(d => d.channelId)))}>All</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>None</Button>
                <Button size="sm" variant="ghost" onClick={countAll} disabled={counting}>
                    {counting ? `⏳ ${countProgress}/${dms.length}` : "⏱ Count"}
                </Button>
                <span style={{ flex: 1 }} />
                <Button
                    size="sm"
                    variant="danger"
                    disabled={!selected.size}
                    onClick={() => start()}
                >
                    🗑 Delete ({selected.size})
                </Button>
            </div>
            <div style={{ maxHeight: 330, overflowY: "auto", ...CARD, padding: 6 }}>
                {dms.map(d => (
                    <div key={d.channelId} style={rowStyle}>
                        <input
                            type="checkbox"
                            checked={selected.has(d.channelId)}
                            onChange={() => toggle(d.channelId)}
                        />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                            {d.name}
                            <span
                                style={{
                                    marginLeft: 8,
                                    fontSize: 11,
                                    color: "var(--white-500)",
                                    background: "var(--red-400)",
                                    borderRadius: 8,
                                    padding: "0 6px",
                                    fontWeight: 800
                                }}
                            >
                                {counts[d.channelId] != null ? counts[d.channelId] : ""}
                            </span>
                        </span>
                        <Button
                            size="sm"
                            variant="danger"
                            title={`Delete ALL my messages with ${d.name}`}
                            onClick={() => start([d])}
                        >
                            <Icons.trash size={14} />
                        </Button>
                    </div>
                ))}
            </div>
            <Forms.FormText style={{ marginTop: 6, opacity: .7, fontSize: 12 }}>
                The trash button deletes ALL your messages with that person only. Count badge = my messages with them.
            </Forms.FormText>
        </div>
    );
}

function CleanupTab() {
    const [result, setResult] = React.useState("");

    return (
        <div style={CARD}>
            <Forms.FormTitle tag="h5" style={{ marginTop: 0, marginBottom: 6 }}>
                🧹 Purge logged deleted messages
            </Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 10, fontSize: 12, opacity: .85 }}>
                Removes the red "deleted" message remnants kept by the MessageLogger plugin from the UI.
            </Forms.FormText>
            <Button
                variant="danger"
                onClick={() => {
                    const n = purgeLoggedDeleted();
                    setResult(n ? `Purged ${n} logged deleted messages.` : "No logged deleted messages found.");
                }}
            >
                🧹 Purge red
            </Button>
            {result && <Forms.FormText style={{ marginTop: 8, fontSize: 12 }}>{result}</Forms.FormText>}
        </div>
    );
}

function DeletePanel(props: any) {
    const [, force] = React.useState(0);
    const [tab, setTab] = React.useState<"servers" | "dms" | "cleanup">("servers");

    React.useEffect(() => {
        loadJob().then(() => {
            force(t => t + 1);
            if (job?.running) worker(); // resume persisted job (panel close / restart)
        });
        const l = () => force(t => t + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);

    const tabDefs = [
        { id: "servers" as const, label: "🏠 Servers" },
        { id: "dms" as const, label: "💬 DMs" },
        { id: "cleanup" as const, label: "🧹 Cleanup" },
    ];

    return (
        <Modal {...props} size="lg" title="Delete My Messages">
            <div style={{ padding: "8px 16px 16px" }}>
                <Tabs tabs={tabDefs} value={tab} onChange={setTab} />

                {job?.running && <div style={{ marginBottom: 14 }}><ProgressView /></div>}

                {tab === "servers" && <ServersTab />}
                {tab === "dms" && <DmsTab />}
                {tab === "cleanup" && <CleanupTab />}

                <Forms.FormText style={{ marginTop: 10, opacity: .7, fontSize: 11 }}>
                    Deletes YOUR OWN messages only. Runs in the background - closing this panel (or restarting Discord) does not stop it.
                </Forms.FormText>
            </div>
        </Modal>
    );
}

function TrashHeaderButton() {
    return (
        <TitlebarButton
            id="delmsg"
            className="vc-pnygo-tb--trash"
            tooltip="Delete My Messages"
            onClick={() => openModal(props => <DeletePanel {...props} />)}
        >
            <Icons.trash size={18} />
        </TitlebarButton>
    );
}

// ---------------------------------------------------------------------------
// module exports (wired together by pnygo's index.tsx)
// ---------------------------------------------------------------------------

// set from the merged plugin's start()
let storeRef: Record<string, any> = {};

export function start(store: Record<string, any>) {
    storeRef = store;
    loadJob().then(() => {
        if (storeRef.enableDeleteMessages && job?.running) worker(); // resume after restart
    });
}

export function stop() {
    stopJob();
}

/** Resume a paused deletion job when the feature is re-enabled. */
export function resume() {
    if (storeRef.enableDeleteMessages && job?.running && !workerRunning) worker();
}

export function TrashHeaderButton_() {
    return (
        <ErrorBoundary key="vc-delmsg-titlebar" noop>
            <TrashHeaderButton />
        </ErrorBoundary>
    );
}

