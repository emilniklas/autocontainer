const lazies = new WeakSet<object>();

export function isLazy(value: any): boolean {
  return lazies.has(value);
}

export function lazy<T>(factory: () => T): T {
  let instance: any;
  let initialized = false;

  function get() {
    if (!initialized) {
      instance = factory();
    }
    return instance;
  }

  const proxy: T = new Proxy<T & object>({} as any, {
    apply(_, thisArg: any, argArray: any[]) {
      return Reflect.apply(get(), thisArg, argArray);
    },

    construct(_, argArray: any[], newTarget: Function) {
      return Reflect.construct(get(), argArray, newTarget);
    },

    defineProperty(
      _,
      property: string | symbol,
      attributes: PropertyDescriptor
    ) {
      return Reflect.defineProperty(get(), property, attributes);
    },

    deleteProperty(_, p: string | symbol) {
      return Reflect.deleteProperty(get(), p);
    },

    get(_, p: string | symbol, receiver: any) {
      const result = Reflect.get(
        get(),
        p,
        receiver === proxy ? get() : receiver
      );

      if (typeof result !== "function") {
        return result;
      }

      return new Proxy(result, {
        apply(f: any, thisArg: any, argArray: any[]) {
          return Reflect.apply(
            f,
            thisArg === proxy ? get() : thisArg,
            argArray
          );
        },
      });
    },

    getOwnPropertyDescriptor(_, p: string | symbol) {
      return Reflect.getOwnPropertyDescriptor(get(), p);
    },

    getPrototypeOf() {
      return Reflect.getPrototypeOf(get());
    },

    has(_, p: string | symbol) {
      return Reflect.has(get(), p);
    },

    isExtensible() {
      return Reflect.isExtensible(get());
    },

    ownKeys() {
      return Reflect.ownKeys(get());
    },

    preventExtensions() {
      return Reflect.preventExtensions(get());
    },

    set(_, p: string | symbol, newValue: any, receiver: any) {
      return Reflect.set(
        get(),
        p,
        newValue,
        receiver === proxy ? get() : receiver
      );
    },

    setPrototypeOf(_, v: object | null) {
      return Reflect.setPrototypeOf(get(), v);
    },
  });

  lazies.add(proxy as object);

  return proxy;
}
