declare module 'vscode' {
  export type Thenable<T> = Promise<T>;
  export interface Disposable { dispose(): any; }
  export interface ExtensionContext { subscriptions: Disposable[]; extensionPath: string; }
  export const workspace: any;
  export const window: any;
  export const commands: any;
  export const Uri: any;
  export const languages: any;
  export type Position = any;
  export type Range = any;
  export type TextDocument = any;
  export type CancellationToken = any;
  export type Diagnostic = any;
  export type DiagnosticCollection = any;
  export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;
  export type Event<T> = any;
  export type EventEmitter<T> = any;
  export function registerCommand(command: string, cb: any): any;
}