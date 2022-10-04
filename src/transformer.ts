import * as ts from "typescript";
import { Container } from "./Container.js";
import { resolve } from "node:path";

type Debuggable =
  | ts.Node
  | ts.Symbol
  | ts.Type
  | Iterable<Debuggable>
  | undefined;

type ContainerMethodName = keyof Container | keyof typeof Container;

const CONSTRUCTOR_PARAM_TYPES_STATIC_PROP_NAME =
  "$autocontainer__constructorParamClassTypes";

class InvalidInvocationError extends Error {
  readonly call: ts.CallExpression;

  constructor(call: ts.CallExpression, message?: string) {
    super(
      `Invalid invocation: ${ts
        .createPrinter({ newLine: ts.NewLineKind.LineFeed })
        .printNode(ts.EmitHint.Expression, call, call.getSourceFile())}` +
        (message ? `: ${message}` : "")
    );
    this.call = call;
  }
}

class InvalidReferenceError extends Error {
  readonly reference: ts.Expression;

  constructor(reference: ts.Expression, message?: string) {
    super(
      `Invalid reference: ${ts
        .createPrinter({ newLine: ts.NewLineKind.LineFeed })
        .printNode(
          ts.EmitHint.Expression,
          reference,
          reference.getSourceFile()
        )}` + (message ? `: ${message}` : "")
    );
    this.reference = reference;
  }
}

class CannotMakeTypeParameterError extends Error {
  readonly type: ts.Type;
  readonly node?: ts.Node;

  constructor(type: ts.Type, checker: ts.TypeChecker, node?: ts.Node) {
    super(`Cannot make type parameter: ${checker.typeToString(type)}`);
    this.type = type;
    this.node = node;
  }
}

