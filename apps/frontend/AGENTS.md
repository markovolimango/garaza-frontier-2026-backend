<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

- Live data flows only through the typed bus in src/signals; components subscribe to it and never import a source directly, so sources can be swapped in src/signals/index.ts.
- Screen-scoped colors are sampled once on mount and applied as inline custom properties (see src/signals/useJjMood.ts and moodOrbPalette), so a screen keeps one color for its whole visit instead of following a live channel.
- Debug reloads JJ by publishing a selected mood followed by a typed reload signal that remounts the screen, preserving the sample-on-mount behavior without reloading the whole app.
- Never create or modify anything under src/judges/ or public/judges/: a teammate builds the 3D judges directly in GitHub, so edits there collide with their commits. The JUDGES screen now integrates their handed-off scene; preserve /judges-demo.
- JudgesStage is a client-only adapter for the teammate's scene and useJudgesLive hook; Debug sends typed judgeCommand signals, keeping controls decoupled from the scene. The app defaults to mock/WebSpeech unless source=backend explicitly opts into the brain.
