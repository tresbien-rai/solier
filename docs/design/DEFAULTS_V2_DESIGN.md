# Solier Defaults v2 — Starter Experience, Prompt Architecture & Workbench Editor

> **Status (2026-11-26):** In progress — DF-01 and DF-02 shipped; DF-03 planned.

---

## 1. Problem

What ships out of the box for a brand-new Solier user has fallen behind the rest of the app:

1. **Stale hardcoded default model:** New accounts and `js/config.js` default to `anthropic` / `claude-sonnet-4-20250514`, even when the user has zero API keys and an empty model catalog. A true default should state honestly that no model is set and guide them to Models.
2. **Placeholder default persona:** New accounts get a bare `"Assistant"` (`"You are a helpful AI assistant."`, no tagline, no role chip, no traits, legacy Sonnet 4 `modelConfig`), which neither introduces Solier's warmth nor teaches new users how the 6-section trait editor works.
3. **Heavy, over-constrained system prompts & older layout:**
   - The base prompt (`server/src/prompts/tessera.js`) was drafted in an older defensive-guardrail style, puts `Persona` last (after ~600+ tokens of platform framing), never states the persona's own name (`{{char}}`), always lectures about Workspace/tools even when tools are off, and forces helpful/accurate assistant framing on quirky or RP personas (`lazy`, `evasive`, `arrogant`, `talking_cat`, etc.).
   - `<session_state>`, `<active_files>`, and `<scratchpad>` are appended *after* the user's latest message instead of prepended inside a clean XML envelope ahead of the user's words, and `<session_state>` is still injected on completely bare chats.
   - The Prompt Preset Editor only lets users tweak text against faint placeholder shadows and doesn't expose the full System vs. Message layer picture.

---

## 2. Locked Decisions

### DF-01 — Starter Persona ("Soli") & Unset-Model Default

- **D1 — True unset model default (`provider: null, model: null`):**
  - Remove hardcoded `claude-sonnet-4-20250514` from `server/src/routes/auth.js` (`seedNewUserDefaults`) and `js/config.js` (`CONFIG.defaults`).
  - When `provider` or `model` is `null` (or the active model is removed and the catalog is empty), UI model selectors (composer pill, Chats `"Next chat starts with"` pill) display **`No model set`** and clicking opens **Models**.
  - Send button stays disabled with a clear nudge; onboarding CTA copy ends at **`"...to start."`** (not `"to start chatting"`, keeping room for future non-chat capabilities).
  - **Auto-activate first model:** When the active layer has no model set (`!layer.model`) and the user adds/enables their first model in **Models**, automatically activate it so setup takes one step instead of two.

- **D2 — Default Starter Persona: Soli (future mascot):**
  - **Name:** `Soli`
  - **Role chip:** `Companion`
  - **Tagline:** `"Always a spare chair by the window."`
  - **Model mode:** `shared` (`{ mode: 'shared' }`, no pinned model)
  - **Starter traits** (6 light picks from `js/persona-traits.js` so new users see the trait editor in action):
    - `personality`: `calm`, `warm`, `curious`
    - `speech`: `conversational`
    - `expertise`: `general_helper`
    - `relationship`: `peer`
  - **Background:** Empty (demonstrates optional sections).
  - **General guidance:** `"Keep answers clear and grounded, say when you're unsure, and match the pace of the conversation."`
  - **Expressions:** Default 6 emoji slots (`neutral`, `happy`, `sad`, `thinking`, `excited`, `confused`), ready for custom mascot art later.

### DF-02 — Default System Prompt & Context Architecture (v2)

