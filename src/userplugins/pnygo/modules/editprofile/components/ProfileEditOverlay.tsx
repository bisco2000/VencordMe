/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import { Button, Clickable, Forms, openModal, React, Text, TextInput } from "@webpack/common";

import { badgeImageUrl, getOfficialBadge } from "../badges";
import { ProfileOverrides, resetAll, resetField, setOverrides, useOverrides } from "../overrides";
import { BadgePickerModal } from "./BadgePicker";

function PencilIcon() {
    return (
        <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
            <path d="M19.29 3.71a1 1 0 0 0-1.42 0l-1.16 1.16 2.42 2.42 1.16-1.16a1 1 0 0 0 0-1.42l-1-1zM3 17.25V21h3.75L17.81 9.94l-2.42-2.42L3 17.25z" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
            <path d="M18.4 7.4 17 6l-5 5-5-5-1.4 1.4 5 5-5 5L7 18.8l5-5 5 5 1.4-1.4-5-5 5-5z" />
        </svg>
    );
}

/** One inline-editable row with Save / Cancel / Reset controls. */
function EditRow({ label, value, placeholder, onCommit, onReset, multiline }: {
    label: string;
    value: string;
    placeholder: string;
    onCommit: (next: string) => void;
    onReset: () => void;
    multiline?: boolean;
}) {
    const [draft, setDraft] = React.useState(value);
    React.useEffect(() => setDraft(value), [value]);
    const dirty = draft !== value;

    return (
        <div className="vc-editprofile-row">
            <Forms.FormTitle className="vc-editprofile-row-title">{label}</Forms.FormTitle>
            {multiline ? (
                <textarea
                    className="vc-editprofile-input vc-editprofile-textarea"
                    value={draft}
                    placeholder={placeholder}
                    rows={3}
                    onChange={e => setDraft(e.currentTarget.value)}
                />
            ) : (
                <TextInput
                    value={draft}
                    placeholder={placeholder}
                    onChange={v => setDraft(v)}
                />
            )}
            <div className="vc-editprofile-row-actions">
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.BRAND}
                    disabled={!dirty}
                    onClick={() => onCommit(draft)}
                >
                    Save
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.PRIMARY}
                    look={Button.Looks.LINK}
                    disabled={!dirty}
                    onClick={() => setDraft(value)}
                >
                    Cancel
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.PRIMARY}
                    look={Button.Looks.LINK}
                    disabled={value === ""}
                    onClick={onReset}
                >
                    Reset
                </Button>
            </div>
        </div>
    );
}

/** Small strip under the header summarising every locally faked value. */
function OverrideSummary({ userId, overrides }: { userId: string; overrides: ProfileOverrides; }) {
    if (
        overrides.displayName === "" && overrides.username === "" && overrides.memberSince === "" &&
        overrides.badges.length === 0 && !overrides.hideRealBadges
    ) return null;

    const bits: string[] = [];
    if (overrides.displayName) bits.push(`name: ${overrides.displayName}`);
    if (overrides.username) bits.push(`user: ${overrides.username}`);
    if (overrides.memberSince) bits.push(`since: ${overrides.memberSince}`);
    if (overrides.badges.length || overrides.hideRealBadges) bits.push(`badges: ${overrides.badges.length}${overrides.hideRealBadges ? " (real hidden)" : ""}`);

    return (
        <div className="vc-editprofile-summary">
            <Text variant="text-xxs/medium" className="vc-editprofile-summary-text">
                local only — {bits.join(" · ")}
            </Text>
            <Clickable className="vc-editprofile-summary-reset" onClick={() => resetAll(userId)}>
                <Text variant="text-xxs/medium">reset all</Text>
            </Clickable>
        </div>
    );
}

function BadgeChipList({ overrides }: { overrides: ProfileOverrides; }) {
    return (
        <div className="vc-editprofile-chips">
            {overrides.badges.map(b => {
                const def = getOfficialBadge(b.officialId);
                const src = b.kind === "custom" ? b.custom?.imageUrl : badgeImageUrl(def);
                if (!src) return null;
                const tip = b.kind === "custom" ? b.custom?.tooltip || "Custom badge" : def?.description ?? b.uid;
                return <img key={b.uid} src={src} alt={tip} title={tip} width={18} height={18} className="vc-editprofile-chip" />;
            })}
        </div>
    );
}

/**
 * The floating editor card, opened by the pencil button.
 */
