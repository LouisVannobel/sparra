export type PreparedVoiceSource=Readonly<{
  root:string;descriptor:Readonly<{pythonExecutable:string;sourceRoot:string}>;fixturePython:string
  testEnvironment:Readonly<{HOME:string;APPDATA:string;NLTK_DATA:string}>;tokenizerArchive:string
  assertIdentity:()=>Promise<void>;retire:()=>Promise<void>
}>
export function prepareVoiceSource(options:{appRoot:string;explicitRoot?:string|null;scopeParent?:string}):Promise<PreparedVoiceSource>
export function createVoiceSourceScope(parent:string,members?:Map<string,Buffer>):Promise<Readonly<{
  directory:string;root:string;install:(members:Map<string,Buffer>)=>Promise<void>;assertIdentity:()=>Promise<void>;retire:()=>Promise<void>
}>>
export function installVoiceTokenizer(scope:string,pythonExecutable:string,archive:Buffer):Promise<Readonly<{HOME:string;APPDATA:string;NLTK_DATA:string}>>
