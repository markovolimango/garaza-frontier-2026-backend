import { describe, expect, it } from "vitest";
import { agentNoteText } from "../../src/jj/messages.ts";

describe("agent notes to JJ", () => {
  it("tags the note with its agent once, even when the agent already tagged it", () => {
    expect(agentNoteText("body", "[BODY] arms crossed 3×")).toBe("[BODY] arms crossed 3×");
    expect(agentNoteText("director", "Q&A: 3 questions;\n dodged pricing")).toBe("[DIRECTOR] Q&A: 3 questions; dodged pricing");
  });
});
