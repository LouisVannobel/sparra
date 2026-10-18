import type { Stats } from 'node:fs'

type NativeJson = null | boolean | number | string | NativeJson[] | { [key: string]: NativeJson }
type NativeCoverageBlob = { table: NativeJson[]; coverage: { [sourcePath: string]: NativeJson }; digest: string }
type MailRetryBuildConfig = { root: string; envDir: string | false; build: { outDir: string; copyPublicDir: boolean } }

export function assertDirectory(path: string, owner?: Pick<Stats, 'dev' | 'ino'>): Stats
export function assertMailRetryBuildConfig(root: string, output: string | undefined, config: MailRetryBuildConfig): void
export function readMailRetryBuildIdentity(buildDirectory: string, startedAt: number): string
export function assertRunTree(path: string): void
export function sourceIdentity(root: string): string
export function readNativeBlob(filePath: string, name: 'ordinary' | 'activity' | 'requests' | 'billing', root: string, startedAt: number, version: string): NativeCoverageBlob
export function admitCommonGeometry(ordinary: NativeCoverageBlob, activity: NativeCoverageBlob): void

export function assertRequestsReport(report: unknown, root: string): void
export function assertRequestsQualification(path: string, root: string, startedAt: number): void
export function assertRecordingReceiptReport(report: unknown, root: string): void
export function assertRecordingReceiptQualification(path: string, root: string, startedAt: number): void
export function assertMailRetryReport(report: unknown, root: string, startedAt: number): void
export function assertMailRetryQualification(path: string, root: string, startedAt: number, evidenceDirectory: string): void
/** Admits billing's eight exact consumers and 55 passing leaves. */
export function assertBillingReport(report: unknown, root: string): void
export function assertBillingQualification(path: string, root: string, startedAt: number): void
