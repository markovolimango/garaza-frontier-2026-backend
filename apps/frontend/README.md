# Garaza Frontier 2026

Build a desktop web app skeleton (1920x1080, dark theme, minimal and sleek) for a pitch-practice tool. It's a loop of 4 screens: JJ -> PRESENTER -> JUDGES -> REPORT -> back to JJ. Navigation buttons on each screen move to the next one. Only build the skeleton + mocked live data; real data sources will be plugged in later.

ARCHITECTURE (most important):
- Create src/signals/ with a tiny typed event bus: subscribe(channel, cb) / publish(channel, value).
- Channels: "orbLevel" (number), "feedback" ({ color: "red" | "green" | "neutral", intensity: number 0..1 }), "slide" (number, current slide index).
- Create src/signals/sources/MockSource.ts that publishes random data: orbLevel as a smooth random walk ~20 times/sec; feedback as a random red/green/neutral event every 2–4 s with random intensity.
- Make sources swappable: one file src/signals/index.ts picks the active source (MockSource now; a placeholder WebSocketSource.ts with TODOs for later). Components ONLY read from the bus, never from the mock directly.

SCREENS:
1. JJ: a large glowing orb (soft gradient + glow, "AI assistant" vibe) in the centre. Subscribes to orbLevel. Props min and max (default 0..1): the orb's scale and glow intensity map the value from [min,max] smoothly (lerp, no jitter). Below: a placeholder transcript line and a "Start run" button.

2. PRESENTER: presenter view. Big current slide, smaller next-slide preview, a speaker-notes box, and a timer (set total duration, start/pause/reset, counts down and also shows elapsed; turns amber at 1 min left, red at 0). Publish the current slide index to "slide".
   Slides:
   - Upload a PDF (render with pdf.js). Arrow keys and prev/next buttons.
   - Optional second upload: the same deck as .pptx, used ONLY for timings. Unzip it with JSZip, read the advTm attribute (milliseconds) from <p:transition> in each ppt/slides/slideN.xml, and map it to slide N. Slides without advTm use the default.
   - Timings panel: list of slides, each with a duration (seconds) input; default = total time / slide count, overwritten by imported pptx timings; editable by hand. Save in localStorage keyed by PDF file name + page count.
   - "Rehearse" mode: I click through the slides and it records how long I stayed on each one as that slide's timing.
   - Auto-advance toggle uses the per-slide timings; manual arrows always override. Thin progress bar showing the current slide's elapsed vs. its timing.

3. JUDGES: blank page with big centred text "JUDGES".

4. REPORT: blank page with big centred text "REPORT DASHBOARD".

VIGNETTE: a full-screen overlay component (pointer-events: none, above everything) shown ONLY on PRESENTER and JUDGES. It subscribes to "feedback" and renders a radial-gradient vignette at the screen edges: red or green, opacity = intensity, fading smoothly (~600 ms); neutral = invisible. Keep red subtle (max opacity ~0.35), green up to ~0.45.

DEBUG: a small collapsible debug panel (bottom-right) showing live orbLevel, feedback and slide values, a toggle to pause the mock, and buttons to manually send red/green/neutral. Keyboard keys 1–4 jump between screens.

Keep the code clean and modular. No backend, no auth, no database.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ef6bd1fb-13bf-408e-a748-c181f4463b8a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
