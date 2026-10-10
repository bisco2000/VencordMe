/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * pnygo - shared UI kit
 *
 * Every pnygo surface (titlebar buttons, panels, modals) is built from the
 * pieces in this file, so the whole plugin looks like ONE tool instead of a
 * pile of separately styled buttons.
 *
 * Two layers:
 *   1. class based components (Button / Card / Tabs / Switch / Input ...) that
 *      carry the shared CSS from ui.css — hover states, focus rings, spacing.
 *   2. the legacy inline style tokens (CARD / btnStyle / rowStyle) kept so the
 *      existing modules keep working unchanged.
 *
 * Everything degrades gracefully: if Discord's titlebar button component is
 * gone after an update, TitlebarButton() renders nothing instead of throwing.
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { findComponentByCodeLazy } from "@webpack";
import { openModal, React } from "@webpack/common";

const logger = new Logger("pnygo/UI");

/**
 * Discord's own top-titlebar button. Resolved lazily, so a Discord update that
 * moves it only disables the buttons instead of breaking the plugin.
 */
export const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** true when the titlebar button component could be resolved on this build. */
export function headerBarAvailable(): boolean {
    try {
        return typeof HeaderBarIcon === "function";
    } catch {
        return false;
    }
}

/** every class name the kit owns (kept in one place for easy grepping). */
export const CLS = {
    tb: "vc-pnygo-tb",
    tbIcon: "vc-pnygo-tb-icon",
    panelBody: "vc-pnygo-panel-body",
    card: "vc-pnygo-card",
    cardHead: "vc-pnygo-card-head",
    cardTitle: "vc-pnygo-card-title",
    cardSub: "vc-pnygo-card-sub",
    btn: "vc-pnygo-btn",
    btnRow: "vc-pnygo-btn-row",
    tabs: "vc-pnygo-tabs",
    tab: "vc-pnygo-tab",
    row: "vc-pnygo-row",
    scroll: "vc-pnygo-scroll",
    field: "vc-pnygo-field",
    fieldLabel: "vc-pnygo-field-label",
    hint: "vc-pnygo-hint",
    muted: "vc-pnygo-muted",
    input: "vc-pnygo-input",
    textarea: "vc-pnygo-textarea",
    select: "vc-pnygo-select",
    grid2: "vc-pnygo-grid-2",
    switch: "vc-pnygo-switch",
    switchTrack: "vc-pnygo-switch-track",
    switchKnob: "vc-pnygo-switch-knob",
    switchLabel: "vc-pnygo-switch-label",
    chip: "vc-pnygo-chip",
    divider: "vc-pnygo-divider",
    empty: "vc-pnygo-empty",
} as const;

// ---------------------------------------------------------------------------
// legacy inline tokens (still used by the older modules)
// ---------------------------------------------------------------------------

export const CARD: React.CSSProperties = {
    background: "var(--background-secondary)",
    border: "1px solid var(--background-modifier-accent)",
    borderRadius: 10,
    padding: 10,
};

export const btnStyle = (bg: string, color = "#fff"): React.CSSProperties => ({
    background: bg,
    color,
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    padding: "5px 10px",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 12,
    transition: "filter .15s ease",
    filter: "brightness(1)",
});

export const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "5px 8px",
    borderRadius: 6,
    borderBottom: "1px dashed var(--background-modifier-accent)",
};

export const PANEL_BODY: React.CSSProperties = { padding: "8px 16px 16px" };
export const MUTED: React.CSSProperties = { fontSize: 11, opacity: .7 };

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

export interface TitlebarButtonProps {
    /** short id, also used as a class suffix for per-button tweaks */
    id: string;
    tooltip: string;
    onClick: () => void;
    active?: boolean;
    size?: number;
    /** extra class, e.g. vc-pnygo-tb--trash */
    className?: string;
    children: React.ReactNode;
}

/**
 * Unified titlebar button: same size, same radius, same hover behaviour for
 * every pnygo feature. Renders nothing when Discord moved the host component.
 */
export function TitlebarButton({ id, tooltip, onClick, active = false, size = 18, className = "", children }: TitlebarButtonProps) {
    if (!headerBarAvailable()) return null;

    const cls = [CLS.tb, `${CLS.tb}--${id}`, active ? `${CLS.tb}--active` : "", className]
        .filter(Boolean).join(" ");

    return (
        <HeaderBarIcon
            className={cls}
            onClick={onClick}
            tooltip={tooltip}
            selected={active}
            aria-label={tooltip}
            icon={() => (
                <span className={CLS.tbIcon} style={{ width: size, height: size }}>
                    {children}
                </span>
            )}
        />
    );
}

export type ButtonVariant = "primary" | "danger" | "success" | "neutral" | "ghost" | "link";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: "sm" | "md" | "icon";
}

