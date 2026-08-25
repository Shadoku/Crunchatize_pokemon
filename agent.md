# AGENT.md — Chub.ai Stages

Reference notes for developing, understanding, and maintaining a **Chub.ai Stage**. Source: https://docs.chub.ai/docs/stages/developing-a-stage (and linked sub-pages).

---

## 1. What a Stage Is

A **Stage** is a small, sandboxed React/TypeScript application that plugs into a Chub chat to add functionality on top of the base LLM chat experience — e.g.:

- A UI for a world, character, or setting
- RPGs and other multimedia experiences (maze games, stat blocks, minigames)
- Custom stat blocks that do math / track state correctly (things an LLM is bad at)
- Special input/output handling to work around quirks of a particular model
- Expression packs (rendering a character's emotional state as an image)
- Third-party API integrations (image gen, TTS, etc.)

**Security model:** Stages are hosted on a separate domain and run inside a sandboxed `<iframe>`.
- No access to Chub's cookies, local storage, keys, or passwords.
- Can't trigger hostile browser behaviors (e.g. `alert()`).
- Each stage runs from its own sub-domain, so stages can't read each other's storage/cookies either.
- Stages marked **Verified** have been manually reviewed by Chub for hostile behavior.

**Distribution:** Stages are write-once, run-everywhere — committing triggers a build that deploys to web, iOS, Android, and Vision Pro simultaneously (more platforms planned).

---

## 2. Project Structure

Generated from the official template (`https://github.com/CharHubAI/stage-template`, older name `extension-template`):

```
public/
    chub_meta.yaml     # Stage metadata: name, description, tags, config schema, position, etc.
src/
    Stage.tsx          # ★ Main file — implement the StageBase interface here.
    TestRunner.tsx     # Local dev runner (stands in for a real chat; dev-only).
    assets/
        test-init.json # Seed/test data consumed by TestRunner.
    index.scss         # Styling
    main.tsx           # App entry point
    App.tsx
package.json           # Dependencies
.github/workflows/deploy.yml  # CI: builds & deploys the stage to Chub on push to main
.eslintrc.cjs
index.html
tsconfig.json
tsconfig.node.json
vite.config.ts
yarn.lock
```

The framework (Vite + React + TypeScript + yarn) handles all communication between the chat UI and your stage site via the **stages library**. As a developer you only need to implement the `StageBase` interface in `Stage.tsx` — you don't touch the transport/messaging layer directly.

---

## 3. Where a Stage Lives in the Chat UI

- If `position: NONE` is set in `chub_meta.yaml`, the stage renders nothing and runs purely in the background (state/logic only, no UI).
- Otherwise, on desktop/wide screens it renders to the right of the chat pane (most of the window height, minus padding).
- On mobile/narrow windows it renders in a smaller area between the chat header and the messages, with messages fading behind it.
- Multiple visible stages share the available space — equal-height rows on wide screens, equal-width columns on narrow screens.

**System messages:** a stage can attach a *system message* to a chat message. These are shown to the human only (appended at the end of the relevant message) and are **never** sent to the LLM. This is how, e.g., a maze stage can display "Available directions: N, E" without confusing the model into hallucinating its own stat blocks — geometric/logical output the LLM would struggle to generate correctly is rendered by the stage instead.

---

## 4. Stage Lifecycle (StageBase Interface)

There are four **top-down** call points (Chub → your stage) plus one always-available render hook.

| Interface method | Chat lifecycle point | Purpose |
|---|---|---|
| `constructor` / `load` | Chat/stage initialization | Called once when a chat starts (or a stage rejoins a chat in progress). Receives info about the chat and participants. Returns `initState` (see State model, §5). |
| `beforePrompt` | Right before a user's message is sent to the LLM | Can modify the user's outgoing message, update/save internal state, append content to the prompt, and attach a system message to the user's turn. |
| `afterResponse` | Right after the LLM's response is fully received | Can modify the bot's response message, update/save internal state, and attach a system message to the bot's turn. |
| `setState` | User swipes or jumps to a previously-seen point in the chat tree | Receives the message-level state that was associated with that message so the UI can restore correctly (e.g., restoring a character's emotion in an expression pack). |
| `render` | Any time | Returns the `ReactElement` the stage actually displays. Avoid doing significant work here — it can be called frequently. |

### Bottom-up calls (Stage → Chub) — Experimental/Unstable

Your stage instance also has a `generator` member for calling out at will, e.g. `this.generator.someFunction()`.
Interface: `https://github.com/CharHubAI/chub-extensions-ts/blob/main/src/types/generation/service.ts`

- Only `makeImage`, `imageToImage`, `removeBackground`, and `inpaintImage` are currently implemented, and **none are considered stable**.
- Because these are ad-hoc, "back in a few seconds" generations, there's a quality tradeoff vs. a dedicated image-gen UI. Best results at a 1:1 aspect ratio.
- Do **not** `await` these inside any of the top-down lifecycle methods (constructor/load, beforePrompt, afterResponse) — timing isn't reliable yet.

---

## 5. State Model

Three kinds of state persist to Chub's database. Schemas for each are optional (you can define one in metadata, but it isn't required to use/persist state).

### Initialization State (`initState`)
- Anything generated **once, ever**, the first time the stage is instantiated in a chat.
- Returned at the end of `load`.
- Example: a procedurally generated maze layout — generated once per chat, never regenerated.
- On subsequent loads (user leaves & returns), the same init state is passed back in.

### Message State
- The most commonly used state type. The stage's state **as of a specific message** in the chat.
- Returned from `beforePrompt` and `afterResponse`.
- Also restored via `setState` on swipe/jump.
- Example: current player position in a maze; each character's current emotion.
- Anything that would intuitively feel "chat-wide" but is actually tied to a position in the conversation graph (e.g., the path traveled so far) belongs here, **not** in Chat State.

### Chat State
- Rare. Applies to the **entire chat, across all branches/swipes** — Chub represents conversation history as a graph, not a line, and this state type has no equivalent in most other chat UIs.
- Returned on `load`, `beforePrompt`, and `afterResponse`.
- Good fits: fog-of-war (tiles ever revealed across any branch), meta-commentary about swipe behavior.
- **Not** a good fit: health, position, paths traveled — these almost always belong in Message State. Rule of thumb from the docs: *"If you think something belongs here, it probably doesn't."*

### Example (maze stage), illustrating all three:

```ts
// Generated once per chat — never regenerated.
type InitStateType = {
    maze: MazeGrid;
};

// Where the player is right now, tied to a specific message.
type MessageStateType = {
    userLocation: { posX: number; posY: number };
    image: string | null;
};

// Applies across all branches of the chat.
type ChatStateType = {
    visited: { [key: number]: Set<number> };
};

type MazeGrid = MazeCell[][];

interface MazeCell {
    walls: { [key in MazeWall]: boolean };
    colNum: number;
    rowNum: number;
    visited: boolean; // internal generation-time flag, unrelated to ChatStateType.visited
}

enum MazeWall {
    down = 'down',
    right = 'right',
    up = 'up',
    left = 'left',
}
```

---

## 6. Config / Metadata (`public/chub_meta.yaml`)

Every stage ships a `public/chub_meta.yaml` with its name, description, tags, display **position** (see §3), and other metadata. The template's copy is annotated field-by-field:
`https://github.com/CharHubAI/extension-template/blob/main/public/chub_meta.yaml`

To let end users configure your stage (e.g., choosing a maze size), define a `config_schema` in the metadata. Chub auto-generates a settings form/UI from this schema.

- If you'd rather not write the schema as inline YAML, reference an external file instead:
  `config_schema: '@config.schema.json'` (file lives in `public/`).
- A schema demonstrating every supported feature:
  `https://github.com/CharHubAI/extension-integration-test/blob/main/public/config.schema.json` (see repo for exact path/branch).

---

## 7. Setup & Local Development

Two supported paths: **local machine** or **GitHub Codespaces**.

### Local
Requires Node **21.7.1** and `yarn`.

```bash
# install nvm first if needed (nvm-windows on Windows, nvm on mac/linux)
nvm install 21.7.1
nvm use 21.7.1

git clone https://github.com/CharHubAI/stage-template
cd stage-template
yarn install
yarn dev
```

- `yarn dev` runs the stage standalone in a browser tab using `src/TestRunner.tsx` (dev-only — no live chat, since one may not exist yet). Modify `TestRunner.tsx` and `src/assets/test-init.json` to exercise your own test scenarios.
- To test inside an actual chat, there's a separate run command (see the quickstart page: `https://docs.chub.ai/docs/stages/developing-a-stage/quickstart-setup`) — you'll need a real Chub chat to attach the dev build to.

### GitHub Codespaces
1. Go to `https://github.com/CharHubAI/stage-template` → **Use this template** → **Open in a codespace**.
2. In the Codespace terminal, run the same `yarn install` / `yarn dev` flow.
3. To publish: **Source Control** → **Publish Branch**. A link to the new project appears in a toast notification.

### Deploying / Publishing
- The template includes `.github/workflows/deploy.yml`, which builds and deploys the stage to Chub automatically on push to `main`.
- This requires a **write token**: get one from `https://chub.ai/my_stages?active=tokens`.
- In your GitHub repo: **Settings → Secrets and Variables → Actions → New repository secret**, name it `CHUB_AUTH_TOKEN`, and paste the token.
- Once configured, every push to `main` triggers a build that becomes live across web/iOS/Android/Vision Pro.

---

## 8. Reference Projects

- **Template:** https://github.com/CharHubAI/stage-template (formerly `extension-template`)
- **Extensions/stages source & library:** https://github.com/CharHubAI/chub-extensions-ts (superseded by `chub-stages-ts`)
- **Current stages TS package:** `@chub-ai/stages-ts` on npm — `npm i @chub-ai/stages-ts`
- **Generator (bottom-up API) interface:** `.../chub-extensions-ts/blob/main/src/types/generation/service.ts`
- **Expression pack example:** https://github.com/CharHubAI/expressions-extension
- **RPG example stage:** `CharHubAI/rpg-example-stage`
- **Full config schema example:** `CharHubAI/extension-integration-test` (`public/config.schema.json`)

---

## 9. Roadmap Context (as documented, subject to change)

Stages are explicitly in **beta**. Known gaps called out in the docs:
- **Full bidirectionality / multimedia:** letting a stage proactively request image/video/TTS generation rather than being response-only.
- **Scheduling:** letting a stage exist and act outside of an active chat (cron-like or threshold-triggered).
- Broader VR/AR support and non-React implementations.

---

## 10. Practical Checklist for This Repo

When building or reviewing a stage in this repo:

1. **Metadata first** — confirm `public/chub_meta.yaml` has correct name/description/tags, the right `position` value, and (if configurable) a valid `config_schema`.
2. **Implement `StageBase` in `Stage.tsx`** — `constructor`/`load` (→ `initState`), `beforePrompt`, `afterResponse`, `setState`, `render`. Keep `render` cheap/pure.
3. **Pick the right state bucket** for every piece of data: Init (once ever) vs. Message (per-message, most common) vs. Chat (rare, cross-branch only).
4. **Use system messages**, not the LLM prompt, for anything deterministic/computed that the model shouldn't be asked to reproduce (stat blocks, maze layouts, scoring).
5. **Avoid `await`ing `this.generator.*` calls** inside lifecycle methods — treat image-gen helpers as unstable/experimental only.
6. **Test locally** via `TestRunner.tsx` + `test-init.json` before pushing.
7. **Set `CHUB_AUTH_TOKEN`** as a repo secret so CI can deploy on push to `main`.
