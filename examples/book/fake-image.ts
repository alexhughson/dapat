// A substitute for a paid image model. It is deterministic: the same request gives the same bytes.
// The colour comes from a hash of the prompt and of the image before, so a change to one image
// changes every image after it, as a model that copies the look of the last image would.
import { escapeHtml, type ImageRequest } from "./pipeline"

export async function drawImage(request: ImageRequest): Promise<Uint8Array> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(request.prompt)
  if (request.previous !== null) {
    hasher.update(request.previous)
  }
  const digest = hasher.digest("hex")
  const colour = digest.slice(0, 6)
  const promptLines = request.prompt.split("\n")
  const caption = promptLines[promptLines.length - 1]!
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
    `<rect width="400" height="300" fill="#${colour}"/>` +
    `<text x="20" y="150" font-size="14">${escapeHtml(caption)}</text>` +
    `</svg>\n`
  return new TextEncoder().encode(svg)
}
