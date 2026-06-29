// RepoRegistry: owns the in-memory map of repo local state.
// Callers get a RepoLocal from get() or ensure() and mutate it directly
// (lastFetch, lastHead, noteSource, setDivergencesForPeer).

export interface Divergence {
  peer: string;
  branch: string;
  replica_ref: string;
  their_sha: string;
}

export class RepoLocal {
  lastFetch: number | null = null;
  lastHead: string | null = null;
  sources: Set<string> = new Set();
  divergences: Divergence[] = [];

  noteSource(peer: string) {
    this.sources.add(peer);
  }
  sourceList(): string[] {
    return [...this.sources].sort();
  }
  divergenceList(): Divergence[] {
    return [...this.divergences];
  }
  setDivergencesForPeer(peer: string, next: Divergence[]) {
    this.divergences = [...this.divergences.filter((d) => d.peer !== peer), ...next];
  }
}

export class RepoRegistry {
  private repos: Map<string, RepoLocal> = new Map();

  private constructor() {}

  static create(): RepoRegistry {
    return new RepoRegistry();
  }

  get(name: string): RepoLocal | undefined {
    return this.repos.get(name);
  }

  has(name: string): boolean {
    return this.repos.has(name);
  }

  keys(): IterableIterator<string> {
    return this.repos.keys();
  }

  entries(): IterableIterator<[string, RepoLocal]> {
    return this.repos.entries();
  }

  /** Returns the existing entry or creates a new one. */
  ensure(name: string): RepoLocal {
    let r = this.repos.get(name);
    if (!r) {
      r = new RepoLocal();
      this.repos.set(name, r);
    }
    return r;
  }
}
