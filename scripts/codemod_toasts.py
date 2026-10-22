#!/usr/bin/env python3
"""One-shot codemod: migrate legacy Vencord Toasts API to new showToast API.

Handles:
  showToast(msg, Toasts.Type.X)          -> showToast(msg, "variant")
  Toasts.show({ message, id, type })     -> showToast({ text, variant })
Removes `Toasts` from @webpack/common import lists.
Variant map: SUCCESS->success, FAILURE->critical, MESSAGE/INFO->default.
"""
import re, sys, pathlib

VARIANT = {"SUCCESS": '"success"', "FAILURE": '"critical"', "MESSAGE": '"default"', "INFO": '"default"'}

FILES = [
    "src/plugins/DontControlMe/index.tsx",
    "src/plugins/FollowUser/index.tsx",
    "src/plugins/PasscodeLock/index.tsx",
    "src/plugins/questify/utils/completion.ts",
    "src/plugins/voiceReplayBuffer/index.tsx",
    "src/userplugins/pnygo/modules/editmessage.tsx",
    "src/userplugins/pnygo/modules/editprofile/index.tsx",
    "src/userplugins/pnygo/modules/joinvcfriend.tsx",
    "src/userplugins/pnygo/modules/missedcalls.tsx",
    "src/userplugins/pnygo/modules/selfcheck.tsx",
    "src/userplugins/pnygo/modules/tokentools.tsx",
]

def variant(t: str) -> str:
    return VARIANT.get(t, '"default"')

def fix_toast_call(m: re.Match) -> str:
    indent = m.group(3)
    return (f'showToast({{\n'
            f'{indent}    text: {m.group(1)},\n'
            f'{indent}    variant: {variant(m.group(2))}\n'
            f'{indent}}})')

def process(txt: str, path: str) -> str:
    # 1) simple positional form: showToast(msg, Toasts.Type.X) or toast(msg, Toasts.Type.X)
    txt = re.sub(
        r'(showToast|toast)\s*\(\s*("([^"\\]|\\.)*"|`[^`]*`|[^,()]+?)\s*,\s*Toasts\.Type\.([A-Z]+)\s*\)',
        lambda m: f'{m.group(1)}({m.group(2)}, {variant(m.group(4))})',
        txt)
    # 2) object form Toasts.show({ message..., id: Toasts.genId(), type: Toasts.Type.X })
    pat = re.compile(
        r'Toasts\.show\(\{\s*message:\s*("(?:[^"\\]|\\.)*")\s*,\s*\n\s*id:\s*Toasts\.genId\(\)\s*,\s*\n\s*type:\s*Toasts\.Type\.([A-Z]+)\s*,?\s*\n(\s*)\}\)')
    txt = pat.sub(fix_toast_call, txt)
    # 3) remove Toasts from import statements (single-line and multiline)
    txt = re.sub(r'(import\s*\{[^}]*?)\bToasts,\s*', r'\1', txt)
    txt = re.sub(r'(import\s*\{[^}]*?),\s*Toasts\b', r'\1', txt)
    txt = re.sub(r'\bToasts,\s*\n(\s*openModal)', r'\1', txt)
    txt = re.sub(r'^\s*Toasts,\s*\n', '', txt, flags=re.M)
    txt = re.sub(r'^\s*Toasts\s*\n\}', '\n}', txt, flags=re.M)
    leftover = re.findall(r'Toasts[.\w]*', txt)
    if leftover:
        print(f"WARNING {path}: leftover Toasts refs: {sorted(set(leftover))}")
    return txt

def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    for rel in FILES:
        p = root / rel
        txt = p.read_text(encoding="utf-8")
        new = process(txt, rel)
        if new != txt:
            p.write_text(new, encoding="utf-8", newline="\n")
            print(f"updated {rel}")

if __name__ == "__main__":
    sys.exit(main())
