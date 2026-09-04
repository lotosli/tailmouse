export interface BuildIdentity {
  readonly version: string;
  readonly tailcatRevision: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
}

declare const __TAILMOUSE_BUILD__: BuildIdentity;

// Vite injects verified Git metadata; unit tests inject a synthetic identity.
export const BUILD: BuildIdentity = Object.freeze(__TAILMOUSE_BUILD__);
