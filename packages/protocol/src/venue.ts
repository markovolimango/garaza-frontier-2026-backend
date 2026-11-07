/** Venue package (spec: "Venue package"). Metres, +y up, origin on the floor at the podium. */
import { z } from "zod";
import { LightingPreset } from "./domain.ts";

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const Vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;
export type Vec4 = z.infer<typeof Vec4>;

export const Anchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), position: Vec3, facing: Vec3 }),
  z.object({ kind: z.literal("area"), polygon: z.array(z.tuple([z.number(), z.number()])).min(3), y: z.number() }),
]);
export type Anchor = z.infer<typeof Anchor>;

export const VenueDef = z.object({
  id: z.string().min(1),
  name: z.string(),
  backdrop: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("splat"), url: z.string(), position: Vec3, quaternion: Vec4, scale: z.number().positive() }),
    z.object({ kind: z.literal("pano"), url: z.string(), yawDeg: z.number() }),
    z.object({ kind: z.literal("greybox"), size: Vec3 }),
  ]),
  anchors: z.record(z.string(), Anchor),
  occluders: z.array(z.object({ kind: z.literal("box"), center: Vec3, size: Vec3, yawDeg: z.number() })),
  lighting: z.record(LightingPreset, z.object({ ambient: z.number().min(0), key: z.object({ dir: Vec3, intensity: z.number().min(0) }) })),
}).superRefine((v, ctx) => {
  for (const a of REQUIRED_ANCHORS) if (!v.anchors[a]) ctx.addIssue({ code: "custom", message: `venue lacks required anchor ${a}`, path: ["anchors", a] });
});
export type VenueDef = z.infer<typeof VenueDef>;

export const REQUIRED_ANCHORS = ["podium", "judge_seat_1", "judge_seat_2", "judge_seat_3", "audience_area"] as const;

/** The default room until a scan exists (spec example `venues/greybox/venue.json`). */
export const GREYBOX_VENUE: VenueDef = {
  id: "greybox", name: "Grey box room",
  backdrop: { kind: "greybox", size: [10, 3.2, 12] },
  anchors: {
    podium: { kind: "point", position: [0, 0, 0], facing: [0, 0, -1] },
    judge_seat_1: { kind: "point", position: [-1.4, 0, -4], facing: [0, 0, 1] },
    judge_seat_2: { kind: "point", position: [0, 0, -4.2], facing: [0, 0, 1] },
    judge_seat_3: { kind: "point", position: [1.4, 0, -4], facing: [0, 0, 1] },
    audience_area: { kind: "area", polygon: [[-4, 1.5], [4, 1.5], [4, 5], [-4, 5]], y: 0 },
  },
  occluders: [{ kind: "box", center: [0, 0.37, -3.5], size: [3.6, 0.75, 0.8], yawDeg: 0 }],
  lighting: {
    default: { ambient: 0.6, key: { dir: [0.3, -1, -0.4], intensity: 1.0 } },
    stage: { ambient: 0.35, key: { dir: [0, -1, 0.6], intensity: 1.4 } },
    dim: { ambient: 0.25, key: { dir: [0.3, -1, -0.4], intensity: 0.6 } },
  },
};