export function EditorCard({ userId, overrides, onClose }: { userId: string; overrides: ProfileOverrides; onClose: () => void; }) {
    const openBadges = () => openModal((props: RenderModalProps) => (
        <BadgePickerModal
            modalProps={props}
            userId={userId}
        />
    ));

    return (
        <div className="vc-editprofile-card">
            <div className="vc-editprofile-card-head">
                <Text variant="text-sm/semibold">Edit Profile (local only)</Text>
                <Clickable className="vc-editprofile-close" onClick={onClose} aria-label="Close editor">
                    <CloseIcon />
                </Clickable>
            </div>

            <EditRow
                label="Display name (display only)"
                value={overrides.displayName}
                placeholder="Real display name"
                onCommit={v => setOverrides(userId, { displayName: v })}
                onReset={() => resetField(userId, "displayName")}
            />

            <EditRow
                label="Username (display only)"
                value={overrides.username}
                placeholder="Real username"
                onCommit={v => setOverrides(userId, { username: v })}
                onReset={() => resetField(userId, "username")}
            />

            {/* creation date: clicking the date input opens the date picker directly */}
            <div className="vc-editprofile-row">
                <Forms.FormTitle className="vc-editprofile-row-title">Member since (display only)</Forms.FormTitle>
                <div className="vc-editprofile-date-row">
                    <input
                        type="date"
                        className="vc-editprofile-input vc-editprofile-date"
                        value={overrides.memberSince}
                        onChange={e => setOverrides(userId, { memberSince: e.currentTarget.value })}
                    />
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        look={Button.Looks.LINK}
                        disabled={overrides.memberSince === ""}
                        onClick={() => resetField(userId, "memberSince")}
                    >
                        Reset
                    </Button>
                </div>
            </div>

            {/* badges: clicking the badge row opens the picker directly */}
            <div className="vc-editprofile-row">
                <Forms.FormTitle className="vc-editprofile-row-title">Badges</Forms.FormTitle>
                <Clickable className="vc-editprofile-badge-row" onClick={openBadges} role="button" aria-label="Edit badges">
                    {overrides.badges.length
                        ? <BadgeChipList overrides={overrides} />
                        : <Text variant="text-xs/normal">click to open the badge picker</Text>}
                </Clickable>
                <div className="vc-editprofile-row-actions">
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={openBadges}>
                        Badge picker
                    </Button>
                </div>
            </div>

            {(overrides.avatarUrl || overrides.bannerUrl) && (
                <div className="vc-editpreview-row">
                    {overrides.avatarUrl && <img src={overrides.avatarUrl} alt="" width={40} height={40} className="vc-editprofile-avatar-preview" />}
                    {overrides.bannerUrl && <img src={overrides.bannerUrl} alt="" width={80} height={24} className="vc-editprofile-banner-preview" />}
                </div>
            )}
        </div>
    );
}

/**
 * Rendered inside the profile header icon row (the same injection point
 * Discord uses for its own header buttons). Shows the pencil button and,
 * when open, the editor card.
 */
function HeaderOverlayInner({ userId }: { userId: string; }) {
    const overrides = useOverrides(userId);
    const [open, setOpen] = React.useState(false);

    return (
        <div className="vc-editprofile-overlay">
            {open && <EditorCard userId={userId} overrides={overrides} onClose={() => setOpen(false)} />}
            {overrides.badges.length > 0 && !open && <BadgeChipList overrides={overrides} />}
            {!open && <OverrideSummary userId={userId} overrides={overrides} />}
            <Clickable
                className={classes("vc-editprofile-pencil", overrides.badges.length > 0 && !open && "vc-editprofile-pencil-shifted")}
                onClick={() => setOpen(o => !o)}
                role="button"
                aria-label="Edit Profile (local only)"
            >
                <PencilIcon />
            </Clickable>
        </div>
    );
}

/**
 * Public component injected by index.tsx into the profile header.
 * userId is always provided by the patch; everything is error-boundary
 * wrapped so a plugin bug can never take the client down.
 */
export const HeaderOverlay = ErrorBoundary.wrap(function HeaderOverlay({ userId }: { userId: string; }) {
    if (!userId) return null;
    return <HeaderOverlayInner userId={userId} />;
}, { noop: true });

/**
 * Standalone modal version of the editor, opened from the titlebar button.
 * Guarantees the editor is always reachable even if the in-profile pencil
 * is not visible for a given Discord build.
 */
function EditProfileModalInner({ modalProps, userId }: { modalProps: RenderModalProps; userId: string; }) {
    const overrides = useOverrides(userId);
    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-md/semibold">Edit Profile (local only)</Text>
            </ModalHeader>
            <ModalContent className="vc-editprofile-modal-body">
                <EditorCard userId={userId} overrides={overrides} onClose={() => modalProps.onClose()} />
            </ModalContent>
            <ModalFooter>
                <Button color={Button.Colors.BRAND} onClick={() => modalProps.onClose()}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

const EditProfileModal = ErrorBoundary.wrap(EditProfileModalInner, { noop: true });

export function openEditProfileModal(userId: string) {
    openModal((props: RenderModalProps) => <EditProfileModal modalProps={props} userId={userId} />);
}


