# `autocontainer`

`autocontainer` is an [IoC](https://en.wikipedia.org/wiki/Inversion_of_control) container and
[DI](https://en.wikipedia.org/wiki/Dependency_injection) framework for TypeScript that relies
on a custom transformer pass to be able to use type information at runtime.

Because of the reliance on a custom transformer, it is required that the user uses
[`ttypescript`](https://github.com/cevek/ttypescript/tree/master) replacement executables instead
of the native TypeScript `tsc`/`tsserver` executables.

## Configuration

```json
{
  "compilerOptions": {
    "plugins": [
      { "transform": "autocontainer/dist/transformer.js" }
    ]
  }
}
```

## Usage

Let's start with some vanilla TypeScript declarations.

```typescript
import { Database } from "some-database-library";

// A perfectly normal TypeScript interface
interface UserRepository {
  getUsers(): AsyncIterable<User>;
}

// A class dependent on the interface
class UserController {
  readonly #repo: UserRepository;
  // ...
}

// An implementation of the interface using a third-party class
class DatabaseUserRepository implements UserRepository {
  readonly #database: Database;
  // ...
}
```

Given the above code, here's how we can use `autocontainer` to resolve the dependency graph.

First, we create an instance of the container:

```typescript
import { Container } from "autocontainer";

const container = Container.create();
```

We can provide implementations for arbitrary types. Here we're providing a singleton binding,
meaning the same instance will be reused anytime someone injects the type.

```typescript
import { Database } from "some-database-library";
container.provide<Database>(
  () => new Database("db://connection-string"),
  { singleton: true },
);
```

We can make a binding from an abstract type to a concrete one, by using the `bind` method.

```typescript
container.bind<UserRepository, DatabaseUserRepository>();
```

Now, we can use the `make` method to create an instance of `UserController`, which recursively
makes instances of all the dependencies of that class.

```typescript
const controller = container.make<UserController>();
```

Note how, as long as TypeScript knows the type argument provided to `make`, the transformer
is able to generate the correct code. So, thanks to the flow analysis of the TypeScript
compiler, we're sometimes able to omit the type argument. Here's an example.

```typescript
async function startServer(controller: UserController) {
  // ...
}

await startServer(container.make());
```
