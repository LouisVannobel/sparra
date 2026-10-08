export type PreparedVoiceSource=Readonly<{
  root:string;descriptor:Readonly<{pythonExecutable:string;sourceRoot:string}>;fixturePython:string
  testEnvironment:Readonly<{HOME:string;APPDATA:string}>
  assertIdentity:()=>Promise<void>;retire:()=>Promise<void>
}>
export function prepareVoiceSource(options:{appRoot:string;explicitRoot?:string|null;scopeParent?:string}):Promise<PreparedVoiceSource>
export function createVoiceSourceScope(parent:string,members?:Map<string,Buffer>):Promise<Readonly<{
  directory:string;root:string;install:(members:Map<string,Buffer>)=>Promise<void>;assertIdentity:()=>Promise<void>;retire:()=>Promise<void>
}>>
export function createVoiceTestHome(scope:string):Promise<Readonly<{
  environment:Readonly<{HOME:string;APPDATA:string}>;assertIdentity:()=>Promise<void>
}>>
export function environmentIdentity(root:string,sourceOnly?:boolean):Promise<string>
