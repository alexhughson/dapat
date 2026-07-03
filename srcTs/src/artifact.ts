import { readdir, stat } from "node:fs/promises";

export abstract class Artifact {
  constructor(public readonly id: string) {}

  get isPrefix(): boolean {
    return false;
  }

  abstract signature(): Promise<string | null>;
  abstract exists(): Promise<boolean>;

  matches(other: Artifact): boolean {
    if (this.id === other.id) return true;
    if (this.isPrefix && other.id.startsWith(this.id)) return true;
    if (other.isPrefix && this.id.startsWith(other.id)) return true;
    return false;
  }

  toString(): string {
    return this.id;
  }
}

export class FileArtifact extends Artifact {
  constructor(path: string) {
    super(path);
  }

  async signature(): Promise<string | null> {
    if (!(await this.exists())) return null;
    const file = Bun.file(this.id);
    const bytes = await file.arrayBuffer();
    return sha256Hex(new Uint8Array(bytes));
  }

  async exists(): Promise<boolean> {
    const file = Bun.file(this.id);
    return file.exists();
  }
}

export class DirectoryArtifact extends Artifact {
  constructor(path: string) {
    super(path.endsWith("/") ? path : `${path}/`);
  }

  override get isPrefix(): boolean {
    return true;
  }

  async signature(): Promise<string | null> {
    const dirPath = this.id.replace(/\/$/, "");
    try {
      const entries = await readdir(dirPath);
      entries.sort();
      return sha256Hex(new TextEncoder().encode(entries.join("\n")));
    } catch {
      return null;
    }
  }

  async exists(): Promise<boolean> {
    const dirPath = this.id.replace(/\/$/, "");
    try {
      const s = await stat(dirPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}

export class VirtualArtifact extends Artifact {
  constructor(
    id: string,
    private readonly sig: () => Promise<string | null> = async () => null
  ) {
    super(id);
  }

  async signature(): Promise<string | null> {
    return this.sig();
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

export function file(path: string): Artifact {
  return new FileArtifact(path);
}

export function directory(path: string): Artifact {
  return new DirectoryArtifact(path);
}

export function virtual(
  id: string,
  sig: () => Promise<string | null> = async () => null
): Artifact {
  return new VirtualArtifact(id, sig);
}

function sha256Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}
