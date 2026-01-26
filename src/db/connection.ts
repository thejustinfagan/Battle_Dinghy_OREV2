import initSqlJs, { Database, BindParams } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database | null = null;
let dbPath: string | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;

/**
 * Initialize database connection.
 */
export async function initDatabase(path?: string): Promise<Database> {
  if (db) {
    return db;
  }

  // Initialize sql.js
  SQL = await initSqlJs();

  dbPath = path || config.database.path;

  // Create directory if needed
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Load existing database or create new one
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Run schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.run(schema);

  // Save initial state
  saveDatabase();

  return db;
}

/**
 * Get existing database connection.
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Save database to disk.
 */
export function saveDatabase(): void {
  if (!db || !dbPath) {
    return;
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

/**
 * Close database connection.
 */
export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    dbPath = null;
  }
}

/**
 * Create an in-memory database for testing.
 */
export async function createTestDatabase(): Promise<Database> {
  if (!SQL) {
    SQL = await initSqlJs();
  }

  const testDb = new SQL.Database();

  testDb.run('PRAGMA foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  testDb.run(schema);

  return testDb;
}

/**
 * Execute a query and return results.
 */
export function query<T>(sql: string, params: BindParams = []): T[] {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  stmt.bind(params);

  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();

  return results;
}

/**
 * Execute a statement that doesn't return results.
 */
export function run(sql: string, params: BindParams = []): void {
  const database = getDatabase();
  database.run(sql, params);
  saveDatabase();
}

/**
 * Get a single row.
 */
export function getOne<T>(sql: string, params: BindParams = []): T | undefined {
  const results = query<T>(sql, params);
  return results[0];
}

/**
 * Transaction helper for atomic operations.
 */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  database.run('BEGIN TRANSACTION');
  try {
    const result = fn();
    database.run('COMMIT');
    saveDatabase();
    return result;
  } catch (e) {
    database.run('ROLLBACK');
    throw e;
  }
}
