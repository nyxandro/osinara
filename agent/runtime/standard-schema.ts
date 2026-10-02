/**
 * Standard Schema and Standard JSON Schema interfaces, the contract zod schemas implement.
 *
 * Exports:
 * - `StandardSchemaV1`: a validating schema with inferable input and output types.
 * - `StandardJSONSchemaV1`: a schema that can describe itself as JSON Schema.
 * - `InferStandardOutput`: the validated value type of a schema.
 *
 * Copied from `@standard-schema/spec` 1.1.0 (MIT, https://standardschema.dev), whose authors
 * ask libraries to copy the interfaces rather than depend on the package. Changes: the namespaces
 * are flattened into named types.
 */
export interface StandardTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: StandardTypes<Input, Output> | undefined;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> | undefined } | undefined,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  };
}

export interface StandardJSONSchemaOptions {
  readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: StandardTypes<Input, Output> | undefined;
    readonly jsonSchema: {
      readonly input: (options: StandardJSONSchemaOptions) => Record<string, unknown>;
      readonly output: (options: StandardJSONSchemaOptions) => Record<string, unknown>;
    };
  };
}

export type InferStandardOutput<Schema extends { readonly "~standard": { readonly types?: unknown } }> =
  NonNullable<Schema["~standard"]["types"]> extends { readonly output: infer Output } ? Output : unknown;