class MakeTargetCollector {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #printer: ts.Printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
  });

  constructor(program: ts.Program) {
    this.#program = program;
    this.#checker = program.getTypeChecker();
  }

  #findContainerDeclaration():
    | [iface: ts.InterfaceDeclaration, module: ts.ModuleDeclaration]
    | undefined {
    const sourceFile = this.#program
      .getSourceFiles()
      .find((p) => p.fileName.endsWith("/autocontainer/dist/Container.d.ts"));

    if (sourceFile == null) {
      return undefined;
    }

    let iface: ts.InterfaceDeclaration | undefined;
    let mod: ts.ModuleDeclaration | undefined;
    for (const node of this.#iterate(sourceFile)) {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "Container") {
        iface = node;
      } else if (
        ts.isModuleDeclaration(node) &&
        node.name.text === "Container"
      ) {
        mod = node;
      }
      if (iface && mod) {
        return [iface, mod];
      }
    }
  }

  *#iterate(node: ts.Node): IterableIterator<ts.Node> {
    yield node;

    for (const child of node.getChildren()) {
      yield* this.#iterate(child);
    }
  }

  *#findStaticMethods(
    mod: ts.ModuleDeclaration
  ): IterableIterator<ts.FunctionDeclaration> {
    for (const node of this.#iterate(mod)) {
      if (ts.isFunctionDeclaration(node)) {
        yield node;
      }
    }
  }

  *#findMethods(
    iface: ts.InterfaceDeclaration
  ): IterableIterator<ts.MethodSignature> {
    for (const member of iface.members) {
      if (ts.isMethodSignature(member)) {
        yield member;
      }
    }
  }

  *#findContainerMethods(): IterableIterator<ts.SignatureDeclarationBase> {
    const dec = this.#findContainerDeclaration();
    if (dec == null) {
      return;
    }
    const [iface, mod] = dec;
    yield* this.#findStaticMethods(mod);
    yield* this.#findMethods(iface);
  }

  #debuggableToString(value: Debuggable): string {
    if (value == null) {
      return "undefined";
    }
    if ("getEnd" in value) {
      return this.#printer.printNode(
        ts.EmitHint.Unspecified,
        value,
        value.getSourceFile()
      );
    }
    if ("escapedName" in value) {
      return this.#checker.symbolToString(value);
    }
    if ("symbol" in value) {
      return this.#checker.typeToString(value);
    }
    return (
      "[\n" +
      Array.from(value, this.#debuggableToString.bind(this)).join(",\n") +
      "]"
    );
  }

  #debug(value: Debuggable) {
    console.log(this.#debuggableToString(value));
  }

  *#findModulesSubjectToContainerReferences(): IterableIterator<ts.SourceFile> {
    const wd = process.cwd();
    for (const sourceFile of this.#program.getSourceFiles()) {
      if (sourceFile.fileName.includes("node_modules")) {
        continue;
      }

      if (sourceFile.fileName.startsWith(wd)) {
        yield sourceFile;
      }
    }
  }

  *#findReferencesToSignature(
    signature: ts.SignatureDeclarationBase
  ): IterableIterator<ts.PropertyAccessExpression> {
    for (const sourceFile of this.#findModulesSubjectToContainerReferences()) {
      for (const node of this.#iterate(sourceFile)) {
        if (ts.isPropertyAccessExpression(node)) {
          if (
            this.#checker
              .getSymbolAtLocation(node.name)
              ?.declarations?.includes(signature)
          ) {
            yield node;
          }
        }
      }
    }
  }

  #isNamedDeclaration(dec: ts.Declaration): dec is ts.NamedDeclaration {
    return "name" in dec;
  }

  #makePersistentDeclarationId(dec: ts.NamedDeclaration): string {
    return (
      (dec.name?.getText() ?? "anonymous") +
      "@" +
      dec.getSourceFile().fileName.replace(process.cwd() + "/", "") +
      ":" +
      dec.getStart()
    );
  }

  #makePersistentTypeId(type: ts.Type): string {
    if (type.isUnion()) {
      return type.types.map(this.#makePersistentTypeId.bind(this)).join(" | ");
    }

    if (type.isIntersection()) {
      return type.types.map(this.#makePersistentTypeId.bind(this)).join(" & ");
    }

    if (type.isLiteral()) {
      return type.value.toString();
    }

    if (type.isClassOrInterface()) {
      return (
        type.symbol.declarations
          ?.filter(this.#isNamedDeclaration.bind(this))
          .map(this.#makePersistentDeclarationId.bind(this))
          .join(",") || "unknown"
      );
    }

    return "unknown";
  }

  #makeTargets = new Map<
    string,
    {
      type: ts.Type;
      references: ts.Expression[];
    }
  >();

  #registerMakeTarget(type: ts.Type, reference?: ts.Expression) {
    if ((type as any).isTypeParameter()) {
      throw new CannotMakeTypeParameterError(type, this.#checker, reference);
    }

    const id = this.#makePersistentTypeId(type);

    let record = this.#makeTargets.get(id);
    if (record == null) {
      this.#makeTargets.set(
        id,
        (record = {
          type,
          references: [],
        })
      );

      if (type.isClass()) {
        type.symbol.declarations
          ?.find(ts.isClassDeclaration)
          ?.members.find(ts.isConstructorDeclaration)
          ?.parameters.map((p) => p.type)
          .filter((p): p is NonNullable<typeof p> => Boolean(p))
          .map(this.#checker.getTypeFromTypeNode.bind(this))
          .forEach((t) => this.#registerMakeTarget(t));
      }
    }

    if (reference) {
      record.references.push(reference);
    }
  }

  #collectContainerMethods(): Map<
    ContainerMethodName,
    ts.SignatureDeclarationBase
  > {
    const o = new Map<ContainerMethodName, ts.SignatureDeclarationBase>();
    for (const method of this.#findContainerMethods()) {
      const k = method.name!.getText() as any;
      o.set(k, method);
    }
    return o;
  }

  #registerMakeTargets(
    containerMethods: Map<ContainerMethodName, ts.SignatureDeclarationBase>
  ) {
    for (const [name, signature] of containerMethods) {
      switch (name) {
        case "make":
          for (const ref of this.#findReferencesToSignature(signature)) {
            this.#registerMakeTarget(
              this.#checker.getTypeAtLocation(ref.parent),
              ref
            );
          }
          break;

        case "bind":
          for (const ref of this.#findReferencesToSignature(signature)) {
            const call = ref.parent;
            if (ts.isCallExpression(call)) {
              if (call.typeArguments == null) {
                throw new InvalidInvocationError(
                  call,
                  "Explicit type arguments are required."
                );
              }
              for (const arg of call.typeArguments) {
                this.#registerMakeTarget(
                  this.#checker.getTypeFromTypeNode(arg),
                  ref
                );
              }
            } else {
              throw new InvalidReferenceError(ref);
            }
          }
          break;

        case "provide":
          for (const ref of this.#findReferencesToSignature(signature)) {
            if (ts.isCallExpression(ref.parent)) {
              const call = ref.parent;
              if (
                call.typeArguments == null ||
                call.typeArguments.length !== 1
              ) {
                throw new InvalidInvocationError(
                  call,
                  "Explicit type argument is required."
                );
              }
              this.#registerMakeTarget(
                this.#checker.getTypeAtLocation(call.typeArguments[0]),
                ref
              );
            } else {
              throw new InvalidReferenceError(ref);
            }
          }
          break;
      }
    }
  }

  collect() {
    const containerMethods = this.#collectContainerMethods();

    this.#registerMakeTargets(containerMethods);

    return new CollectedMakeTargets(
      this.#checker,
      this.#makeTargets,
      new Map(
        Array.from(containerMethods, ([name, declaration]) => {
          const references = new Set(
            this.#findReferencesToSignature(declaration)
          );
          return [name, { declaration, references }];
        })
      )
    );
  }
}

