import { BindOptions } from "./Container.js";
import { isLazy, lazy } from "./lazy.js";

type Provider<T> = (container: RuntimeContainer, classHint?: Function) => T;

export class RuntimeContainer {
  readonly #parent?: RuntimeContainer;
  readonly #providers = new Map<string, Provider<any>>();
  readonly #hints = new Map<string, Function>();
  readonly #bindings = new Map<string, string>();
  readonly #bindOptions = new Map<string, BindOptions>();

  readonly #makeStack: string[] = [];

  constructor(parent?: RuntimeContainer) {
    this.#parent = parent;
  }

  provide<T>(token: string, provider: Provider<T>, bindOptions?: BindOptions) {
    this.#providers.set(token, provider);
    if (bindOptions) {
      this.#bindOptions.set(token, bindOptions);
    } else {
      this.#bindOptions.delete(token);
    }
    return this;
  }

  #make<T>(token: string, container: RuntimeContainer, classHint?: Function): T {
    const binding = this.#bindings.get(token);
    if (binding) {
      return this.make(binding);
    }

    if (this.#makeStack.includes(token)) {
      return lazy<T>(() => this.make(token, classHint));
    }

    this.#makeStack.push(token);
    try {
      const provider = this.#providers.get(token);

      if (!provider) {
        if (this.#parent) {
          return this.#parent.#make(token, container, classHint);
        }
        throw new Error(`No provider for ${token.split("@").shift()!}`);
      }

      return provider(container, classHint ?? this.#hints.get(token));
    } finally {
      this.#makeStack.pop();
    }
  }

  #pool = new Map<string, unknown[]>();

  make<T>(token: string, classHint?: Function): T {
    const options = this.#bindOptions.get(token);

    const pool =
      options == null
        ? undefined
        : "singleton" in options
        ? 1
        : "pool" in options
        ? options.pool
        : undefined;

    if (pool != null && pool > 0) {
      let instances = this.#pool.get(token);
      if (instances == null) {
        this.#pool.set(token, (instances = []));
      }

      if (instances.length >= pool) {
        const instance = instances.pop()! as T;
        instances.unshift(instance);
        return instance;
      }
    }

    const result = this.#make<T>(token, this, classHint);

    if (pool != null && pool > 0) {
      const instances = this.#pool.get(token)!;
      if (!isLazy(result) && instances.length < pool) {
        instances.unshift(result);
      }
    }

    return result;
  }

  bind<A, C extends A>(
    bindOptions: BindOptions | undefined,
    abstractToken: string,
    concreteToken: string,
    concreteClassHint?: Function
  ) {
    if (abstractToken !== concreteToken) {
      this.#bindings.set(abstractToken, concreteToken);
    }
    if (concreteClassHint) {
      this.#hints.set(concreteToken, concreteClassHint);
    }
    if (bindOptions) {
      this.#bindOptions.set(abstractToken, bindOptions);
    } else {
      this.#bindOptions.delete(abstractToken);
    }
    return this;
  }

  inner(): RuntimeContainer {
    return new RuntimeContainer(this);
  }
}
