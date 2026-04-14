import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3002'),
  db: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'kuhn',
    user: process.env.PGUSER || 'kuhn',
    password: process.env.PGPASSWORD || 'kuhn_dev',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};
