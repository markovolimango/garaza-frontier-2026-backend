# CLAUDE.md

Monorepo for the AI Presentation Coach. See README.md for layout, setup and commands.

- Backend: `apps/brain` (Node/TS, :8787). Frontend: `apps/frontend` (Vite/React, :5174). Shared message
  schemas: `packages/protocol`. A protocol change touches all three.
- Both backend and frontend are editable here. `apps/frontend/CLAUDE.md` and `apps/frontend/AGENTS.md` are from
  the Lovable repo's hackathon days: ignore their claims that the backend is read-only, that `../backend` exists, or
  about low usage. Their notes on the frontend's structure still apply.
- `apps/frontend` is a git subtree of the Lovable repo (`pnpm frontend:pull`). Our integration lives in
  `apps/frontend/src/brain/`. Never push to the Lovable repo's `main`.
- Package manager: pnpm (`corepack enable`). `apps/frontend/bun.lock` belongs to Lovable; leave it.
- Before committing: `pnpm typecheck && pnpm test && pnpm test:frontend`.
- Record new interfaces, messages or config keys in `docs/extensions.md`.
