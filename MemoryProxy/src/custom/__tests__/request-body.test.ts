import { describe, expect, it } from "vitest";
import { stripUnsupportedImages } from "../request-body.js";

describe("stripUnsupportedImages", () => {
  it("纯图片消息剥完 → 文本占位块（空 content 会被上游 400）", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
    expect(stripUnsupportedImages(body, false)).toBe(1);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "[image removed]" }]);
  });

  it("混合内容只剥图片块", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image" }] }] };
    stripUnsupportedImages(body, false);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("supportsImages 非 false → 原样不动", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image" }] }] };
    expect(stripUnsupportedImages(body, true)).toBe(0);
    expect(stripUnsupportedImages(body, undefined)).toBe(0);
  });

  it("字符串 content 不处理", () => {
    const body = { messages: [{ role: "user", content: "纯文本" }] };
    expect(stripUnsupportedImages(body, false)).toBe(0);
  });
});
