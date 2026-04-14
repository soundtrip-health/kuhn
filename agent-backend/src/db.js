import pg from 'pg';
import { config } from './config.js';

const pool = new pg.Pool(config.db);

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function checkConnection() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW() AS now');
    return { ok: true, time: result.rows[0].now };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

export { pool };
