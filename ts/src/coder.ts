import camelCase from "camelcase";
import { Layout } from "buffer-layout";
import { sha256 } from "crypto-hash";
import * as borsh from "@project-serum/borsh";
import {
  Idl,
  IdlField,
  IdlTypeDef,
  IdlEnumVariant,
  IdlType,
  IdlStateMethod,
} from "./idl";
import { IdlError } from "./error";

/**
 * Number of bytes of the account discriminator.
 */
export const ACCOUNT_DISCRIMINATOR_SIZE = 8;

/**
 * Coder provides a facade for encoding and decoding all IDL related objects.
 */
export default class Coder {
  /**
   * Instruction coder.
   */
  readonly instruction: InstructionCoder;

  /**
   * Account coder.
   */
  readonly accounts: AccountsCoder;

  /**
   * Types coder.
   */
  readonly types: TypesCoder;

  /**
   * Coder for state structs.
   */
  readonly state: StateCoder;

  constructor(idl: Idl) {
    this.instruction = new InstructionCoder(idl);
    this.accounts = new AccountsCoder(idl);
    this.types = new TypesCoder(idl);
    if (idl.state) {
      this.state = new StateCoder(idl);
    }
  }
}

/**
 * Encodes and decodes program instructions.
 */
class InstructionCoder<T = any> {
  /**
   * Instruction enum layout.
   */
  private ixLayout: Layout;

  public constructor(idl: Idl) {
    this.ixLayout = InstructionCoder.parseIxLayout(idl);
  }

  public encode(ix: T): Buffer {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const len = this.ixLayout.encode(ix, buffer);
    return buffer.slice(0, len);
  }

  public decode(ix: Buffer): T {
    return this.ixLayout.decode(ix);
  }

  private static parseIxLayout(idl: Idl): Layout {
    let stateMethods = idl.state ? idl.state.methods : [];
    let ixLayouts = stateMethods
      .map((m: IdlStateMethod) => {
        let fieldLayouts = m.args.map((arg: IdlField) =>
          IdlCoder.fieldLayout(arg, idl.types)
        );
        const name = camelCase(m.name);
        return borsh.struct(fieldLayouts, name);
      })
      .concat(
        idl.instructions.map((ix) => {
          let fieldLayouts = ix.args.map((arg: IdlField) =>
            IdlCoder.fieldLayout(arg, idl.types)
          );
          const name = camelCase(ix.name);
          return borsh.struct(fieldLayouts, name);
        })
      );
    return borsh.rustEnum(ixLayouts);
  }
}

/**
 * Encodes and decodes account objects.
 */
class AccountsCoder {
  /**
   * Maps account type identifier to a layout.
   */
  private accountLayouts: Map<string, Layout>;

  public constructor(idl: Idl) {
    if (idl.accounts === undefined) {
      this.accountLayouts = new Map();
      return;
    }
    const layouts: [string, Layout][] = idl.accounts.map((acc) => {
      return [acc.name, IdlCoder.typeDefLayout(acc, idl.types)];
    });

    this.accountLayouts = new Map(layouts);
  }

  public async encode<T = any>(
    accountName: string,
    account: T
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const layout = this.accountLayouts.get(accountName);
    const len = layout.encode(account, buffer);
    let accountData = buffer.slice(0, len);
    let discriminator = await accountDiscriminator(accountName);
    return Buffer.concat([discriminator, accountData]);
  }

  public decode<T = any>(accountName: string, ix: Buffer): T {
    // Chop off the discriminator before decoding.
    const data = ix.slice(8);
    const layout = this.accountLayouts.get(accountName);
    return layout.decode(data);
  }
}

/**
 * Encodes and decodes user defined types.
 */
class TypesCoder {
  /**
   * Maps account type identifier to a layout.
   */
  private layouts: Map<string, Layout>;

  public constructor(idl: Idl) {
    if (idl.types === undefined) {
      this.layouts = new Map();
      return;
    }
    const layouts = idl.types.map((acc) => {
      return [acc.name, IdlCoder.typeDefLayout(acc, idl.types)];
    });

    // @ts-ignore
    this.layouts = new Map(layouts);
  }

  public encode<T = any>(accountName: string, account: T): Buffer {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const layout = this.layouts.get(accountName);
    const len = layout.encode(account, buffer);
    return buffer.slice(0, len);
  }

  public decode<T = any>(accountName: string, ix: Buffer): T {
    const layout = this.layouts.get(accountName);
    return layout.decode(ix);
  }
}

class StateCoder {
  private layout: Layout;

  public constructor(idl: Idl) {
    if (idl.state === undefined) {
      throw new Error("Idl state not defined.");
    }
    this.layout = IdlCoder.typeDefLayout(idl.state.struct, idl.types);
  }

  public async encode<T = any>(name: string, account: T): Promise<Buffer> {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const len = this.layout.encode(account, buffer);

    const disc = await stateDiscriminator(name);
    const accData = buffer.slice(0, len);

    return Buffer.concat([disc, accData]);
  }

  public decode<T = any>(ix: Buffer): T {
    // Chop off discriminator.
    const data = ix.slice(8);
    return this.layout.decode(data);
  }
}

