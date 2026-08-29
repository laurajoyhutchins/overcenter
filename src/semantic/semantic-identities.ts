declare const semanticIdentityBrand: unique symbol;

export type SemanticIdentity<Name extends string> = string & {
  readonly [semanticIdentityBrand]: Name;
};

export type RunId = SemanticIdentity<'RunId'>;
export type LeaseId = SemanticIdentity<'LeaseId'>;
export type WorkRef = SemanticIdentity<'WorkRef'>;
export type GitSha = SemanticIdentity<'GitSha'>;
export type IdempotencyKey = SemanticIdentity<'IdempotencyKey'>;