class CollectedMakeTargets {
  readonly #checker: ts.TypeChecker;
  readonly #makeTargets: Map<
    string,
    {
      type: ts.Type;
      references: ts.Expression[];
    }
  >;
  readonly #referenceTypes: Map<ts.Expression, [string, ts.Type][]>;
  readonly #typeIds: Map<ts.Type, string>;
  readonly #containerMethodsAndSignatures: Map<
    ContainerMethodName,
    {
      declaration: ts.SignatureDeclarationBase;
      references: Set<ts.Expression>;
    }
  >;

  constructor(
    checker: ts.TypeChecker,
    makeTargets: Map<
      string,
      {
        type: ts.Type;
        references: ts.Expression[];
      }
    >,
    containerMethodsAndSignatures: Map<
      ContainerMethodName,
      {
        declaration: ts.SignatureDeclarationBase;
        references: Set<ts.Expression>;
      }
    >
  ) {
    this.#checker = checker;
    this.#makeTargets = makeTargets;
    const rt = new Map();
    for (const [id, { type, references }] of makeTargets) {
      for (const reference of references) {
        let types = rt.get(reference);
        if (types == null) {
          rt.set(reference, (types = []));
        }
        types.push([id, type]);
      }
    }
    this.#referenceTypes = rt;

    const ti = new Map();
    for (const [id, { type }] of makeTargets) {
      ti.set(type, id);
    }
    this.#typeIds = ti;
    this.#containerMethodsAndSignatures = containerMethodsAndSignatures;
  }

  isReferenceTo(
    methodName: ContainerMethodName,
    node: ts.Node
  ): node is ts.Expression {
    return (
      this.#containerMethodsAndSignatures
        .get(methodName)
        ?.references.has(node as any) ?? false
    );
  }

  targetTypeOfReference(reference: ts.Expression) {
    return this.#referenceTypes.get(reference);
  }

  *classMakeTargets(): IterableIterator<[string, ts.InterfaceType]> {
    for (const [id, { type }] of this.#makeTargets) {
      if (type.isClass()) {
        yield [id, type];
      }
    }
  }

  idOfTypeNode(type: ts.TypeNode) {
    return this.#typeIds.get(this.#checker.getTypeFromTypeNode(type));
  }

  typeOfNodeType(type: ts.TypeNode) {
    return this.#checker.getTypeFromTypeNode(type);
  }

  isMakeTargetClassDeclaration(dec: ts.ClassDeclaration) {
    for (const type of this.#typeIds.keys()) {
      if (type.isClass() && type.symbol.declarations?.includes(dec)) {
        return true;
      }
    }
    return false;
  }
}