/** The one button every pnygo panel uses. */
export function Button({ variant = "neutral", size = "md", className = "", type = "button", ...rest }: ButtonProps) {
    return (
        <button
            type={type}
            className={[CLS.btn, `${CLS.btn}--${variant}`, `${CLS.btn}--${size}`, className].filter(Boolean).join(" ")}
            {...rest}
        />
    );
}

export interface CardProps {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    right?: React.ReactNode;
    variant?: "default" | "flat" | "danger";
    style?: React.CSSProperties;
    className?: string;
    children?: React.ReactNode;
}

export function Card({ title, subtitle, right, variant = "default", style, className = "", children }: CardProps) {
    const cls = [CLS.card, variant !== "default" ? `${CLS.card}--${variant}` : "", className].filter(Boolean).join(" ");
    return (
        <div className={cls} style={style}>
            {(title || right) && (
                <div className={CLS.cardHead}>
                    <div>
                        {title ? <h5 className={CLS.cardTitle}>{title}</h5> : null}
                        {subtitle ? <p className={CLS.cardSub}>{subtitle}</p> : null}
                    </div>
                    {right ?? null}
                </div>
            )}
            {children}
        </div>
    );
}

export interface TabDef<T extends string> {
    id: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<TabDef<T>>; value: T; onChange: (id: T) => void; }) {
    return (
        <div className={CLS.tabs} role="tablist">
            {tabs.map(t => (
                <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === value}
                    className={`${CLS.tab}${t.id === value ? ` ${CLS.tab}--active` : ""}`}
                    onClick={() => onChange(t.id)}
                >
                    {t.icon}
                    {t.label}
                </button>
            ))}
        </div>
    );
}

export function Field({ label, hint, children, style }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; }) {
    return (
        <div className={CLS.field} style={style}>
            <span className={CLS.fieldLabel}>{label}</span>
            {children}
            {hint ? <span className={CLS.hint}>{hint}</span> : null}
        </div>
    );
}

export function Input({ className = "", ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input className={`${CLS.input} ${className}`.trim()} {...rest} />;
}

export function TextArea({ className = "", ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea className={`${CLS.textarea} ${className}`.trim()} {...rest} />;
}

export function Select({ className = "", children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return <select className={`${CLS.select} ${className}`.trim()} {...rest}>{children}</select>;
}

export function Switch({ checked, onChange, label, hint, disabled = false }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: React.ReactNode;
    hint?: React.ReactNode;
    disabled?: boolean;
}) {
    return (
        <label className={CLS.switch} style={{ opacity: disabled ? .5 : 1 }}>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={e => onChange(e.currentTarget.checked)}
            />
            <span className={CLS.switchTrack}><span className={CLS.switchKnob} /></span>
            <span className={CLS.switchLabel}>
                {label}
                {hint ? <span className={CLS.hint}>{hint}</span> : null}
            </span>
        </label>
    );
}

export function Chip({ tone = "default", children }: { tone?: "default" | "ok" | "warn" | "bad"; children: React.ReactNode; }) {
    return <span className={`${CLS.chip}${tone !== "default" ? ` ${CLS.chip}--${tone}` : ""}`}>{children}</span>;
}

export function Divider() {
    return <div className={CLS.divider} />;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: React.CSSProperties; }) {
    return <div className={CLS.muted} style={style}>{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode; }) {
    return <div className={CLS.empty}>{children}</div>;
}

/**
 * Opens a panel in a modal, wrapped in an ErrorBoundary so a broken panel can
 * never take down the client. Returns false when the modal API is unavailable.
 */
export function openPanel(render: (props: any) => React.ReactNode): boolean {
    try {
        if (typeof openModal !== "function") {
            logger.warn("the Modal API is unavailable on this build — panel not opened");
            return false;
        }
        openModal(props => <ErrorBoundary noop>{render(props)}</ErrorBoundary>);
        return true;
    } catch (e) {
        logger.error("could not open panel:", e);
        return false;
    }
}

// ---------------------------------------------------------------------------
// formatters (shared by every panel, so times/durations always look the same)
// ---------------------------------------------------------------------------

/** "2:35 PM" for a timestamp. */
export function formatClock(ts: number): string {
    try {
        return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
        return "";
    }
}

/** "0:35", "12:05" or "1:02:03" for a duration given in seconds. */
export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Timestamp -> value for an <input type="datetime-local"> (local time). */
export function toLocalInputValue(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value of an <input type="datetime-local"> -> timestamp (null when invalid). */
export function fromLocalInputValue(value: string): number | null {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// icons (one consistent 24x24 viewbox, currentColor, so they inherit the CSS)
// ---------------------------------------------------------------------------

/**
 * Raw path data. The React icons below use it, and so does the plain-DOM call
 * row in modules/missedcalls.tsx (which is injected outside of React).
 */
export const ICON_PATHS = {
    chat: "M20 2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4l4 4 4-4h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-9 11H6v-2h5v2Zm7-4H6V7h12v2Z",
    phone: "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.2 1l-2.3 2.2Z",
    phoneMissed: "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.2 1l-2.3 2.2ZM17 3.4 19.6 6l2.6-2.6L23.6 4.8 21 7.4l2.6 2.6-1.4 1.4L19.6 8.8 17 11.4l-1.4-1.4L18.2 7.4 15.6 4.8 17 3.4Z",
    key: "M22 7.5a5.5 5.5 0 0 1-8.03 4.84L8.4 18H5v3H2v-3l6.09-6.09a5.5 5.5 0 1 1 4.66-1.23L14 10.7l1.3-1.3 1.41 1.41 1.3-1.3 1.05 1.05A5.5 5.5 0 0 1 22 7.5Zm-4 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z",
    trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    broom: "M14.5 2h-3c-.83 0-1.5.67-1.5 1.5V10H8c-1.1 0-2 .9-2 2v2.18A3 3 0 0 0 3 17v3c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-3a3 3 0 0 0-3-2.82V12c0-1.1-.9-2-2-2h-1.5V3.5C14.5 2.67 15.33 2 14.5 2zM13 3.5h1.5V10H13V3.5zM8 12h8v2.18c-1.16.41-2 1.51-2 2.82v.5h-4v-.5c0-1.31-.84-2.41-2-2.82V12zm-3 5c0-1.1.9-2 2-2s2 .9 2 2v3H5v-3zm14 3h-4v-3c0-1.1.9-2 2-2s2 .9 2 2v3z",
    shield: "M12 2 3 7v6c0 5 3.8 8.4 9 9 5.2-.6 9-4 9-9V7l-9-5Zm-1.2 13.2-3-3 1.4-1.4 1.6 1.6 3.8-3.8 1.4 1.4-5.2 5.2Z",
    clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 11h-4v-2h2V6h2v7Z",
    pencil: "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z",
    close: "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z",
    send: "M2.5 21 23 12 2.5 3v7l14 2-14 2v7Z",
    image: "M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM8 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-4 11 5-6 3.5 4 2.5-2.5L20 19H4Z",
    copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z",
    refresh: "M12 5V2L7 7l5 5V9a5 5 0 1 1-5 5H5a7 7 0 1 0 7-9Z",
    heart: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
    gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    user: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z",
    v: "M4 4h4l4 9.5L16 4h4l-6 14h-4z",
} as const;

/** Builds an <svg> element for the plain-DOM surfaces (no React involved). */
export function svgIcon(path: string, size = 18): SVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const node = document.createElementNS(NS, "path");
    node.setAttribute("d", path);
    svg.appendChild(node);
    return svg;
}

interface IconProps { size?: number; className?: string; }

export function ChatIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.chat} />
        </svg>
    );
}

