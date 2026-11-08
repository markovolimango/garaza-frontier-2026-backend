import { createFileRoute } from "@tanstack/react-router";
import { NextButton } from "@/components/NextButton";

export const Route = createFileRoute("/report")({
  head: () => ({
    meta: [
      { title: "Report Dashboard — Pitch Practice" },
      { name: "description", content: "Review how your pitch practice went." },
      { property: "og:title", content: "Report Dashboard — Pitch Practice" },
      { property: "og:description", content: "Review how your pitch practice went." },
    ],
  }),
  component: () => (
    <main className="flex h-screen flex-col items-center justify-center gap-10">
      <h1 className="text-8xl font-semibold tracking-tight">REPORT DASHBOARD</h1>
      <NextButton to="/" label="Back to JJ" />
    </main>
  ),
});
