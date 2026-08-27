const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);

function stripContentImages(container: Record<string, unknown>, key: string): number {
  const content = container[key];
  if (!Array.isArray(content)) return 0;
  const filtered = content.filter((block) =>
    !block || typeof block !== "object" || !IMAGE_TYPES.has(String((block as { type?: unknown }).type)),
  );
  const removed = content.length - filtered.length;
  if (removed) container[key] = filtered.length ? filtered : "";
  return removed;
}

/** 仅处理 Anthropic/OpenAI 的明确 content 契约，不递归扫描无关业务字段。 */
export function stripUnsupportedImages(
  body: Record<string, unknown>,
  supportsImages: boolean | undefined,
): number {
  if (supportsImages !== false) return 0;
  let removed = 0;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === "object" && !Array.isArray(message)) {
        removed += stripContentImages(message as Record<string, unknown>, "content");
      }
    }
  }
  return removed + stripContentImages(body, "system");
}
