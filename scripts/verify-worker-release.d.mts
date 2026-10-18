import type { WorkerSourceManifest } from './worker-source-manifest.mjs'
export type WorkerArtifactReceipt=WorkerSourceManifest & Readonly<{
  commit:string; image_id:string; platform:'linux/amd64'; run_id:string; archive_sha256:string; sbom_sha256:string
  checks:Readonly<{closure:boolean;registration:boolean;clean_exit:boolean;cleanup:boolean;archive_reload:boolean}>
}>
export function workerArtifactHashes(directory:string):Promise<WorkerSourceManifest & Readonly<{archive_sha256:string;sbom_sha256:string}>>
export function verifyWorkerArtifact(directory:string,commit:string,phase?:'candidate'|'release'):Promise<WorkerArtifactReceipt>
