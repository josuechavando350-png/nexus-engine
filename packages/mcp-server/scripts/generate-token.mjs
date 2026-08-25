import { createHash, randomBytes } from "node:crypto";

const token = randomBytes(32).toString("hex");
const sha256 = createHash("sha256").update(token).digest("hex");
process.stdout.write(`token=${token}\nsha256=${sha256}\n`);
