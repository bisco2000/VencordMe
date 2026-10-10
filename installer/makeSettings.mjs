// Generates the settings payloads shipped inside VencordMe-Setup.exe.
//
//   node installer/makeSettings.mjs <vencord-settings.json>           -> payload/settings.json      (defaults: every plugin disabled)
//   node installer/makeSettings.mjs <vencord-settings.json> --profile -> payload/settings.mine.json (your profile, pnygo forced off)
//
// Both payloads:
// - the "cloud" block is removed (no personal Vencord Cloud login)
// - entries for plugins that do not exist in this build are dropped
// - every plugin of this build is present
// - quickCss is shipped empty
//
// The profile additionally keeps your enabled flags + option values, except
// pnygo which is always shipped disabled with its options emptied (no webhook).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const profile = args.includes("--profile");
const SRC = args.find(a => !a.startsWith("--"));

if (!SRC) {
    console.error("usage: node installer/makeSettings.mjs <path-to-vencord-settings.json> [--profile]");
    process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "payload", profile ? "settings.mine.json" : "settings.json");

// Every plugin name that exists in this build, read straight from the source
// (src/plugins + src/userplugins, including the _api/_core helper plugins that
// the website plugin list deliberately leaves out).
function collectPluginNames(dir, acc) {
    if (!existsSync(dir)) return acc;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectPluginNames(full, acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            const src = readFileSync(full, "utf8");
            const m = src.match(/definePlugin\(\s*\{[\s\S]*?\bname:\s*"([^"]+)"/);
            if (m) acc.add(m[1]);
        }
    }

    return acc;
}

const known = collectPluginNames(join(ROOT, "src", "plugins"), new Set());
collectPluginNames(join(ROOT, "src", "userplugins"), known);

const raw = JSON.parse(readFileSync(SRC, "utf-8"));
const settings = raw.settings ?? {};

// drop anything personal at the top level
delete settings.cloud;
settings.themeLinks = [];
settings.enabledThemes = [];
settings.enabledThemeLinks = [];
settings.pinnedThemes = [];
settings.themeNames = {};
settings.themeActivationModes = {};
settings.userCssVars = {};
settings.uiElements = { chatBarButtons: {}, messagePopoverButtons: {} };

if (typeof raw.quickCss === "string" && raw.quickCss.trim() !== "") {
    console.warn("note: source quickCss was NOT empty (" + raw.quickCss.length + " chars) -> shipping empty");
}

const sourcePlugins = settings.plugins ?? {};
settings.plugins = {};

let enabledInSource = 0;
let keptEnabled = 0;
let dropped = 0;
let strippedPnygo = false;

for (const name of Object.keys(sourcePlugins)) {
    const entry = sourcePlugins[name];
    const sourceEnabled = !!entry && typeof entry === "object" && entry.enabled === true;
    if (sourceEnabled) enabledInSource++;

    if (!known.has(name)) {
        dropped++;
        continue;
    }

    if (name === "pnygo") {
        // your own plugin is never shipped enabled, and never ships a webhook
        settings.plugins[name] = { enabled: false };
        strippedPnygo = sourceEnabled;
        continue;
    }

    if (profile) {
        // keep everything as it is: enabled flag + option values
        settings.plugins[name] = (entry && typeof entry === "object")
            ? Object.assign({}, entry, { enabled: sourceEnabled })
            : { enabled: false };
        if (sourceEnabled) keptEnabled++;
    } else {
        settings.plugins[name] = { enabled: false };
    }
}

// every plugin of this build must exist in the payload, even ones the source
// settings never touched (defaults: disabled)
let added = 0;
for (const name of known) {
    if (!settings.plugins[name]) {
        settings.plugins[name] = { enabled: false };
        added++;
    }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(settings, null, 4) + "\n", "utf-8");

// QuickCSS file Vencord reads from SETTINGS_DIR/quickCss.css
writeFileSync(join(HERE, "payload", "quickCss.css"), "", "utf-8");

const out = JSON.stringify(settings, null, 4);
const urls = out.match(/https?:\/\/[^\s"]+/g) ?? [];
const enabledNow = Object.values(settings.plugins).filter(e => e?.enabled === true).length;

console.log("mode                          :", profile ? "profile (your settings)" : "defaults (everything disabled)");
console.log("plugins known to this build   :", known.size);
console.log("source plugins                :", Object.keys(sourcePlugins).length, `(dropped ${dropped} that do not exist here)`);
console.log("added that source was missing :", added);
console.log("enabled in source             :", enabledInSource, "-> enabled in payload:", enabledNow);
console.log("pnygo                         :", JSON.stringify(settings.plugins.pnygo ?? null), strippedPnygo ? "(was enabled, forced off)" : "");
console.log("cloud block removed           :", !("cloud" in settings));
console.log("webhook in payload            :", out.includes("api/webhooks"));
console.log("urls left in payload          :", urls.length, urls.slice(0, 5));
console.log("personal paths left           :", (out.match(/[A-Za-z]:\\\\Users\\\\/g) ?? []).length);
console.log("written ->", OUT);
