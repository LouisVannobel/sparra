export type WebSourceManifest = Readonly<{schema_version:1;lock_sha256:string;dockerfile_sha256:string;launcher_sha256:string}>
export function webSourceManifest():Promise<WebSourceManifest>
