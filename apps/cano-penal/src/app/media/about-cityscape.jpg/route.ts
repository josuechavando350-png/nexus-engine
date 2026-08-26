import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const image = await readFile(path.join(process.cwd(), "about-cityscape.jpg"));

  return new Response(image, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/jpeg"
    }
  });
}