class IdlCoder {
  public static fieldLayout(field: IdlField, types?: IdlTypeDef[]): Layout {
    const fieldName =
      field.name !== undefined ? camelCase(field.name) : undefined;
    switch (field.type) {
      case "bool": {
        return borsh.bool(fieldName);
      }
      case "u8": {
        return borsh.u8(fieldName);
      }
      case "u32": {
        return borsh.u32(fieldName);
      }
      case "u64": {
        return borsh.u64(fieldName);
      }
      case "i64": {
        return borsh.i64(fieldName);
      }
      case "bytes": {
        return borsh.vecU8(fieldName);
      }
      case "string": {
        return borsh.str(fieldName);
      }
      case "publicKey": {
        return borsh.publicKey(fieldName);
      }
      // TODO: all the other types that need to be exported by the borsh package.
      default: {
        // @ts-ignore
        if (field.type.vec) {
          return borsh.vec(
            IdlCoder.fieldLayout(
              {
                name: undefined,
                // @ts-ignore
                type: field.type.vec,
              },
              types
            ),
            fieldName
          );
          // @ts-ignore
        } else if (field.type.option) {
          return borsh.option(
            IdlCoder.fieldLayout(
              {
                name: undefined,
                // @ts-ignore
                type: field.type.option,
              },
              types
            ),
            fieldName
          );
          // @ts-ignore
        } else if (field.type.defined) {
          // User defined type.
          if (types === undefined) {
            throw new IdlError("User defined types not provided");
          }
          // @ts-ignore
          const filtered = types.filter((t) => t.name === field.type.defined);
          if (filtered.length !== 1) {
            throw new IdlError(`Type not found: ${JSON.stringify(field)}`);
          }
          return IdlCoder.typeDefLayout(filtered[0], types, fieldName);
        } else {
          throw new Error(`Not yet implemented: ${field}`);
        }
      }
    }
  }

  public static typeDefLayout(
    typeDef: IdlTypeDef,
    types: IdlTypeDef[],
    name?: string
  ): Layout {
    if (typeDef.type.kind === "struct") {
      const fieldLayouts = typeDef.type.fields.map((field) => {
        const x = IdlCoder.fieldLayout(field, types);
        return x;
      });
      return borsh.struct(fieldLayouts, name);
    } else if (typeDef.type.kind === "enum") {
      let variants = typeDef.type.variants.map((variant: IdlEnumVariant) => {
        const name = camelCase(variant.name);
        if (variant.fields === undefined) {
          return borsh.struct([], name);
        }
        // @ts-ignore
        const fieldLayouts = variant.fields.map((f: IdlField | IdlType) => {
          // @ts-ignore
          if (f.name === undefined) {
            throw new Error("Tuple enum variants not yet implemented.");
          }
          // @ts-ignore
          return IdlCoder.fieldLayout(f, types);
        });
        return borsh.struct(fieldLayouts, name);
      });

      if (name !== undefined) {
        // Buffer-layout lib requires the name to be null (on construction)
        // when used as a field.
        return borsh.rustEnum(variants).replicate(name);
      }

      return borsh.rustEnum(variants, name);
    } else {
      throw new Error(`Unknown type kint: ${typeDef}`);
    }
  }
}

// Calculates unique 8 byte discriminator prepended to all anchor accounts.
export async function accountDiscriminator(name: string): Promise<Buffer> {
  return Buffer.from(
    (
      await sha256(`account:${name}`, {
        outputFormat: "buffer",
      })
    ).slice(0, 8)
  );
}

// Calculates unique 8 byte discriminator prepended to all anchor state accounts.
export async function stateDiscriminator(name: string): Promise<Buffer> {
  return Buffer.from(
    (
      await sha256(`account:${name}`, {
        outputFormat: "buffer",
      })
    ).slice(0, 8)
  );
}

// Returns the size of the type in bytes. For variable length types, just return
// 1. Users should override this value in such cases.
export function typeSize(idl: Idl, ty: IdlType): number {
  switch (ty) {
    case "bool":
      return 1;
    case "u8":
      return 1;
    case "i8":
      return 1;
    case "u16":
      return 2;
    case "u32":
      return 4;
    case "u64":
      return 8;
    case "i64":
      return 8;
    case "bytes":
      return 1;
    case "string":
      return 1;
    case "publicKey":
      return 32;
    default:
      // @ts-ignore
      if (ty.vec !== undefined) {
        return 1;
      }
      // @ts-ignore
      if (ty.option !== undefined) {
        // @ts-ignore
        return 1 + typeSize(ty.option);
      }
      // @ts-ignore
      if (ty.defined !== undefined) {
        // @ts-ignore
        const filtered = idl.types.filter((t) => t.name === ty.defined);
        if (filtered.length !== 1) {
          throw new IdlError(`Type not found: ${JSON.stringify(ty)}`);
        }
        let typeDef = filtered[0];

        return accountSize(idl, typeDef);
      }
      throw new Error(`Invalid type ${JSON.stringify(ty)}`);
  }
}

export function accountSize(
  idl: Idl,
  idlAccount: IdlTypeDef
): number | undefined {
  if (idlAccount.type.kind === "enum") {
    let variantSizes = idlAccount.type.variants.map(
      (variant: IdlEnumVariant) => {
        if (variant.fields === undefined) {
          return 0;
        }
        // @ts-ignore
        return (
          variant.fields
            // @ts-ignore
            .map((f: IdlField | IdlType) => {
              // @ts-ignore
              if (f.name === undefined) {
                throw new Error("Tuple enum variants not yet implemented.");
              }
              // @ts-ignore
              return typeSize(idl, f.type);
            })
            .reduce((a: number, b: number) => a + b)
        );
      }
    );
    return Math.max(...variantSizes) + 1;
  }
  if (idlAccount.type.fields === undefined) {
    return 0;
  }
  return idlAccount.type.fields
    .map((f) => typeSize(idl, f.type))
    .reduce((a, b) => a + b);
}