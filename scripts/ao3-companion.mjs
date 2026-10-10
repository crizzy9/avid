import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAo3Companion } from "../packages/integrations/companion/ao3Server.ts";

const pairingFile = process.env.AVID_AO3_PAIRING_FILE;
const pairingToken = pairingFile
  ? readFileSync(pairingFile, "utf8").trim()
  : randomBytes(24).toString("hex");
const origins = (
  process.env.AVID_AO3_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const port = Number(process.env.AVID_AO3_PORT ?? 43119);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("AVID_AO3_PORT must be between 1024 and 65535.");
const publicOrigin = process.env.AVID_AO3_PUBLIC_ORIGIN;
const trustedProxyAddress = process.env.AVID_AO3_TRUSTED_PROXY;
if (Boolean(publicOrigin) !== Boolean(trustedProxyAddress))
  throw new Error(
    "HTTPS deployment requires both AVID_AO3_PUBLIC_ORIGIN and AVID_AO3_TRUSTED_PROXY.",
  );
const server = createAo3Companion({
  pairingToken,
  origins,
  ...(publicOrigin ? { proxy: { publicOrigin, trustedProxyAddress } } : {}),
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Avid AO3 companion: http://127.0.0.1:${port}`);
  if (publicOrigin) console.log(`HTTPS companion origin: ${publicOrigin}`);
  console.log(
    pairingFile
      ? "Pairing credential loaded from the configured secret file."
      : `Pairing code (this run only): ${pairingToken}`,
  );
  console.log(`Allowed Avid origins: ${origins.join(", ")}`);
  console.log(
    "AO3 credentials and cookies remain in memory. Stop this process to clear every session.",
  );
});
