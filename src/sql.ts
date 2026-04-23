/**
 * Internal SQL-construction helpers shared across modules that splice
 * identifiers and literals into query strings. User-supplied values
 * always go through parameterized queries; these helpers exist for the
 * cases where values are bound to *structure* (table names, column
 * names, signal-type tags in subqueries) that Postgres parameter
 * binding cannot parameterize.
 *
 * Keep this module tiny. If it grows beyond a handful of helpers,
 * something has drifted.
 */

/**
 * Quote a SQL identifier (table or column name). Defensive — internal
 * call-sites only pass values that have already been validated by a
 * name pattern, but this closes the door on accidental misuse.
 */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Quote a SQL string literal. Used for signal-type tags embedded in
 * correlated subqueries (where PostgREST parameter binding doesn't
 * reach). Values come from developer code, not runtime input, but we
 * escape defensively anyway.
 */
export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
