import { createFileRoute, Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { Orb } from "@/components/Orb";
import { JjLyrics } from "@/components/JjLyrics";
import { NextButton } from "@/components/NextButton";
import { Button } from "@/components/ui/button";
import { moodOrbPalette } from "@/signals/mood";
import { useJjMood } from "@/signals/useJjMood";
import { useSignal } from "@/signals/useSignal";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "JJ — Pitch Practice" },
      { name: "description", content: "Meet JJ, your AI pitch coach. Start a practice run." },
      { property: "og:title", content: "JJ — Pitch Practice" },
      { property: "og:description", content: "Meet JJ, your AI pitch coach. Start a practice run." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: JJ,
});

function JJ() {
  const reload = useSignal("jjReload");
  return <JJScreen key={reload ?? 0} />;
}

function JJScreen() {
  // Sampled once on load: JJ keeps this color for the whole visit.
  const mood = useJjMood();
  const palette = moodOrbPalette(mood);

  return (
    <main
      className="jj-scene relative flex h-screen flex-col items-center justify-center gap-12"
      style={{
        "--orb-a": palette.a,
        "--orb-b": palette.b,
        "--orb-c": palette.c,
        "--orb-hi": palette.hi,
      } as CSSProperties}
    >
      <span className="absolute left-8 top-6 font-serif text-sm text-muted-foreground">JJ</span>
      <Orb />
      <JjLyrics />
      <Button size="lg" asChild>
        <Link to="/presenter">Start run</Link>
      </Button>
      <div className="absolute bottom-6 left-8">
        <NextButton to="/presenter" label="Presenter" />
      </div>
    </main>
  );
}
