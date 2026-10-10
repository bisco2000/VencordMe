/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import { Button, Clickable, Forms, React, Text, TextInput, Tooltip } from "@webpack/common";

import { badgeImageUrl, getAllBadges, getOfficialBadge, OfficialBadgeDef, refreshDirectoryCatalog } from "../badges";
import { OverrideBadge, setOverrides, useOverrides } from "../overrides";

function BadgeToggle({ checked, tooltip, src, label, onClick }: {
    checked: boolean;
    tooltip: string;
    src: string;
    label: string;
    onClick: () => void;
}) {
    return (
        <Tooltip text={tooltip} position="top">
            {({ onMouseEnter, onMouseLeave }) => (
                <Clickable
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    onClick={onClick}
                    className={checked ? "vc-editprofile-btoggle vc-editprofile-btoggle-on" : "vc-editprofile-btoggle"}
                    role="button"
                    aria-label={label}
                >
                    <img src={src} alt="" width={24} height={24} />
                    <Text variant="text-xxs/medium" className="vc-editprofile-btoggle-label">{label}</Text>
                </Clickable>
            )}
        </Tooltip>
    );
}

/** Generate the next unique id for a custom badge. */
function nextCustomUid(badges: OverrideBadge[]): string {
    let n = badges.length + 1;
    while (badges.some(b => b.uid === `editprofile-custom-${n}`)) n++;
    return `editprofile-custom-${n}`;
}

export const BadgePickerModal = ErrorBoundary.wrap(function BadgePickerInner({ modalProps, userId }: {
    modalProps: RenderModalProps;
    userId: string;
}) {
    const overrides = useOverrides(userId);
    const selected = overrides.badges;

    // full badge list: static legacy catalog + Discord's live badge directory
    const [catalog, setCatalog] = React.useState<OfficialBadgeDef[]>(() => getAllBadges());
    React.useEffect(() => {
        refreshDirectoryCatalog().then(() => setCatalog(getAllBadges()));
    }, []);

    const toggleOfficial = (id: string) => {
        const uid = `editprofile-official-${id}`;
        if (selected.some(b => b.uid === uid)) {
            setOverrides(userId, { badges: selected.filter(b => b.uid !== uid) });
        } else {
            setOverrides(userId, { badges: [...selected, { uid, kind: "official", officialId: id }] });
        }
    };

    const move = (from: number, to: number) => {
        if (to < 0 || to >= selected.length) return;
        const copy = [...selected];
        const [item] = copy.splice(from, 1);
        copy.splice(to, 0, item);
        setOverrides(userId, { badges: copy });
    };

    const [customUrl, setCustomUrl] = React.useState("");
    const [customTip, setCustomTip] = React.useState("");

    const addCustom = () => {
        if (!customUrl.trim()) return;
        const badge: OverrideBadge = {
            uid: nextCustomUid(selected),
            kind: "custom",
            custom: { imageUrl: customUrl.trim(), tooltip: customTip.trim() || "Custom badge" },
        };
        setOverrides(userId, { badges: [...selected, badge] });
        setCustomUrl("");
        setCustomTip("");
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-md/semibold">Badge picker — local only</Text>
            </ModalHeader>
            <ModalContent>
                <Forms.FormTitle tag="h5">Selected (order = display order)</Forms.FormTitle>
                {selected.length === 0
                    ? <Text variant="text-sm/normal">No badges selected. Click badges below to add them.</Text>
                    : (
                        <div className="vc-editprofile-sellist">
                            {selected.map((b, i) => {
                                const def = getOfficialBadge(b.officialId);
                                const src = b.kind === "custom" ? b.custom?.imageUrl ?? "" : badgeImageUrl(def);
                                const label = b.kind === "custom" ? b.custom?.tooltip || "Custom badge" : def?.description ?? b.uid;
                                return (
                                    <div key={b.uid} className="vc-editprofile-selrow">
                                        <img src={src} alt="" width={20} height={20} />
                                        <Text variant="text-xs/medium" className="vc-editprofile-selrow-label">{label}</Text>
                                        <div className="vc-editprofile-selrow-actions">
                                            <Button size={Button.Sizes.MIN} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</Button>
                                            <Button size={Button.Sizes.MIN} disabled={i === selected.length - 1} onClick={() => move(i, i + 1)}>↓</Button>
                                            <Button
                                                size={Button.Sizes.MIN}
                                                color={Button.Colors.RED}
                                                onClick={() => setOverrides(userId, { badges: selected.filter(x => x.uid !== b.uid) })}
                                            >
                                                ✕
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                <Forms.FormTitle tag="h5">Official Discord badges</Forms.FormTitle>
                <div className="vc-editprofile-grid">
                    {catalog.map(def => (
                        <BadgeToggle
                            key={def.id}
                            checked={selected.some(b => b.uid === `editprofile-official-${def.id}`)}
                            tooltip={def.description}
                            src={badgeImageUrl(def)}
                            label={def.description}
                            onClick={() => toggleOfficial(def.id)}
                        />
                    ))}
                </div>

                <Forms.FormTitle tag="h5">Custom badge (image URL + tooltip)</Forms.FormTitle>
                <div className="vc-editprofile-customrow">
                    <TextInput value={customUrl} placeholder="https://... image url" onChange={setCustomUrl} />
                    <TextInput value={customTip} placeholder="tooltip text" onChange={setCustomTip} />
                    <Button color={Button.Colors.BRAND} onClick={addCustom} disabled={!customUrl.trim()}>Add</Button>
                </div>

                <div className="vc-editprofile-hidereal">
                    <FormSwitch
                        value={overrides.hideRealBadges}
                        onChange={v => setOverrides(userId, { hideRealBadges: v })}
                        title="Hide real badges"
                        description="Show only the badges selected above and hide the real ones (locally)"
                    />
                </div>
            </ModalContent>
            <ModalFooter>
                <Button color={Button.Colors.BRAND} onClick={() => modalProps.onClose()}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
});

