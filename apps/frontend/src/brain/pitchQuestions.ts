/**
 * The judges' questions shown on the pitch dashboard (PitchMode.tsx, "Judges' questions" / key Q).
 * Baked: picked from what our director agent asked about this pitch in rehearsal (director/prompts.ts),
 * lightly shortened. Edit freely; one entry per judge.
 */
export const PITCH_QUESTIONS: { judge: string; text: string }[] = [
  { judge: "VC investor", text: "You say filler words dropped by half. How do you measure real improvement in persuasion, beyond verbal tics?" },
  { judge: "Startup mentor", text: "Are you selling to individual students, or licensing the software to universities and accelerators?" },
  { judge: "Technical expert", text: "How do you run transcription and video analysis live on a normal laptop without lag or overheating?" },
  { judge: "Customer advocate", text: "What is the biggest challenge for users when they first start training with JJ?" },
];
