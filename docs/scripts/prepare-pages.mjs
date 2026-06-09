import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(process.cwd(), ".output", "public");
const indexPath = join(publicDir, "index.html");
const fallbackPath = join(publicDir, "404.html");

if (!existsSync(indexPath)) {
  throw new Error(`Missing GitHub Pages entry file: ${indexPath}`);
}

copyFileSync(indexPath, fallbackPath);
writeFileSync(join(publicDir, ".nojekyll"), "", "utf8");
