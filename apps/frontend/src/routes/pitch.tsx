import { createFileRoute } from "@tanstack/react-router";
import { PitchMode } from "@/brain/PitchMode"; // brain integration: pitch mode (stage demo)

export const Route = createFileRoute("/pitch")({
  head: () => ({
    meta: [
      { title: "Pitch mode — Pitch Practice" },
      { name: "description", content: "Give your pitch; get the dashboard of how it went." },
    ],
  }),
  component: PitchMode,
});
