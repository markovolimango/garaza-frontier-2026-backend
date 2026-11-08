# AI Presentation Coach

Rehearse a talk with JJ, a voice coach, and a panel of AI judges. One web app plus a Node
brain; see the spec (`AI Presentation Coach — Component & Interface Spec.md`) for the system.

- **[docs/integration.md](docs/integration.md)**: how the components fit together and where each lane plugs in.
- **[docs/extensions.md](docs/extensions.md)**: every addition beyond the spec, with timestamps. Record yours there before merging.
- **[apps/brain/src/jj/VERIFY.md](apps/brain/src/jj/VERIFY.md)**: checking JJ against real Gemini Live.

```bash
corepack pnpm install
cp .env.example .env               # JJ_FAKE=1 runs without a Gemini key
corepack pnpm test && corepack pnpm typecheck
corepack pnpm dev:brain            # brain on :8787
corepack pnpm dev:frontend         # Lovable app on :5174, wired to the brain
```

The main app is built in Lovable in a separate repo and carried here as a git subtree at
`apps/frontend`; pull new Lovable commits with `pnpm frontend:pull` (docs/integration.md §14).

| Path | Lane | |
| --- | --- | --- |
| `packages/protocol` | lead | schemas, types, message catalogue |
| `apps/brain` | brain, agents, sensing | hub, session, JJ, mic routing |
| `apps/frontend` | stage (Lovable) | the main app; `src/brain/` is our integration layer |
| `apps/web` | stage, sensing, brain | `src/net`: the shared WS client |
| `fixtures/` | all | message samples (generated), later pose/audio/sessions |
