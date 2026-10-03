import type { Stats } from 'node:fs'

type NativeJson = null | boolean | number | string | NativeJson[] | { [key: string]: NativeJson }
type NativeCoverageBlob = { table: NativeJson[]; coverage: { [sourcePath: string]: NativeJson }; digest: string }

export function assertDirectory(path: string, owner?: Pick<Stats, 'dev' | 'ino'>): Stats
export function assertRunTree(path: string): void
export function sourceIdentity(root: string): string
export function readNativeBlob(filePath: string, name: 'ordinary' | 'activity', root: string, startedAt: number, version: string): NativeCoverageBlob
export function admitCommonGeometry(ordinary: NativeCoverageBlob, activity: NativeCoverageBlob): void
