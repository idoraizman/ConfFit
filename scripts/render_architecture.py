#!/usr/bin/env python3
"""Renders the ConfFit architecture diagram to public/architecture.png.

Every box label here must match a name in lib/modules.ts — that file is the
single source of truth for module names, and MODULE_NAMES below is checked
against it at render time so the diagram cannot drift from the steps trace.
"""
import base64
import os
import re
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_PNG = os.path.join(ROOT, "public", "architecture.png")
OUT_TS = os.path.join(ROOT, "lib", "architecture-png.ts")

S = 2  # supersampling factor
W, H = 1400, 1700

INK = (23, 27, 33)
MUTED = (104, 114, 128)
LINE = (176, 186, 198)
BG = (255, 255, 255)

AGENT_FILL = (238, 244, 255)
AGENT_EDGE = (59, 106, 214)
GATE_FILL = (255, 244, 226)
GATE_EDGE = (214, 138, 20)
SVC_FILL = (243, 245, 248)
SVC_EDGE = (176, 186, 198)
IO_FILL = (238, 250, 243)
IO_EDGE = (32, 141, 92)

FONT_DIR = "/System/Library/Fonts/Supplemental"


def font(name, size):
    for candidate in (
        os.path.join(FONT_DIR, name),
        os.path.join(FONT_DIR, "Arial Unicode.ttf"),
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size * S)
            except OSError:
                continue
    return ImageFont.load_default()


F_TITLE = font("Arial Bold.ttf", 27)
F_SUB = font("Arial.ttf", 15)
F_BOX = font("Arial Bold.ttf", 20)
F_BOXSUB = font("Arial.ttf", 14)
F_SMALL = font("Arial.ttf", 13)
F_EDGE = font("Arial Italic.ttf", 13)
F_SECTION = font("Arial Bold.ttf", 15)
F_MONO = font("Arial.ttf", 14)

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)

# Names that must exist in lib/modules.ts.
MODULE_NAMES = [
    "Supervisor",
    "ConferenceProfiler",
    "FramingAgent",
    "FramingReflect",
    "FormatComplianceAgent",
    "UnifiedFixer",
]


def check_module_names():
    src = open(os.path.join(ROOT, "lib", "modules.ts"), encoding="utf-8").read()
    declared = set(re.findall(r"^\s*[A-Z_]+:\s*'([A-Za-z]+)',", src, re.M))
    missing = [n for n in MODULE_NAMES if n not in declared]
    extra = [n for n in declared if n not in MODULE_NAMES]
    if missing or extra:
        sys.exit(
            f"Diagram/module mismatch.\n  missing from lib/modules.ts: {missing}\n"
            f"  in lib/modules.ts but not on the diagram: {extra}"
        )


def text(x, y, s, f, fill=INK, anchor="mm"):
    d.text((x * S, y * S), s, font=f, fill=fill, anchor=anchor)


def box(cx, y, w, h, fill, edge, radius=12, dash=False, width=2):
    x0, y0 = (cx - w / 2) * S, y * S
    x1, y1 = (cx + w / 2) * S, (y + h) * S
    d.rounded_rectangle([x0, y0, x1, y1], radius=radius * S, fill=fill,
                        outline=None if dash else edge, width=width * S)
    if dash:
        dash_rounded(x0, y0, x1, y1, radius * S, edge, width * S)


def dash_rounded(x0, y0, x1, y1, r, color, width):
    """Dashed rectangle border (rounded corners drawn solid)."""
    step, on = 14 * S, 8 * S
    for x in range(int(x0 + r), int(x1 - r), step):
        d.line([x, y0, min(x + on, x1 - r), y0], fill=color, width=width)
        d.line([x, y1, min(x + on, x1 - r), y1], fill=color, width=width)
    for y in range(int(y0 + r), int(y1 - r), step):
        d.line([x0, y, x0, min(y + on, y1 - r)], fill=color, width=width)
        d.line([x1, y, x1, min(y + on, y1 - r)], fill=color, width=width)
    d.arc([x0, y0, x0 + 2 * r, y0 + 2 * r], 180, 270, fill=color, width=width)
    d.arc([x1 - 2 * r, y0, x1, y0 + 2 * r], 270, 360, fill=color, width=width)
    d.arc([x0, y1 - 2 * r, x0 + 2 * r, y1], 90, 180, fill=color, width=width)
    d.arc([x1 - 2 * r, y1 - 2 * r, x1, y1], 0, 90, fill=color, width=width)


def arrow(x0, y0, x1, y1, label=None, color=LINE, label_dx=12):
    d.line([x0 * S, y0 * S, x1 * S, y1 * S], fill=color, width=2 * S)
    head = 8 * S
    if y1 > y0:  # pointing down
        d.polygon(
            [(x1 * S, y1 * S), (x1 * S - head * 0.7, y1 * S - head), (x1 * S + head * 0.7, y1 * S - head)],
            fill=color,
        )
    if label:
        text(x0 + label_dx, (y0 + y1) / 2, label, F_EDGE, MUTED, anchor="lm")


