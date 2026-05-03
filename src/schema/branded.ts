import { Brand, Either } from "effect"
import * as path from "node:path"
import { BrandValidationError } from "./errors.ts"

// AbsolutePath
export type AbsolutePath = string & Brand.Brand<"AbsolutePath">
const AbsolutePathBrand = Brand.nominal<AbsolutePath>()

export const makeAbsolutePath = (
  input: string,
): Either.Either<AbsolutePath, BrandValidationError> => {
  if (typeof input !== "string" || input.length === 0) {
    return Either.left(
      new BrandValidationError({
        brand: "AbsolutePath",
        input: String(input),
        reason: "must be a non-empty string",
      }),
    )
  }
  if (!input.startsWith("/")) {
    return Either.left(
      new BrandValidationError({
        brand: "AbsolutePath",
        input,
        reason: "must start with '/'",
      }),
    )
  }
  if (input.split("/").includes("..")) {
    return Either.left(
      new BrandValidationError({
        brand: "AbsolutePath",
        input,
        reason: "must not contain '..' segments",
      }),
    )
  }
  const normalized = path.posix.normalize(input)
  if (normalized.split("/").includes("..")) {
    return Either.left(
      new BrandValidationError({
        brand: "AbsolutePath",
        input,
        reason: "must not contain '..' segments after normalization",
      }),
    )
  }
  return Either.right(AbsolutePathBrand(normalized))
}

// ShellCommand — built only via builder, never raw
export type ShellCommand = string & Brand.Brand<"ShellCommand">
const ShellCommandBrand = Brand.nominal<ShellCommand>()

const escapePosixSingleQuoted = (s: string): string =>
  `'${s.replace(/'/g, "'\\''")}'`

export const makeShellCommand = (
  cmd: string,
  args: ReadonlyArray<string>,
): Either.Either<ShellCommand, BrandValidationError> => {
  if (typeof cmd !== "string" || cmd.length === 0) {
    return Either.left(
      new BrandValidationError({
        brand: "ShellCommand",
        input: String(cmd),
        reason: "cmd must be a non-empty string",
      }),
    )
  }
  if (/[\s\0]/.test(cmd)) {
    return Either.left(
      new BrandValidationError({
        brand: "ShellCommand",
        input: cmd,
        reason: "cmd must be a bare program name with no whitespace",
      }),
    )
  }
  for (const a of args) {
    if (typeof a !== "string") {
      return Either.left(
        new BrandValidationError({
          brand: "ShellCommand",
          input: String(a),
          reason: "all args must be strings",
        }),
      )
    }
  }
  const joined = [cmd, ...args.map(escapePosixSingleQuoted)].join(" ")
  return Either.right(ShellCommandBrand(joined))
}

// RedactedString — never reveals contents
const REDACTED_TAG = Symbol.for("claude-hooks-ts/RedactedString")

export class RedactedString {
  readonly [REDACTED_TAG]: true = true
  readonly #value: string
  constructor(value: string) {
    this.#value = value
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return "[REDACTED]"
  }
  toJSON(): string {
    return "[REDACTED]"
  }
}

export const makeRedactedString = (
  input: string,
): Either.Either<RedactedString, BrandValidationError> => {
  if (typeof input !== "string") {
    return Either.left(
      new BrandValidationError({
        brand: "RedactedString",
        input: String(input),
        reason: "must be a string",
      }),
    )
  }
  return Either.right(new RedactedString(input))
}
