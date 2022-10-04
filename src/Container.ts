import { RuntimeContainer } from "./RuntimeContainer.js";

export interface Container {
  inner(): Container;

  make<T>(): T;

  provide<T>(
    f: (container: Container) => T,
    options: SingletonBindOptions
  ): this;
  provide<T>(f: (container: Container) => T, options: PoolBindOptions): this;
  provide<T>(f: (container: Container) => T): this;

  bind<A, C extends A = A>(options: SingletonBindOptions): this;
  bind<A, C extends A = A>(options: PoolBindOptions): this;
  bind<A, C extends A = A>(): this;
}

export type BindOptions = SingletonBindOptions | PoolBindOptions;

export interface SingletonBindOptions {
  singleton: boolean;
}

export interface PoolBindOptions {
  pool: number;
}

export namespace Container {
  export function create(): Container {
    return new RuntimeContainer() as any;
  }
}
