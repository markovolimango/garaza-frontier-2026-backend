import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const JudgesDemo = lazy(() => import("@/judges/JudgesDemo").then((m) => ({ default: m.JudgesDemo })));

export const Route = createFileRoute("/judges-demo")({
  head: () => ({ meta: [
    { title: "Judges Demo — Pitch Practice" },
    { name: "description", content: "Test the four 3D judges, voices and reactions." },
    { property: "og:title", content: "Judges Demo — Pitch Practice" },
    { property: "og:description", content: "Test the four 3D judges, voices and reactions." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: () => (
    <ClientOnly>
      <Suspense fallback={null}>
        <JudgesDemo />
      </Suspense>
    </ClientOnly>
  ),
});
