/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const counts: Record<string, number> = {};

/** Called from a $self.* entry point. */
export function hit(key: string): void {
    try {
        counts[key] = (counts[key] ?? 0) + 1;
    } catch { /* never break the caller */ }
}

/** How many times Discord's own code called this entry point. */
export function count(key: string): number {
    return counts[key] ?? 0;
}

/** true when the entry point was observed at least once. */
export function observed(key: string): boolean {
    return count(key) > 0;
}

/** Snapshot for the SelfCheck panel (never mutated). */
export function snapshot(): Record<string, number> {
    return { ...counts };
}

/** Reset every counter (used when the user presses Re-check). */
export function reset(): void {
    for (const key of Object.keys(counts)) delete counts[key];
}