def elbow(x0, y0, x1, y1, color=LINE):
    """Vertical, horizontal, then vertical with an arrowhead."""
    mid = (y0 + y1) / 2
    d.line([x0 * S, y0 * S, x0 * S, mid * S], fill=color, width=2 * S)
    d.line([x0 * S, mid * S, x1 * S, mid * S], fill=color, width=2 * S)
    arrow(x1, mid, x1, y1, color=color)


CX = 700

# ── Header ───────────────────────────────────────────────────────────────────
text(CX, 44, "ConfFit — Agentic System for Academic Conference Submission", F_TITLE)
text(CX, 76, "A thin Supervisor coordinating one Reflection worker and two ReAct workers.", F_SUB, MUTED)
text(CX, 97, "Every box name below is the exact \"module\" value emitted in the /api/execute steps trace.", F_SUB, MUTED)

# ── Input ────────────────────────────────────────────────────────────────────
box(CX, 130, 420, 46, IO_FILL, IO_EDGE, radius=23)
text(CX, 153, "POST /api/execute   { \"prompt\": … }", F_BOXSUB, IO_EDGE)
arrow(CX, 176, CX, 208)

# ── Supervisor (route) ───────────────────────────────────────────────────────
box(CX, 210, 560, 76, AGENT_FILL, AGENT_EDGE)
text(CX, 236, "Supervisor", F_BOX, AGENT_EDGE)
text(CX, 262, "route · monitor · merge    —    1 LLM call to pick venue + workers", F_BOXSUB, MUTED)
arrow(CX, 286, CX, 320, "dispatch")

# ── ConferenceProfiler ───────────────────────────────────────────────────────
box(CX, 322, 620, 108, AGENT_FILL, AGENT_EDGE)
text(CX, 348, "ConferenceProfiler", F_BOX, AGENT_EDGE)
text(CX, 374, "ReAct + RAG over the Call-for-Papers and past accepted papers", F_BOXSUB, MUTED)
text(CX, 396, "Supabase cache hit → 0 LLM calls · Pinecone namespace per venue", F_SMALL, MUTED)
text(CX, 416, "→ ConferenceProfile { focus_areas, valued_criteria, accepted_paper_emphasis, format_rules }", F_SMALL, MUTED)
arrow(CX, 430, CX, 466, "cache MISS")

# ── Human-in-the-loop gate ───────────────────────────────────────────────────
box(CX, 468, 620, 82, GATE_FILL, GATE_EDGE, dash=True)
text(CX, 494, "HUMAN-IN-THE-LOOP GATE — ask before ingesting", F_BOX, GATE_EDGE)
text(CX, 520, "Returns a confirmation request. Nothing is written to Pinecone or Supabase", F_BOXSUB, MUTED)
text(CX, 540, "until the user replies \"yes\" or pastes the correct CFP link.", F_BOXSUB, MUTED)

LX, RX = 420, 980

# cache-HIT bypass: a venue already in the knowledge base skips the gate
BYX = 1120
d.line([1010 * S, 400 * S, BYX * S, 400 * S], fill=IO_EDGE, width=2 * S)
d.line([BYX * S, 400 * S, BYX * S, 588 * S], fill=IO_EDGE, width=2 * S)
d.line([BYX * S, 588 * S, RX * S, 588 * S], fill=IO_EDGE, width=2 * S)
text(BYX + 10, 468, "cache HIT", F_EDGE, IO_EDGE, anchor="lm")
text(BYX + 10, 488, "(gate skipped)", F_EDGE, IO_EDGE, anchor="lm")

# split
d.line([CX * S, 550 * S, CX * S, 588 * S], fill=LINE, width=2 * S)
text(CX + 12, 569, "profile ready", F_EDGE, MUTED, anchor="lm")
d.line([LX * S, 588 * S, RX * S, 588 * S], fill=LINE, width=2 * S)
arrow(LX, 588, LX, 622)
arrow(RX, 588, RX, 622)

# ── Workers ──────────────────────────────────────────────────────────────────
box(LX, 624, 480, 210, AGENT_FILL, AGENT_EDGE)
text(LX, 650, "FramingAgent", F_BOX, AGENT_EDGE)
text(LX, 675, "REFLECTION pattern — the Generate half", F_BOXSUB, MUTED)
text(LX, 696, "Proposes the re-positioning, rewrites", F_SMALL, MUTED)
text(LX, 714, "title · abstract · introduction opening", F_SMALL, MUTED)
box(LX, 726, 380, 62, (255, 255, 255), AGENT_EDGE, radius=9)
text(LX, 748, "FramingReflect", F_BOXSUB, AGENT_EDGE)
text(LX, 770, "Critique / Pros / Cons vs. the profile — loop N ≤ 2", F_SMALL, MUTED)
text(LX, 806, "→ framing report", F_SECTION, INK)

