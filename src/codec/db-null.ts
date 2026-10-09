/**
 * Stands for the framework's `DBNull`, which is distinct from a missing value.
 *
 * In a module of its own so that the DataTable cell codec can use it without importing the envelope
 * codec, which imports the cell codec in turn.
 */
export const DB_NULL = Symbol.for('polhem.dbnull');
