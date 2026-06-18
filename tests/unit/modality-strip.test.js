import { describe, it, expect } from "vitest";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const NO_VISION = { vision: false, audioInput: true, pdf: true };
const NO_AUDIO = { vision: true, audioInput: false, pdf: true };
const NO_PDF = { vision: true, audioInput: true, pdf: false };
const ALL = { vision: true, audioInput: true, pdf: true };

describe("stripUnsupportedModalities", () => {
  it("fast-exits when model supports all modalities", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, ALL)).toBe(false);
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("openai: strips image when vision:false, leaves placeholder", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(result).toBe(true);
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).toContain("text");
    expect(types).not.toContain("image_url");
    expect(body.messages[0].content.some((b) => b.type === "text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("openai: strips input_audio when audioInput:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "input_audio", input_audio: { data: "x", format: "wav" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(result).toBe(true);
    expect(body.messages[0].content.some((b) => b.type === "input_audio")).toBe(false);
    expect(body.messages[0].content.some((b) => /audio omitted/.test(b.text || ""))).toBe(true);
  });

  it("openai: strips file when pdf:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "file", file: { filename: "d.pdf", file_data: "data:application/pdf;base64,x" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_PDF);
    expect(result).toBe(true);
    expect(body.messages[0].content.some((b) => b.type === "file")).toBe(false);
  });

  it("openai: keeps image when vision:true", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(result).toBe(false);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(true);
  });

  it("returns false when model lacks audio/pdf but request has only images (vision:true)", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ] }] };
    const caps = { vision: true, audioInput: false, pdf: false };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
    expect(result).toBe(false);
    expect(body.messages[0].content).toHaveLength(2);
  });

  it("claude: strips image + document by capability", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: false });
    expect(result).toBe(true);
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).not.toContain("image");
    expect(types).not.toContain("document");
    expect(types).toContain("text");
  });

  it("gemini: strips inlineData image by mime when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { text: "hi" },
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(result).toBe(true);
    expect(body.contents[0].parts.some((p) => p.inlineData)).toBe(false);
    expect(body.contents[0].parts.some((p) => /image omitted/.test(p.text || ""))).toBe(true);
  });

  it("gemini: keeps inlineData pdf when pdf:true, strips image when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
      { inlineData: { mimeType: "application/pdf", data: "y" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(result).toBe(true);
    const mimes = body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.mimeType);
    expect(mimes).toEqual(["application/pdf"]);
  });

  it("antigravity: strips inside request.contents", () => {
    const body = { request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] } };
    const result = stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION);
    expect(result).toBe(true);
    expect(body.request.contents[0].parts.some((p) => p.inlineData)).toBe(false);
  });

  it("responses: strips input_image when vision:false", () => {
    const body = { input: [{ role: "user", content: [
      { type: "input_text", text: "hi" },
      { type: "input_image", image_url: "data:image/png;base64,x" },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION);
    expect(result).toBe(true);
    expect(body.input[0].content.some((b) => b.type === "input_image")).toBe(false);
    expect(body.input[0].content.some((b) => b.type === "input_text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("handles missing/empty body safely", () => {
    expect(stripUnsupportedModalities(null, FORMATS.OPENAI, NO_VISION)).toBe(false);
    expect(stripUnsupportedModalities({}, FORMATS.OPENAI, null)).toBe(false);
    expect(stripUnsupportedModalities({ messages: [] }, FORMATS.OPENAI, NO_VISION)).toBe(false);
  });

  it("openai: returns true when only one of multiple messages has strippable content", () => {
    const body = { messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
      ] },
    ] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(result).toBe(true);
    expect(body.messages[0].content).toBe("Hello");
    expect(body.messages[1].content).toBe("Hi there");
    expect(body.messages[2].content.some((b) => b.type === "image_url")).toBe(false);
    expect(body.messages[2].content.some((b) => /image omitted/.test(b.text || ""))).toBe(true);
  });

  it("openai: skips string content (non-array) and returns false when no arrays have media", () => {
    const body = { messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ] };
    const result = stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(result).toBe(false);
    expect(body.messages[0].content).toBe("You are a helpful assistant.");
    expect(body.messages[1].content).toBe("Hello");
  });

  it("default format: falls through to stripOpenAI for unknown sourceFormat", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "x" } },
    ] }] };
    const result = stripUnsupportedModalities(body, "unknown-format", NO_VISION);
    expect(result).toBe(true);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(false);
  });

  it("gemini: strips fileData image by mime when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { text: "describe this" },
      { fileData: { mimeType: "image/jpeg", fileUri: "gs://bucket/img.jpg" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(result).toBe(true);
    expect(body.contents[0].parts.some((p) => p.fileData)).toBe(false);
    expect(body.contents[0].parts.some((p) => /image omitted/.test(p.text || ""))).toBe(true);
  });

  it("gemini: keeps fileData audio when audioInput:true, strips when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { fileData: { mimeType: "image/png", fileUri: "gs://bucket/img.png" } },
      { fileData: { mimeType: "audio/wav", fileUri: "gs://bucket/audio.wav" } },
    ] }] };
    const result = stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(result).toBe(true);
    const mimes = body.contents[0].parts.filter((p) => p.fileData).map((p) => p.fileData.mimeType);
    expect(mimes).toEqual(["audio/wav"]);
  });

  it("antigravity: returns false when body.request is missing", () => {
    const body = { other: "data" };
    const result = stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION);
    expect(result).toBe(false);
  });
});