box(RX, 624, 480, 210, AGENT_FILL, AGENT_EDGE)
text(RX, 650, "FormatComplianceAgent", F_BOX, AGENT_EDGE)
text(RX, 675, "ReAct pattern over a deterministic core", F_BOXSUB, MUTED)
text(RX, 700, "In code (0 tokens): page & abstract limits,", F_SMALL, MUTED)
text(RX, 718, "citation style, required sections,", F_SMALL, MUTED)
text(RX, 736, "double-blind anonymity scan", F_SMALL, MUTED)
text(RX, 762, "rules_lookup only when a rule is ambiguous", F_SMALL, GATE_EDGE)
text(RX, 806, "→ format report", F_SECTION, INK)

# merge into the fixer
d.line([LX * S, 834 * S, LX * S, 868 * S], fill=LINE, width=2 * S)
d.line([RX * S, 834 * S, RX * S, 868 * S], fill=LINE, width=2 * S)
d.line([LX * S, 868 * S, RX * S, 868 * S], fill=LINE, width=2 * S)
arrow(CX, 868, CX, 900)

# ── UnifiedFixer ─────────────────────────────────────────────────────────────
box(CX, 902, 620, 96, AGENT_FILL, AGENT_EDGE)
text(CX, 928, "UnifiedFixer", F_BOX, AGENT_EDGE)
text(CX, 954, "Applies both reports in a single pass — 1 LLM call returning targeted edits", F_BOXSUB, MUTED)
text(CX, 976, "→ one revised manuscript (code splices the edits; untouched text is byte-identical)", F_SMALL, MUTED)
arrow(CX, 998, CX, 1032)

# ── Supervisor (merge) ───────────────────────────────────────────────────────
box(CX, 1034, 560, 76, AGENT_FILL, AGENT_EDGE)
text(CX, 1060, "Supervisor — merge", F_BOX, AGENT_EDGE)
text(CX, 1086, "1 LLM call for the summary; the report layout is assembled in code", F_BOXSUB, MUTED)
arrow(CX, 1110, CX, 1142)

box(CX, 1144, 560, 46, IO_FILL, IO_EDGE, radius=23)
text(CX, 1167, "{ \"status\", \"error\", \"response\", \"steps\": [ … ] }", F_BOXSUB, IO_EDGE)

# ── Shared services ──────────────────────────────────────────────────────────
d.line([120 * S, 1224 * S, (W - 120) * S, 1224 * S], fill=LINE, width=1 * S)
text(CX, 1252, "SHARED SERVICES  (not agents — they never appear as a module in the trace)", F_SECTION, MUTED)

svc_y, svc_h, svc_w = 1280, 118, 380
for i, (title, lines) in enumerate(
    [
        ("Supabase — primary DB", ["conference-profile cache", "pending human-in-the-loop approvals", "run history & session state"]),
        ("Pinecone — vector DB", ["CFP chunks + past accepted papers", "one namespace per venue", "text-embedding-3-small"]),
        ("MCP tools", ["web_search · web_fetch", "vector_search · rules_lookup", "exposed via tools/list · tools/call"]),
    ]
):
    cx = 250 + i * 450
    box(cx, svc_y, svc_w, svc_h, SVC_FILL, SVC_EDGE, radius=10, width=1)
    text(cx, svc_y + 28, title, F_BOXSUB, INK)
    for j, line in enumerate(lines):
        text(cx, svc_y + 56 + j * 20, line, F_SMALL, MUTED)

# ── Footer ───────────────────────────────────────────────────────────────────
text(CX, 1452, "Text model: MB5R2CF-azure/gpt-5.4-mini        Embeddings: MB5R2CF-azure/text-embedding-3-small", F_MONO, INK)
text(CX, 1478, "Typical run: 6–9 small LLM calls. Routing skips unused workers; a cached venue profile costs none.", F_SMALL, MUTED)
text(CX, 1500, "Manuscript parsing, rule checks and mechanical fixes run in code, not in the model.", F_SMALL, MUTED)

img = img.resize((W, H), Image.LANCZOS).crop((0, 0, W, 1530))

# The diagram is flat colour and text, so an adaptive palette keeps it visually
# identical while cutting the file to roughly a third — it ships base64-inlined
# in the JS bundle, so size matters.
img = img.convert("RGB").quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE)

os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
check_module_names()
img.save(OUT_PNG, "PNG", optimize=True)

b64 = base64.b64encode(open(OUT_PNG, "rb").read()).decode("ascii")
with open(OUT_TS, "w", encoding="utf-8") as fh:
    # One single-quoted literal on one line: webpack's parser blows its stack on
    # a long chain of string concatenations.
    fh.write(
        "/* eslint-disable */\n"
        "// GENERATED FILE — do not edit by hand.\n"
        "// Produced by scripts/render_architecture.py; box names are validated\n"
        "// against lib/modules.ts at render time.\n"
        "// Inlined as base64 so GET /api/model_architecture never depends on the\n"
        "// filesystem layout of the serverless bundle.\n"
        "export const ARCHITECTURE_PNG_BASE64 = '" + b64 + "'\n"
    )

print(f"wrote {OUT_PNG} ({os.path.getsize(OUT_PNG) // 1024} KB) and {OUT_TS}")
