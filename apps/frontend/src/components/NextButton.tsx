import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const SCREENS = ["/", "/presenter", "/judges", "/report"] as const;
export type ScreenPath = (typeof SCREENS)[number];

export function NextButton({ to, label }: { to: ScreenPath; label: string }) {
  return (
    <Button variant="ghost" asChild>
      <Link to={to}>{label} →</Link>
    </Button>
  );
}
