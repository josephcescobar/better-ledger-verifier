import { generateKeyPairSync } from "node:crypto";

// Prints a new Ed25519 key pair for signing verifier reports.
// Private key -> GitHub Actions secret VERIFIER_SIGNING_KEY (never anywhere else).
// Public key  -> the app's VERIFIER_PUBLIC_KEY env var (Stage E4).

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log("VERIFIER_SIGNING_KEY (secret):");
console.log(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
console.log("\nVERIFIER_PUBLIC_KEY (public):");
console.log(publicKey.export({ format: "der", type: "spki" }).toString("base64"));