- **D3 — XML-delimited System Layer (`<operating_environment>`, `<main_persona>`, `<capabilities>`):**
  1. **`<operating_environment>` (`orientation`):** Environment-only framing — what Solier is (*"a personal, infinite room that can be set up for anything; conversations, writing, work, and more"*), that the model shares the space through its persona, and a concise `<tool_trail>` guard (*when tools are available, earlier replies may include a `<tool_trail>` line summarizing tools that ran — their results aren't repeated, and don't write a `<tool_trail>` yourself*). No behavioral/helpfulness lecturing that fights quirky RP personas.
  2. **`<main_persona>` (`persona`, moved to #2):** Auto-wrapped in `<main_persona>\n# Persona: {{char}}\nThis is who you are.\n\n...\n</main_persona>` so every persona knows its own name and has an explicit closing boundary.
  3. **`<capabilities>` (protected, auto-wrapped sub-layer):** Automatically wraps whichever capability sub-sections are active in `<capabilities>\n# Capabilities\n...\n</capabilities>` (and omits the wrapper entirely when zero capabilities are active). Its internals are server-managed for reliable tool use across presets, while the sub-layer's position stays movable as a unit:
     - `## Workspace & Project` — included when inside a Workspace or Project (does *not* name file tools when file tools are off).
     - `## File Tools` — included only when `toolsEnabled === true`; names the commands (`list_files`, `read_file`, `create_file`, `edit_file`, `move_file`) and keeps the grounding/unloaded-file nudge.
     - `## Scratchpad` — included only when `scratchpadEnabled === true`; names `write_scratchpad`/`edit_scratchpad`, explains live side-by-side visibility (keep chat brief rather than restating the draft), in-place updates, and verbatim `<current_content>` matching.
     - `## Avatar Expressions` — included only when persona has expressions and `auxExpressions` is off; places `[expression: name]` once at the start of the final chat reply (not tool-use turns), closest-match fallback, stripped before display (never mention).

- **D4 — Message Layer (`<user_profile>`, Workspace KB, Neutral Ack, `<current_context>`):**
  - **`<user_profile>` (`profile`):** Placed at the **start of the Message Layer by default** (still 100% inside the cached prefix before Conversation History), formatted as `<user_profile>\n# User: {{user}}\nThis is background context you already know about the user. It should be used quietly, and not recited back or brought up unprompted.\n\n{{profile}}\n</user_profile>`. Drops the redundant `"They go by **X**"` line from `renderProfile()` and omits `"trust the conversation"` so personas can naturally react to contradictions (and later update memory).
  - **Voice-neutral `CONTEXT_ACK`:** `"Reference context noted."` — zero slang or first-person `"I"` so it never primes third-person, archaic, or quirky personas. Shared by the leading context turn (`<user_profile>` and/or Workspace/Project KB).
  - **Conversation History:** Native `user` / `assistant` API turns (never flattened into XML) for multi-turn fidelity and incremental prompt caching.
  - **`<current_context>` (volatile tail, prepended before latest user message):** Wraps `<session_state>`, `<active_files>` (if any), and `<scratchpad>` (if any) inside `<current_context>...</current_context>` immediately ahead of the user's plain-text message (handling both string and multimodal attachment arrays). Omitted completely on bare chats (no container, no file tools, no scratchpad, 0 chat files). Content is server-generated/protected; position (before vs. after latest user message) can be configured in presets.

### DF-03 — Expanded Workbench-Style Prompt Preset Editor UI

- **D5 — System vs. Message Layer Preset Editor:**
  - Upgrade Settings → Advanced → Prompt Preset Editor to reflect the full System Layer and Message Layer picture (inspired by the interactive workbench prototype):
    - Clear **System Layer** and **Message Layer** sections with cross-layer reordering for movable blocks (e.g. moving `User Profile` between Message and System).
    - Position-only placeholder cards for generated/external data blocks (`Persona`, `Workspace KB`, `Conversation History`, `Current Context`) and the protected `<capabilities>` sub-layer card.
    - Directly editable pre-filled base text (with one-click **Reset to built-in** per block) rather than faint shadow placeholders.

---

## 3. Slices

| Slice | Scope | Status |
|---|---|---|
| **DF-01** | Starter persona **Soli** + true `"No model set"` default (`provider: null, model: null`, CTA ending at `"...to start."`, auto-activate first model added) | Complete |
| **DF-02** | New v2 prompt & context architecture (`tessera.js`, `presets.js`, `profile.js`, `activeFiles.js`, `chat.js`, prompt & cache tests) | Complete |
| **DF-03** | Expanded Workbench-style Prompt Preset Editor UI in Settings → Advanced | Planned |
