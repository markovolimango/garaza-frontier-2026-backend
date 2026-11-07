import { createFileRoute } from "@tanstack/react-router";
import { NextButton } from "@/components/NextButton";

export const Route = createFileRoute("/judges")({
  head: () => ({
    meta: [
      { title: "Judges — Pitch Practice" },
      { name: "description", content: "Face the judges after your pitch." },
      { property: "og:title", content: "Judges — Pitch Practice" },
      { property: "og:description", content: "Face the judges after your pitch." },
    ],
  }),
  component: () => (
    <main className="flex h-screen flex-col items-center justify-center gap-10">
      <h1 className="text-8xl font-semibold tracking-tight">JUDGES</h1>
      <NextButton to="/report" label="Report" />
    </main>
  ),
});
