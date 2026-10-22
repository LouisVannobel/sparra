export type WorkerSourceManifest = Readonly<{
  schema_version: 1; node_version: '24.22.1'; pnpm_version: '10.32.1'
  lock_sha256: string; dockerfile_sha256: string; source_sha256: string
}>
export function workerSourceManifest(root?: string): Promise<WorkerSourceManifest>
