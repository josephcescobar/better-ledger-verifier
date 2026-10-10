import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// The signed result of a run (Stage E3). The app (Stage E4/E5) will accept
// a report only if it verifies against the verifier's public key, so a
// compromised app or database can't fake a green verifier.
// VERIFIER_SIGNING_KEY is a base64 PKCS#8 Ed25519 private key from
// `npm run keygen`; the public half goes to the app.

export type SignedReport = { report: string; signature: string; public_key: string };

export function signReport(report: object, privateKeyB64: string): SignedReport {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const body = JSON.stringify(report);
  return {
    report: body,
    signature: sign(null, Buffer.from(body), key).toString("base64"),
    public_key: createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export function verifyReport(signed: SignedReport, publicKeyB64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(signed.report), key, Buffer.from(signed.signature, "base64"));
}
