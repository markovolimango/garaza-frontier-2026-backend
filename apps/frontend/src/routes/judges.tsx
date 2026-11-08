import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const JudgesStage = lazy(() => import("@/components/JudgesStage").then((m) => ({ default: m.JudgesStage })));

export const Route = createFileRoute("/judges")({
  head: () => ({
    meta: [
      { title: "Judges — Pitch Practice" },
      { name: "description", content: "Face the judges after your pitch." },
      { property: "og:title", content: "Judges — Pitch Practice" },
      { property: "og:description", content: "Face the judges after your pitch." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <ClientOnly>
      <Suspense fallback={null}>
        <JudgesStage />
      </Suspense>
    </ClientOnly>
  ),
});
