export type VoiceSourceMember = Readonly<{path:string;size:number;git_blob:string;sha256:string}>
export type VoiceSourceManifest = Readonly<{
  repository:string;commit:string;tree:string;owned_ref:string;input_roots:readonly string[]
  archive_sha256:string;archive_size:number;decoded_source_bytes:number
  members:readonly VoiceSourceMember[]
}>
export function readVoiceSourceFixture(archive:Buffer,manifest:VoiceSourceManifest,pythonExecutable:string):Promise<{
  commit:string;tree:string;members:Map<string,Buffer>
}>
