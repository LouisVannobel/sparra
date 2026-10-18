import type { ExecFileOptions } from 'node:child_process'

type VerifiedReleaseArtifact = Readonly<{ image_id: string }>

export function candidateArguments(args: readonly string[]): Readonly<{
  directory: string
  commit: string
  imageId: string
  runId: string
}>

export function requireCheckoutCommit(commit: string,
  options: Readonly<Pick<ExecFileOptions, 'timeout' | 'windowsHide'>>): Promise<void>

export function runReleaseVerification(
  verify: (directory: string, commit: string) => Promise<VerifiedReleaseArtifact>,
  successMessage: string,
  failureMessage: string,
): Promise<void>