export default function transformer(program: ts.Program) {
  const collector = new MakeTargetCollector(program);

  const reporter = (diagnostic: ts.Diagnostic) =>
    console.error(
      ts.formatDiagnosticsWithColorAndContext([diagnostic], {
        getCurrentDirectory: process.cwd,
        getCanonicalFileName: resolve,
        getNewLine: () => "\n",
      })
    );

  function reportCustomError(error: unknown) {
    if (error instanceof InvalidReferenceError) {
      reporter({
        category: ts.DiagnosticCategory.Error,
        code: -1,
        file: error.reference.getSourceFile(),
        start: error.reference.getStart(),
        length: error.reference.getEnd() - error.reference.getStart(),
        messageText: error.message,
      });
    } else if (error instanceof InvalidInvocationError) {
      reporter({
        category: ts.DiagnosticCategory.Error,
        code: -1,
        file: error.call.getSourceFile(),
        start: error.call.getStart(),
        length: error.call.getEnd() - error.call.getStart(),
        messageText: error.message,
      });
    } else if (error instanceof CannotMakeTypeParameterError) {
      reporter({
        category: ts.DiagnosticCategory.Error,
        code: -1,
        file: error.node?.getSourceFile(),
        start: error.node?.getStart(),
        length: error.node && error.node.getEnd() - error.node.getStart(),
        messageText: error.message,
      });
    } else {
      throw error;
    }
    process.exit(1);
  }

  try {
    var makeTargets = collector.collect();
  } catch (e) {
    reportCustomError(e);
    return () => (sf: ts.SourceFile) => sf;
  }

  return (ctx: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      function visitor(node: ts.Node): ts.Node {
        if (
          ts.isCallExpression(node) &&
          makeTargets.isReferenceTo("create", node.expression)
        ) {
          let call = node;
          for (const [id, classTargetType] of makeTargets.classMakeTargets()) {
            call = ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                call as ts.Expression,
                "provide"
              ),
              undefined,
              [
                ts.factory.createStringLiteral(id),
                ts.factory.createArrowFunction(
                  undefined,
                  undefined,
                  [
                    ts.factory.createParameterDeclaration(
                      undefined,
                      undefined,
                      ts.factory.createIdentifier("container")
                    ),
                    ts.factory.createParameterDeclaration(
                      undefined,
                      undefined,
                      ts.factory.createIdentifier("Class")
                    ),
                  ],
                  undefined,
                  undefined,
                  ts.factory.createNewExpression(
                    ts.factory.createIdentifier("Class"),
                    undefined,
                    classTargetType.symbol.declarations
                      ?.find(ts.isClassDeclaration)
                      ?.members.find(ts.isConstructorDeclaration)
                      ?.parameters.map((param, paramIndex) => {
                        const args: ts.Expression[] = [];
                        if (param.type) {
                          args.push(
                            ts.factory.createStringLiteral(
                              makeTargets.idOfTypeNode(param.type)!
                            )
                          );

                          const t = makeTargets.typeOfNodeType(param.type);
                          if (t.isClass()) {
                            args.push(
                              ts.factory.createElementAccessExpression(
                                ts.factory.createCallExpression(
                                  ts.factory.createPropertyAccessExpression(
                                    ts.factory.createIdentifier("Class"),
                                    CONSTRUCTOR_PARAM_TYPES_STATIC_PROP_NAME
                                  ),
                                  undefined,
                                  undefined
                                ),
                                paramIndex
                              )
                            );
                          }
                        }
                        return ts.factory.createCallExpression(
                          ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier("container"),
                            "make"
                          ),
                          undefined,
                          args
                        );
                      }) ?? []
                  )
                ),
              ]
            );
          }
          return call;
        }

        if (
          ts.isCallExpression(node) &&
          makeTargets.isReferenceTo("make", node.expression)
        ) {
          const [[id, type]] = makeTargets.targetTypeOfReference(
            node.expression
          )!;

          const args: ts.Expression[] = [ts.factory.createStringLiteral(id)];

          if (type.isClass()) {
            args.push(ts.factory.createIdentifier(type.symbol.name));
          }

          node = ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            args
          );
        }

        if (
          ts.isCallExpression(node) &&
          makeTargets.isReferenceTo("bind", node.expression)
        ) {
          const [
            [abstractId, abstractType],
            [concreteId, concreteType] = [abstractId, abstractType],
          ] = makeTargets.targetTypeOfReference(node.expression)!;

          const args: ts.Expression[] = [
            node.arguments[0] ?? ts.factory.createIdentifier("undefined"),
            ts.factory.createStringLiteral(abstractId),
            ts.factory.createStringLiteral(concreteId),
          ];

          if (concreteType.isClass()) {
            args.push(ts.factory.createIdentifier(concreteType.symbol.name));
          }

          node = ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            args
          );
        }

        if (
          ts.isCallExpression(node) &&
          makeTargets.isReferenceTo("provide", node.expression)
        ) {
          const [[id]] = makeTargets.targetTypeOfReference(node.expression)!;
          node = ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            [ts.factory.createStringLiteral(id), ...node.arguments]
          );
        }

        if (
          ts.isClassDeclaration(node) &&
          makeTargets.isMakeTargetClassDeclaration(node)
        ) {
          const constructor = node.members.find(ts.isConstructorDeclaration);
          if (constructor) {
            node = ts.factory.updateClassDeclaration(
              node,
              node.modifiers,
              node.name,
              node.typeParameters,
              node.heritageClauses,
              [
                ...node.members,
                ts.factory.createPropertyDeclaration(
                  [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)],
                  CONSTRUCTOR_PARAM_TYPES_STATIC_PROP_NAME,
                  undefined,
                  undefined,
                  ts.factory.createArrowFunction(
                    undefined,
                    undefined,
                    [],
                    undefined,
                    undefined,
                    ts.factory.createArrayLiteralExpression(
                      constructor.parameters
                        .map(
                          (param) =>
                            param.type &&
                            program
                              .getTypeChecker()
                              .getTypeFromTypeNode(param.type)
                        )
                        .map((t) =>
                          t && t.isClass()
                            ? ts.factory.createIdentifier(t.symbol.name)
                            : ts.factory.createIdentifier("undefined")
                        )
                    )
                  )
                ),
              ]
            );
          }
        }

        return ts.visitEachChild(node, visitor, ctx);
      }
      try {
        return ts.visitEachChild(sourceFile, visitor, ctx);
      } catch (e) {
        reportCustomError(e);
        return sourceFile;
      }
    };
  };
}
