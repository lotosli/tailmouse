// Unit tests model only the platform base constructor. Runtime integration uses workerd.
export class DurableObject {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}
}
