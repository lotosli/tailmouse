export interface BuildIdentity {
  readonly version: string;
  readonly tailcatRevision: string;
  readonly protocols: Readonly<{
    readonly escape: 1;
    readonly leash: 2;
  }>;
}

declare const __TAILMOUSE_BUILD__: BuildIdentity;

// Vite injects verified Git metadata; unit tests inject a synthetic identity.
export const BUILD: BuildIdentity = Object.freeze(__TAILMOUSE_BUILD__);