export function PhoneMissedIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.phoneMissed} />
        </svg>
    );
}

export function PhoneIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.phone} />
        </svg>
    );
}

export function KeyIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.key} />
        </svg>
    );
}

export function TrashIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.trash} />
        </svg>
    );
}

export function BroomIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.broom} />
        </svg>
    );
}

export function ShieldIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.shield} />
        </svg>
    );
}

export function ClockIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.clock} />
        </svg>
    );
}

export function PencilIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.pencil} />
        </svg>
    );
}

export function CloseIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.close} />
        </svg>
    );
}

export function SendIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.send} />
        </svg>
    );
}

export function ImageIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.image} />
        </svg>
    );
}

export function CopyIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.copy} />
        </svg>
    );
}

export function RefreshIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.refresh} />
        </svg>
    );
}

export function HeartIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.heart} />
        </svg>
    );
}

/**
 * heart + gear — the Girlfriend SETTINGS button in the titlebar.
 * The heart is only outlined so the filled gear stays readable where they
 * cross each other in the bottom-right corner.
 */
export function HeartGearIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path
                d={ICON_PATHS.heart}
                transform="translate(0.4 0.6) scale(0.8)"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinejoin="round"
            />
            <path d={ICON_PATHS.gear} transform="translate(11.5 11.5) scale(0.5)" />
        </svg>
    );
}

export function UserIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.user} />
        </svg>
    );
}

export function VIcon({ size = 18, className }: IconProps) {
    return (
        <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d={ICON_PATHS.v} />
        </svg>
    );
}

export const Icons = {
    chat: ChatIcon,
    phone: PhoneIcon,
    phoneMissed: PhoneMissedIcon,
    key: KeyIcon,
    trash: TrashIcon,
    broom: BroomIcon,
    shield: ShieldIcon,
    clock: ClockIcon,
    pencil: PencilIcon,
    close: CloseIcon,
    send: SendIcon,
    image: ImageIcon,
    copy: CopyIcon,
    refresh: RefreshIcon,
    heart: HeartIcon,
    heartGear: HeartGearIcon,
    user: UserIcon,
    v: VIcon,
} as const;
