import { createHash } from "node:crypto";

// Incremental version of mmrRoot() in vendor/trees.ts, so the verifier can
// read the root after every row in one pass instead of rebuilding the tree
// for each anchor. test/mmr.test.ts proves it matches mmrRoot() exactly.

const sha = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

export class Mmr {
  private peaks: { hash: Buffer; height: number }[] = [];

  append(rowHash: Buffer): void {
    let node = { hash: sha(Buffer.from([0x00]), Buffer.from("BTRMMR"), rowHash), height: 0 };
    while (this.peaks.length && this.peaks[this.peaks.length - 1].height === node.height) {
      const left = this.peaks.pop()!;
      node = { hash: sha(Buffer.from([0x01]), left.hash, node.hash), height: node.height + 1 };
    }
    this.peaks.push(node);
  }

  root(): Buffer {
    if (!this.peaks.length) return Buffer.alloc(32);
    let acc = this.peaks[this.peaks.length - 1].hash;
    for (let i = this.peaks.length - 2; i >= 0; i--) acc = sha(Buffer.from([0x02]), this.peaks[i].hash, acc);
    return acc;
  }
}
