import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainSource } from "../brain/BrainSource";
import { MockSource } from "../signals/sources/MockSource";
import { openDeck, pptxTimingsFor } from "../brain/pptx";

afterEach(() => { vi.unstubAllGlobals(); });

const pptx = () => new File(["not really a pptx"], "acme.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });

describe("deck pickers (one path for JJ's screen and the presenter)", () => {
  it("a PDF goes straight on", async () => {
    const use = vi.fn(), say = vi.fn();
    const pdf = new File(["%PDF"], "deck.pdf", { type: "application/pdf" });
    await openDeck(pdf, use, say, new MockSource());
    expect(use).toHaveBeenCalledWith(pdf);
    expect(say).not.toHaveBeenCalled();
  });

  it("without the brain a .pptx can't be converted", async () => {
    const use = vi.fn(), say = vi.fn();
    await openDeck(pptx(), use, say, new MockSource());
    expect(use).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/need the brain/), "warn");
  });

  it("the brain converts a .pptx at its own address; the upload is in progress until the PDF is used", async () => {
    const brain = new BrainSource({ httpBase: "http://brain:9999", audio: false });
    let answer!: (r: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((r) => { answer = r; }));
    vi.stubGlobal("fetch", fetchMock);
    const used: File[] = [];
    const say = vi.fn();
    const first = openDeck(pptx(), async (pdf) => { used.push(pdf); expect(brain.getSnapshot().uploading).toBe(true); }, say, brain);
    expect(brain.getSnapshot().uploading).toBe(true);
    await openDeck(pptx(), (pdf) => used.push(pdf), say, brain);       // a second pick while converting
    expect(say).toHaveBeenLastCalledWith("A deck is already being uploaded", "warn");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["http://brain:9999/api/convert/pptx", expect.objectContaining({ method: "POST" })]);
    answer({ ok: true, blob: async () => new Blob(["%PDF"], { type: "application/pdf" }) });
    await first;
    expect(used.map((f) => f.name)).toEqual(["acme.pdf"]);
    expect(pptxTimingsFor.has("acme.pdf")).toBe(true);
    expect(brain.getSnapshot().uploading).toBe(false);
  });

  it("a failed conversion says why and ends the upload", async () => {
    const brain = new BrainSource({ httpBase: "http://b", audio: false });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ hint: "PowerPoint isn't installed" }) })));
    const use = vi.fn(), say = vi.fn();
    await openDeck(pptx(), use, say, brain);
    expect(use).not.toHaveBeenCalled();
    expect(say).toHaveBeenLastCalledWith("Couldn't convert the .pptx: PowerPoint isn't installed", "warn");
    expect(brain.getSnapshot().uploading).toBe(false);
  });
});
